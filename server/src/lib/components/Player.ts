import {
  ActionTarget,
  Actions,
} from '../../../../shared/actions/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { Room } from './Room.js';
import { CLOSE_REPLACED, SOCKET_OPEN, type GameSocket } from '../net/GameSocket.js';

// base64 encoded url for a blank pixel
export const BLANK_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

const DISCONNECT_TIMEOUT = 3 * 60 * 1000; // 3 minutes

export class Player extends ActionTarget<GameSocket, { data: any }> {
  id: string;
  name: string;
  #ws: GameSocket;
  #closeCallbacks: (() => void)[] = [];
  #socketCloseListener = () => {
    this.#closeCallbacks.forEach((cb) => cb());
  };
  isHost: boolean = false;
  disconnected: boolean = false;
  disconnectTimeout: ReturnType<typeof setTimeout> | undefined;
  lastUploadedImage: string; // base64encoded url
  score: number;

  constructor(name: string, ws: GameSocket) {
    super(ws);
    this.id = uuidv4();
    this.#ws = ws;
    this.name = name;
    this.lastUploadedImage = BLANK_PIXEL;
    this.score = 0;

    // remove inital roomless listeners
    this.#ws.removeAllListeners('message');
    this.#ws.addEventListener('close', this.#socketCloseListener);
  }

  getWebSocket(): GameSocket {
    return this.#ws;
  }

  /**
   * Register a callback for when this player's *current* socket closes.
   * Unlike a raw socket listener, this survives reconnects.
   */
  onClose(callback: () => void) {
    this.#closeCallbacks.push(callback);
  }

  setWebsocket(ws: GameSocket) {
    this.#ws = ws;
    super.setWebsocket(ws);
    ws.addEventListener('close', this.#socketCloseListener);
  }

  handleDisconnect(callback: () => void) {
    this.disconnected = true;
    if (this.disconnectTimeout) {
      clearTimeout(this.disconnectTimeout);
    }
    this.disconnectTimeout = setTimeout(() => {
      this.disconnectTimeout = undefined;
      if (this.disconnected) {
        callback();
      }
    }, DISCONNECT_TIMEOUT);
  }

  clearDisconnectTimeout() {
    if (this.disconnectTimeout) {
      clearTimeout(this.disconnectTimeout);
      this.disconnectTimeout = undefined;
    }
  }

  reconnect(ws: GameSocket, room: Room) {
    // Detach the old socket so its late close event can't deactivate us, then
    // close it. If it was still open (e.g. a duplicated tab sharing the same
    // sessionStorage), tell that client it was replaced so it stops
    // auto-reconnecting — otherwise two tabs fight over one player forever.
    const oldWs = this.getWebSocket();
    if (oldWs !== ws) {
      const wasOpen = oldWs.readyState === SOCKET_OPEN;
      oldWs.removeAllListeners();
      if (wasOpen) {
        oldWs.close(CLOSE_REPLACED, 'Connected from another tab');
      } else {
        oldWs.close();
      }
    }

    this.clearDisconnectTimeout();
    this.disconnected = false;
    // The new socket may still carry the roomless handler
    ws.removeAllListeners('message');
    this.setWebsocket(ws);
    room.ensureConnectedHost();

    console.log(`[Player] ${this.name} reconnect: sending JoinRoom, game=${!!room.game}`);

    // Always restore identity so client stores (playerName, roomName) are set
    this.sendAction(new Actions.JoinRoom(room.name, this.name, room.host.name));
    this.sendAction(new Actions.RoomSettingsChange(room.settings));

    room.game?.sendReconnectState(this);

    room.playerListChanged();
    this.sendAction(new Actions.HostChange(room.host.name));
  }

  setScore(newScore: number) {
    this.score = newScore;
    console.log(`Player ${this.name} score set to ${this.score}`);
  }

  destroy() {
    this.clearDisconnectTimeout();
    super.destroy();
  }
}

export class Host extends Player {
  isHost: boolean = true;
}
