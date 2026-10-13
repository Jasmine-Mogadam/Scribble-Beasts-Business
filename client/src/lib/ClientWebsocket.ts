import {
  ActionEnum,
  ActionTarget,
  ReconnectAction,
} from '@shared/actions';
import { writable } from 'svelte/store';

/**
 * Room-scoped connection. Each room lives in its own server instance (a
 * Cloudflare Durable Object in production), so the socket URL names the room:
 *   /api/room/<ROOM>?playerId=<saved id>
 *
 * The socket is opened lazily when the player creates/joins a room, and
 * re-opened automatically on refresh from the session saved in sessionStorage
 * (per tab, so several tabs can play as different players).
 */

export type ConnectionStatus =
  | 'idle' // not in a room
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'replaced'; // this player was opened in another tab

export const connectionStatus = writable<ConnectionStatus>('idle');

/** Must match server PING_MESSAGE byte-for-byte (Durable Object auto-response). */
const PING_MESSAGE = '{"type":"PING","payload":{}}';
const HEARTBEAT_INTERVAL_MS = 25_000;
/** No message at all for this long => connection is dead (half-open), reconnect. */
const DEAD_CONNECTION_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const CLOSE_REPLACED = 4001;
const SESSION_KEY = 'scribbleSession';

interface Session {
  roomName: string;
  playerId?: string;
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable (private mode etc.) — reconnect just won't survive refresh
  }
}

/** Placeholder until the first real connection; behaves like a closed socket. */
function closedSocket(): WebSocket {
  return {
    readyState: WebSocket.CLOSED,
    addEventListener() {},
    removeEventListener() {},
    send() {},
    close() {},
  } as unknown as WebSocket;
}

class CWebsocket extends ActionTarget<WebSocket, MessageEvent<string>> {
  #ws: WebSocket;
  #roomName: string | undefined;
  #queue: object[] = [];
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastMessageAt = 0;

  constructor() {
    const ws = closedSocket();
    super(ws);
    this.#ws = ws;

    this.addActionListener(ActionEnum.RECONNECT, (action: ReconnectAction) => {
      if (this.#roomName) {
        saveSession({ roomName: this.#roomName, playerId: action.payload.playerId });
      }
    });

    if (typeof window !== 'undefined') {
      // Phones suspend background tabs; reconnect as soon as we're visible/online.
      window.addEventListener('online', () => this.#reconnectNowIfDown());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.#reconnectNowIfDown();
      });
    }
  }

  get roomName(): string | undefined {
    return this.#roomName;
  }

  /** Resume the tab's saved session after a page refresh. Returns false if there is none. */
  resumeSession(): boolean {
    const session = loadSession();
    if (!session?.roomName || !session.playerId) return false;
    this.connect(session.roomName);
    return true;
  }

  /** Open (or switch to) the socket for a room. No-op if already connected to it. */
  connect(roomName: string) {
    if (
      this.#roomName === roomName &&
      (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (this.#roomName !== roomName) {
      // A saved playerId only means something to the room that issued it
      const session = loadSession();
      saveSession(session?.roomName === roomName ? session : { roomName });
    }
    this.#roomName = roomName;
    this.#reconnectAttempts = 0;
    this.#open('connecting');
  }

  /** Leave the room for good: close without reconnecting and forget the session. */
  disconnect() {
    this.#roomName = undefined;
    this.#queue = [];
    saveSession(null);
    this.#teardown();
    connectionStatus.set('idle');
  }

  /** Forget the saved player (the server said the session is over) but keep the socket. */
  clearSession() {
    if (this.#roomName) saveSession({ roomName: this.#roomName });
  }

  sendAction(action: object): void {
    if (this.#ws.readyState === WebSocket.CONNECTING) {
      this.#queue.push(action);
      return;
    }
    super.sendAction(action);
  }

  #open(status: ConnectionStatus) {
    if (!this.#roomName) return;
    this.#teardown();
    connectionStatus.set(status);
    const ws = new WebSocket(getWebsocketUrl(this.#roomName));
    this.#ws = ws;
    this.setWebsocket(ws);

    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#reconnectAttempts = 0;
      this.#lastMessageAt = Date.now();
      connectionStatus.set('open');
      const queued = this.#queue;
      this.#queue = [];
      queued.forEach((action) => super.sendAction(action));
      this.#startHeartbeat();
    };

    ws.addEventListener('message', () => {
      this.#lastMessageAt = Date.now();
    });

    ws.onerror = (event) => {
      console.error('WebSocket error:', event);
    };

    ws.onclose = (event) => {
      if (this.#ws !== ws) return; // superseded by a newer socket
      this.#stopHeartbeat();
      if (event.code === CLOSE_REPLACED) {
        console.log('This player was opened in another tab; not reconnecting.');
        connectionStatus.set('replaced');
        return;
      }
      if (!this.#roomName) return;
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.#reconnectAttempts++;
    connectionStatus.set('reconnecting');
    console.log(`WebSocket closed. Reconnecting in ${delay}ms...`);
    this.#reconnectTimer = setTimeout(() => this.#open('reconnecting'), delay);
  }

  #reconnectNowIfDown() {
    if (!this.#roomName) return;
    const state = this.#ws.readyState;
    if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
      this.#reconnectAttempts = 0;
      this.#open('reconnecting');
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.#lastMessageAt > DEAD_CONNECTION_MS) {
        // A half-open socket may never fire onclose; replace it directly.
        console.log('No traffic from server; forcing reconnect.');
        this.#open('reconnecting');
        return;
      }
      this.#ws.send(PING_MESSAGE);
    }, HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat() {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #teardown() {
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    const old = this.#ws;
    old.onclose = null;
    old.onopen = null;
    old.onerror = null;
    if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
      old.close();
    }
  }
}

const ClientWebsocket = new CWebsocket();
export default ClientWebsocket;

function getWebsocketUrl(roomName: string): string {
  const serverUrl = import.meta.env.VITE_SERVER_URL;
  // If serverUrl is undefined we use the same origin's /api (nginx locally, the Worker in production)
  const base = (serverUrl || window.location.origin + '/api').replace(/\/$/, '');
  const url = new URL(`${base}/room/${encodeURIComponent(roomName)}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const session = loadSession();
  if (session?.roomName === roomName && session.playerId) {
    url.searchParams.set('playerId', session.playerId);
  }

  return url.toString();
}
