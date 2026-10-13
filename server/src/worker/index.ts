/**
 * Cloudflare Worker entry: serves the built Svelte client (static assets) and
 * routes each room's WebSocket to its own Durable Object.
 *
 *   GET /api/health                 -> "OK"
 *   GET /api/room/<ROOM> (upgrade)  -> GameRoom Durable Object named <ROOM>
 *   everything else                 -> client/dist (SPA fallback to index.html)
 */
import { normalizeRoomName } from '../../../shared/inputValidation.js';

export { GameRoom } from './GameRoom.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return new Response('OK');
    }

    const match = url.pathname.match(/^\/api\/room\/([^/]+)\/?$/);
    if (match) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      let roomName: string;
      try {
        roomName = normalizeRoomName(decodeURIComponent(match[1]));
      } catch {
        return new Response('Bad room name', { status: 400 });
      }
      if (!roomName) {
        return new Response('Room name required', { status: 400 });
      }
      // Same normalized name => same Durable Object, wherever players connect from
      const stub = env.GAME_ROOM.getByName(roomName);
      const forwarded = new URL(request.url);
      forwarded.searchParams.set('room', roomName);
      return stub.fetch(new Request(forwarded, request));
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
