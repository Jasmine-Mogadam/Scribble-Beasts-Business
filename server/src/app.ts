import express from 'express';
import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  handleNewConnection,
  parseConnectionUrl,
} from './lib/scripts/roomless-handler.js';
import { Room, type RoomContext } from './lib/components/Room.js';
import { fromNodeWebSocket } from './lib/net/nodeSocket.js';

export interface GameServer {
  httpServer: Server;
  wss: WebSocketServer;
  rooms: Record<string, Room>;
  /** Resolves once listening; port is the actual bound port (useful with port 0). */
  ready: Promise<number>;
  close(): Promise<void>;
}

/**
 * Create the Node game server. Uses the same URL contract as the Cloudflare
 * Worker: ws(s)://host/api/room/<ROOM>?playerId=…
 */
export function createServer(
  port: number,
  rooms: Record<string, Room> = Object.create(null),
): GameServer {
  const app = express();
  app.get(['/', '/api/health', '/health'], (_req, res) => {
    res.send('OK');
  });

  const httpServer = app.listen(port, '0.0.0.0');
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', function connection(ws: WebSocket, req) {
    const { roomName, playerId } = parseConnectionUrl(req.url ?? '/');
    const context: RoomContext = { rooms, expectedRoomName: roomName };
    handleNewConnection(fromNodeWebSocket(ws), playerId, context);
  });

  const ready = new Promise<number>((resolve) => {
    httpServer.once('listening', () => {
      const address = httpServer.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

  return {
    httpServer,
    wss,
    rooms,
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        Object.values(rooms).forEach((room) => room.destroy());
        wss.clients.forEach((client) => client.terminate());
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
