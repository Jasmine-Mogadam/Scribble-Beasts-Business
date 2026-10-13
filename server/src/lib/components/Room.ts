import { Actions, ActionEnum, type UpdateRoomSettingsAction } from '../../../../shared/actions/index.js';
import {
  DEFAULT_ROOM_SETTINGS,
  normalizeRoomSettings,
  type RoomSettings,
} from '../../../../shared/settings/index.js';
import { Player, Host } from './Player.js';
import { Game } from './Game.js';
import { handleRoomless } from '../scripts/roomless-handler.js';
import { setHostRoomSettings } from './HostRoomSettings.js';

/**
 * Where rooms live. The Node server uses one process-wide registry; every
 * Durable Object gets its own (DO instances can share an isolate, and socket
 * I/O must never cross between them).
 */
export interface RoomContext {
  rooms: Record<string, Room>;
  /** When set (Durable Objects, room-scoped URLs) this connection may only create/join this room. */
  expectedRoomName?: string;
}

export const Rooms: Record<string, Room> = Object.create(null);
export const defaultRoomContext: RoomContext = { rooms: Rooms };

export class Room {
  name: string;
  host: Host;
  players: Record<string, Player> = Object.create(null);
  game: Game | null = null;
  settings: RoomSettings = { ...DEFAULT_ROOM_SETTINGS, roundTimers: {} };
  readonly context: RoomContext;
  #removeHostListeners: (() => void)[] = [];
  #destroyed = false;

  constructor(
    name: string,
    host: Player,
    initialSettings?: RoomSettings,
    context: RoomContext = defaultRoomContext,
  ) {
    this.name = name;
    this.host = host;
    this.context = context;
    host.isHost = true;
    if (initialSettings) {
      this.settings = { ...initialSettings, roundTimers: { ...initialSettings.roundTimers } };
    }
    this.addPlayer(host);
    this.hostSetup();
  }

  /** Attach host-only listeners to the current host, removing them from any previous host. */
  hostSetup() {
    this.#removeHostListeners.forEach((remove) => remove());
    const host = this.host;
    this.#removeHostListeners = [
      host.addActionListener(ActionEnum.START_GAME, () => {
        if (host === this.host) this.startGame();
      }),
      host.addActionListener<UpdateRoomSettingsAction>(
        ActionEnum.UPDATE_ROOM_SETTINGS,
        (action) => {
          if (host === this.host) this.updateSettings(action);
        },
      ),
    ];
  }

  /** Ensures room.host always points to a currently connected player when one exists. */
  ensureConnectedHost(): void {
    if (!this.host.disconnected && this.players[this.host.name] === this.host) return;

    const connectedPlayers = this.getConnectedPlayers();
    if (connectedPlayers.length === 0) return;

    const oldHostName = this.host.name;
    const playerToBecomeHost = connectedPlayers[0];
    this.host.isHost = false;
    playerToBecomeHost.isHost = true;
    this.host = playerToBecomeHost as Host;
    console.log(
      `Host ${oldHostName} unavailable in room ${this.name}. New host is ${this.host.name}`,
    );
    this.hostSetup();
    this.sendActionToAll(new Actions.HostChange(this.host.name));
  }

  updateSettings(action: UpdateRoomSettingsAction): void {
    // Never trust client-provided shapes: normalize before storing/broadcasting.
    this.settings = normalizeRoomSettings(action.payload?.settings);
    setHostRoomSettings(this.host.name, this.settings);
    console.log(`Room ${this.name} settings updated:`, this.settings);
    this.sendActionToAll(new Actions.RoomSettingsChange(this.settings));
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.game?.abort();
    this.game = null;
    Object.values(this.players).forEach((player) => player.destroy());
    this.players = Object.create(null);
    if (this.context.rooms[this.name] === this) {
      delete this.context.rooms[this.name];
    }
  }

  addPlayer(player: Player): void {
    this.players[player.name] = player;
    player.onClose(() => {
      // Ignore close events from players that already left/were replaced
      if (this.players[player.name] === player) {
        this.deactivatePlayer(player.name);
      }
    });
    player.addActionListener(ActionEnum.LEAVE_ROOM, () => {
      this.removePlayer(player.name);
    });
    // Send current settings to the newly joined player
    player.sendAction(new Actions.RoomSettingsChange(this.settings));
    this.playerListChanged();
  }

  /** Called when a player's WebSocket closes unexpectedly (tab closed, network drop).
   * Marks them inactive and starts a 3-minute timeout before permanent removal.
   * The player can still reconnect within the timeout and resume their game slot.
   */
  deactivatePlayer(playerName: string): void {
    const player = this.players[playerName];
    if (player) {
      console.log(`Player ${playerName} disconnected from room ${this.name}.`);

      player.handleDisconnect(() => {
        console.log(
          `Player ${playerName} was removed from room ${this.name} because they were disconnected for too long.`,
        );
        this.removePlayer(playerName);
      });

      this.playerListChanged();
    }
  }

  /** Forcefully and permanently removes a player from the room.
   * Resolves their pending game round slot immediately, removes them from the room,
   * and destroys the room if it becomes empty.
   * - Voluntary leave (LEAVE_ROOM): WS stays alive, put back in roomless state.
   * - Timeout after disconnect: WS is already dead, destroy it.
   */
  removePlayer(playerName: string): void {
    const playerToRemove = this.players[playerName];
    if (playerToRemove) {
      if (playerToRemove.isHost) {
        setHostRoomSettings(playerToRemove.name, this.settings);
      }
      delete this.players[playerName];
      if (this.game) {
        this.game.forceCompletePlayer(playerToRemove.id);
      }
      if (playerToRemove.disconnected) {
        // WS already dead — destroy cleanly
        playerToRemove.destroy();
      } else {
        // Voluntary leave — WS is alive, return it to roomless state
        console.log(`Player ${playerName} left room ${this.name}.`);
        playerToRemove.clearDisconnectTimeout();
        const ws = playerToRemove.getWebSocket();
        ws.removeAllListeners();
        handleRoomless(ws, this.context);
      }
      this.ensureConnectedHost();
      this.playerListChanged();
    }
    if (Object.keys(this.players).length === 0) {
      console.log(`All players left room ${this.name}, it will be destroyed.`);
      this.destroy();
    }
  }

  hasPlayer(playerName: string): boolean {
    return !!this.players[playerName];
  }

  playerListChanged() {
    this.ensureConnectedHost();
    this.sendActionToAll(
      new Actions.PlayerListChange(
        this.getConnectedPlayers().map((p) => p.name),
      ),
    );
  }

  sendActionToPlayer(action: any, player: Player): void {
    if (this.hasPlayer(player.name)) {
      player.sendAction(action);
    }
  }

  sendActionToAll(action: any): void {
    const connected = this.getConnectedPlayers();
    console.log(`[Room] sendActionToAll ${action.type} to [${connected.map((p: Player) => p.name).join(', ')}]`);
    connected.forEach((player) => {
      player.sendAction(action);
    });
  }

  startGame(): void {
    if (this.game) {
      console.log(`Game already running in room ${this.name}; ignoring START_GAME.`);
      return;
    }
    if (this.getConnectedPlayers().length < 2) {
      console.log('Not enough players to start game.');
      return;
    }
    this.getConnectedPlayers().forEach((p) => (p.score = 0));
    this.sendActionToAll(new Actions.StartGame());
    const game = new Game(
      this.getConnectedPlayers(),
      this.sendActionToAll.bind(this),
      () => this.returnToLobby(game),
      this.settings,
    );
    this.game = game;
    this.game.startGame();
  }

  /** Called by Game when it finishes. Unlocks the room so a new game can be started / joined. */
  returnToLobby(game: Game): void {
    if (this.game !== game) return;
    this.game = null;
    console.log(`Game in room ${this.name} ended; returning to lobby.`);
    this.sendActionToAll(new Actions.EndGame());
    this.playerListChanged();
  }

  getConnectedPlayers(): Player[] {
    return Object.values(this.players).filter((p) => !p.disconnected);
  }

  findPlayerById(playerId: string): Player | undefined {
    return Object.values(this.players).find((p) => p.id === playerId);
  }

  findPlayerByName(playerName: string): Player | undefined {
    return this.players[playerName];
  }
}
