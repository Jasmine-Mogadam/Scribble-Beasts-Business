import type WebSocket from 'ws';
import { PING_MESSAGE, PONG_MESSAGE, SocketAdapter } from './GameSocket.js';

/** Bind a Node `ws` WebSocket to a SocketAdapter. */
export function fromNodeWebSocket(ws: WebSocket): SocketAdapter {
  const socket = new SocketAdapter(ws);

  ws.on('message', (data) => {
    const text = data.toString();
    // Answer heartbeats at the transport layer, mirroring the Durable Object
    // auto-response, so game code never sees them.
    if (text === PING_MESSAGE) {
      ws.send(PONG_MESSAGE);
      return;
    }
    socket.dispatch('message', { data: text });
  });
  ws.on('close', (code, reason) => {
    socket.markClosed();
    socket.dispatch('close', { code, reason: reason.toString() });
  });
  ws.on('error', (err) => {
    console.error('[ws] error:', err);
    socket.dispatch('error', err);
  });

  return socket;
}
