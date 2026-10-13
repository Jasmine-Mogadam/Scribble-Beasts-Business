/**
 * One Durable Object per room. Runs the exact same game logic as the Node
 * server (Room / Player / Game / rounds) behind the GameSocket adapter.
 *
 * Uses the WebSocket Hibernation API so an idle lobby costs nothing:
 *  - While a game runs, round timers keep the object awake (bounded: a game
 *    is ~15 minutes). Hibernation can't happen with pending timers.
 *  - An idle lobby has no timers, so the object hibernates and in-memory state
 *    is dropped. A small lobby snapshot (SQLite) + per-socket attachments let
 *    the constructor rebuild the room when the next message arrives.
 *  - Heartbeat PINGs are answered by the runtime (setWebSocketAutoResponse)
 *    without waking the object or adding billable duration.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  PING_MESSAGE,
  PONG_MESSAGE,
  SocketAdapter,
} from '../lib/net/GameSocket.js';
import { Room, type RoomContext } from '../lib/components/Room.js';
import { Host, Player } from '../lib/components/Player.js';
import { ActionTarget } from '../../../shared/actions/index.js';
import type { RoomSettings } from '../../../shared/settings/index.js';
import {
  handleNewConnection,
  handleRoomless,
} from '../lib/scripts/roomless-handler.js';

interface SocketAttachment {
  playerId?: string;
}

interface LobbySnapshot {
  name: string;
  settings: RoomSettings;
  hostId: string;
  players: { id: string; name: string; score: number }[];
  savedAt: number;
}

/** Don't resurrect a lobby nobody has touched for longer than the disconnect timeout. */
const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000;

ActionTarget.logSends = false;

export class GameRoom extends DurableObject<Env> {
  #context: RoomContext = { rooms: Object.create(null) };
  #sockets = new Map<WebSocket, SocketAdapter>();
  #lastSnapshot: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE),
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
    );
    this.#restore();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const roomName = url.searchParams.get('room') ?? undefined;
    const playerId = url.searchParams.get('playerId') ?? undefined;
    this.#context.expectedRoomName = roomName;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const socket = this.#wrap(server);

    handleNewConnection(socket, playerId, this.#context);
    this.#persist();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const data =
      typeof message === 'string' ? message : new TextDecoder().decode(message);
    this.#adapterFor(ws).dispatch('message', { data });
    this.#persist();
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#closed(ws, { code, reason });
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error('[GameRoom] socket error', error);
    this.#closed(ws, { code: 1006, reason: 'error' });
  }

  #closed(ws: WebSocket, ev: { code: number; reason: string }) {
    const socket = this.#adapterFor(ws);
    socket.markClosed();
    socket.dispatch('close', ev);
    this.#sockets.delete(ws);
    this.#persist();
  }

  #wrap(ws: WebSocket): SocketAdapter {
    const socket = new SocketAdapter(ws);
    this.#sockets.set(ws, socket);
    return socket;
  }

  #adapterFor(ws: WebSocket): SocketAdapter {
    return this.#sockets.get(ws) ?? this.#wrap(ws);
  }

  get #room(): Room | undefined {
    return Object.values(this.#context.rooms)[0];
  }

  /**
   * Save what's needed to rebuild an idle lobby after hibernation. Skipped
   * while a game runs (timers keep us awake) and when nothing changed.
   */
  #persist() {
    const room = this.#room;

    // Tag each socket with its player so it can be re-bound after hibernation
    for (const [ws, socket] of this.#sockets) {
      const player = room
        ? Object.values(room.players).find((p) => p.getWebSocket() === socket)
        : undefined;
      const attachment: SocketAttachment = { playerId: player?.id };
      const prev = ws.deserializeAttachment() as SocketAttachment | null;
      if (prev?.playerId !== attachment.playerId) {
        ws.serializeAttachment(attachment);
      }
    }

    if (room?.game) return;

    const snapshot = room
      ? JSON.stringify({
          name: room.name,
          settings: room.settings,
          hostId: room.host.id,
          players: Object.values(room.players).map((p) => ({
            id: p.id,
            name: p.name,
            score: p.score,
          })),
        })
      : null;
    if (snapshot === this.#lastSnapshot) return;
    this.#lastSnapshot = snapshot;

    if (snapshot) {
      const withTime = JSON.stringify({ ...JSON.parse(snapshot), savedAt: Date.now() });
      this.ctx.storage.sql.exec(
        'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        'lobby',
        withTime,
      );
    } else {
      this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', 'lobby');
    }
  }

  /** Rebuild the lobby + socket bindings after waking from hibernation. */
  #restore() {
    const liveSockets = this.ctx.getWebSockets();
    const row = this.ctx.storage.sql
      .exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'lobby')
      .toArray()[0];
    const snapshot = row ? (JSON.parse(row.v) as LobbySnapshot) : undefined;

    const byPlayerId = new Map<string, SocketAdapter>();
    const roomless: SocketAdapter[] = [];
    for (const ws of liveSockets) {
      const socket = this.#wrap(ws);
      const { playerId } = (ws.deserializeAttachment() as SocketAttachment | null) ?? {};
      if (playerId) byPlayerId.set(playerId, socket);
      else roomless.push(socket);
    }

    const fresh =
      snapshot &&
      (byPlayerId.size > 0 || Date.now() - snapshot.savedAt < SNAPSHOT_MAX_AGE_MS);

    if (snapshot && fresh && snapshot.players.length > 0) {
      this.#context.expectedRoomName = snapshot.name;
      const players: Player[] = [];
      for (const saved of snapshot.players) {
        const live = byPlayerId.get(saved.id);
        byPlayerId.delete(saved.id);
        // A player whose socket is gone gets a dead placeholder socket and is
        // marked disconnected below, so they can still reconnect within the timeout.
        const socket = live ?? new SocketAdapter({ readyState: 3, send() {}, close() {} });
        if (!live) socket.markClosed();
        const player =
          saved.id === snapshot.hostId ? new Host(saved.name, socket) : new Player(saved.name, socket);
        player.id = saved.id;
        player.score = saved.score;
        players.push(player);
      }
      const host = players.find((p) => p.id === snapshot.hostId) ?? players[0];
      const room = new Room(snapshot.name, host, snapshot.settings, this.#context);
      this.#context.rooms[snapshot.name] = room;
      for (const player of players) {
        if (player !== host) room.addPlayer(player);
      }
      for (const player of players) {
        if (player.getWebSocket().readyState !== 1) room.deactivatePlayer(player.name);
      }
      this.#lastSnapshot = null;
      console.log(`[GameRoom] restored lobby ${snapshot.name} with ${players.length} players`);
    } else if (snapshot) {
      this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', 'lobby');
    }

    // Sockets whose player no longer exists, or that never joined, go back to roomless
    for (const socket of [...roomless, ...byPlayerId.values()]) {
      handleRoomless(socket, this.#context);
    }
  }
}
