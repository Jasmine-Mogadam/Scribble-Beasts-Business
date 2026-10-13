/**
 * Transport-agnostic socket used by all game logic (Room, Player, Game, rounds).
 *
 * The game code only ever talks to a GameSocket, never to a concrete WebSocket
 * implementation. That lets the exact same logic run on:
 *  - Node (`ws` library) — see nodeSocket.ts
 *  - Cloudflare Durable Objects with the WebSocket Hibernation API — see
 *    worker/GameRoom.ts, where events arrive as DO class methods instead of
 *    socket listeners, so they have to be dispatched manually.
 */

export type SocketListener = (ev: any) => void;

export interface GameSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: SocketListener): void;
  removeEventListener(type: string, listener: SocketListener): void;
  removeAllListeners(type?: string): void;
}

/** Minimal surface of a raw WebSocket we need to wrap (Node `ws` or Workers). */
export interface RawSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 3;

/** Close code sent to a socket that was superseded by a newer connection for the same player (e.g. a duplicated tab). Clients must NOT auto-reconnect on this code. */
export const CLOSE_REPLACED = 4001;

/** Exact heartbeat strings. Kept byte-identical so Durable Objects can answer them with setWebSocketAutoResponse without waking up. */
export const PING_MESSAGE = '{"type":"PING","payload":{}}';
export const PONG_MESSAGE = '{"type":"PONG","payload":{}}';

/**
 * Wraps a raw socket and owns its own listener registry, so listeners can be
 * removed in bulk (`removeAllListeners`) regardless of the underlying runtime.
 * The runtime binding is responsible for calling `dispatch()`.
 */
export class SocketAdapter implements GameSocket {
  readonly raw: RawSocket;
  #listeners = new Map<string, Set<SocketListener>>();
  #closed = false;

  constructor(raw: RawSocket) {
    this.raw = raw;
  }

  get readyState(): number {
    if (this.#closed) return SOCKET_CLOSED;
    return this.raw.readyState;
  }

  send(data: string): void {
    this.raw.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#closed = true;
    try {
      this.raw.close(code, reason);
    } catch {
      // already closed
    }
  }

  addEventListener(type: string, listener: SocketListener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  removeAllListeners(type?: string): void {
    if (type) {
      this.#listeners.delete(type);
    } else {
      this.#listeners.clear();
    }
  }

  /** Mark the socket as closed (the remote end went away) without calling close() on it. */
  markClosed(): void {
    this.#closed = true;
  }

  dispatch(type: string, ev: unknown): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    // copy so listeners may add/remove listeners while being dispatched
    for (const listener of [...set]) {
      try {
        listener.call(this, ev);
      } catch (err) {
        console.error(`[SocketAdapter] ${type} listener threw:`, err);
      }
    }
  }
}
