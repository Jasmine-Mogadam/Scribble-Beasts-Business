# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Setup
```bash
npm run setup          # Install all dependencies (client + server)
```

### Development (requires Docker)
```bash
npm run dev            # Start all services with hot reload via Docker Compose
npm run down           # Stop all services
npm run down:clean     # Stop and remove all containers, images, volumes
```

`/fonttest` is a **dev-only** client route for NameRound font calibration (live font-size inputs + preview). It is only available when running in development (`npm run dev`) and is not exposed in production builds.

### Verifying changes (start here)
```bash
npm run verify         # typecheck (Node + Worker) + all tests — run before every commit
npm run sim -- --url ws://127.0.0.1:8787   # bot games against a running server (see below)
```
For anything touching game flow, rounds, reconnection, `shared/actions`, or the
Worker, follow the `verify-multiplayer` project skill (`.claude/skills/`).

### Testing
```bash
npm test               # Run all tests (client + server)
npm run test:client    # Run client tests only (vitest)
npm run test:server    # Run server tests only (vitest)

# Run a single test file:
cd client && npx vitest run src/__tests__/ScribbleRound.test.ts
cd server && npx vitest run src/__tests__/Room.test.ts
```

### Linting & Formatting
```bash
npm run lint           # Lint .ts and .svelte files
npm run lint:fix       # Auto-fix lint issues
npm run format         # Format all files with Prettier
npm run format:check   # Check formatting without writing
```

### Building
```bash
npm run build          # Build both client and server
```

### Cloudflare (production)
```bash
npm run cf:dev             # build client + run Worker/Durable Objects locally on :8787 (no account needed)
npm run cf:deploy:preview  # deploy to scribble-beasts-preview.<account>.workers.dev
npm run cf:deploy          # deploy to scribble-beasts.com (ask the user first)
npm run cf:types           # regenerate server/src/worker/worker-configuration.d.ts after editing wrangler.jsonc
npm run sim:hibernate      # check an idle lobby survives Durable Object hibernation
```
See `DEPLOY_CLOUDFLARE.md` for setup, DNS cutover and pricing.

### Legacy Docker / Fly.io
```bash
npm run prod           # Run production Docker build
npm run playtest       # Run playtest Docker build (dev + playtest overrides)
npm run deploy         # Fly.io (still the CI default until DEPLOY_TARGET=cloudflare)
```

## Environment

Copy `.env.sample` to `.env` before running. Ports can be changed to resolve conflicts. The app runs at `http://localhost` (nginx port) with the backend at `http://localhost/api`.

## Architecture

This is a **Svelte + WebSocket multiplayer game**. The same game logic runs in
two hosts: a Node server (local dev via Docker + Nginx, legacy Fly.io) and a
Cloudflare Worker with **one Durable Object per room** (production).

### Monorepo Layout
- **`client/`** — Svelte 5 frontend (Vite, Vitest, TypeScript)
- **`server/`** — Node.js backend (Express + `ws` WebSocket library, TypeScript)
- **`shared/`** — Code shared between client and server (actions, round definitions)
- **`nginx/`** — Nginx config routes `/api` to the server and everything else to the client

### Shared Module (`shared/`)
The `shared/` package is the communication contract between client and server. Import it as `@shared/actions` and `@shared/rounds`.

- **`shared/actions/index.ts`** — Defines `ActionEnum`, all `Action` subclasses (e.g. `SendDrawingAction`, `StartRoundAction`), the `ActionTarget` base class (used by both `ClientWebsocket` and `Player`), and `ParseAction`. To add a new action: add to `ActionEnum`, create a class extending `Action<Payload>`, add to `AnyAction` union, and add to the `Actions` object.
- **`shared/rounds/index.ts`** — Defines `RoundEnum` and all `Round` subclasses with their timeouts and metadata. The ordered `Rounds` array is the source of truth for game sequence.

### Server Architecture
- **URL contract (both hosts):** `ws(s)://<host>/api/room/<ROOM>?playerId=<saved id>`. The room is in the URL so the Worker can route to that room's Durable Object; the server rejects CREATE/JOIN for a different room than the URL.
- **`server/src/lib/net/GameSocket.ts`** — Transport-agnostic socket (`SocketAdapter`). All game code uses it; `nodeSocket.ts` binds Node `ws`, `worker/GameRoom.ts` binds Durable Object hibernation events. Never import `ws` or Workers APIs elsewhere.
- **`server/src/app.ts`** — `createServer(port)` (Express + ws). `index.ts` is the Node entry; tests use `createServer(0)`.
- **`server/src/worker/`** — Cloudflare Worker entry (`index.ts`: routes `/api/room/*` to `GameRoom`, everything else to static assets) and the `GameRoom` Durable Object (Hibernation API; persists an idle-lobby snapshot in SQLite + per-socket attachments, rebuilds in the constructor). Typechecked by `server/tsconfig.worker.json`, bundled by wrangler (`wrangler.jsonc` at repo root).
- **`server/src/lib/scripts/roomless-handler.ts`** — Handles sockets not yet in a room: `CREATE_ROOM` / `JOIN_ROOM`, reconnection via `playerId`, `SESSION_ENDED` for unknown sessions, and rejoining a disconnected seat by name. Takes a `RoomContext` (room registry) — one per process on Node, one per Durable Object on Cloudflare.
- **`server/src/lib/components/Room.ts`** — Manages players in a room, host promotion on disconnect (host-only listeners move with the host), delegates `START_GAME` to `Game` (one game at a time), and returns to the lobby (`END_GAME`) when the game ends.
- **`server/src/lib/components/Game.ts`** — Runs the round loop: broadcasts `StartRound(timeout, roundNumber)`, calls `setup()`, waits for all players or timeout (+2s grace), `EndRound(roundNumber)`. Ignores round actions stamped with another round number. Tracks `completedPlayers` and owns `sendReconnectState()`. Timers go through `setTimer` so `abort()` can cancel them.
- **`server/src/lib/components/rounds/ServerRound.ts`** — Abstract base for server-side rounds. Each must implement `expectedActions` and `roundResponseHandler`.
- **`server/src/lib/components/rounds/Rounds.ts`** — `initializeRounds()` builds the ordered list of `ServerRound` instances.

### Client Architecture
- **`client/src/lib/ClientWebsocket.ts`** — Singleton `ActionTarget`. Connects lazily via `connect(roomName)` (RoomForm) or `resumeSession()` (App, after refresh); queues sends while connecting; exponential-backoff reconnect; 25s heartbeat; stops reconnecting on close code 4001 (player opened in another tab). Session `{roomName, playerId}` lives in `sessionStorage` (per tab). Exposes `connectionStatus` store.
- **`client/src/lib/Navigator.ts`** — Svelte store for the current view (`ROOM_FORM` | `LOBBY` | `GAME`).
- **`client/src/lib/GameState.ts`** — Global Svelte stores (`playerName`, `roomName`, `isHost`, `drawingImage`, `notice`, etc.) wired to WebSocket action listeners via `resetState()`. Also owns the global `START_ROUND` / `INTRO_*` / `END_GAME` / `SESSION_ENDED` handlers so round transitions never depend on component mount timing.
- **`client/src/lib/stores/roundStore.ts`** — Tracks current round state (`RoundState`). `startNextRound(timeout, roundNumber)` jumps to the server's round; `jumpToRound(index, timer, done)` for reconnects; `endCurrentRound(action?, roundNumber)` ignores stale rounds and sends `END_ROUND` once per round.
- **`client/src/lib/constants/RoundTypeComponentDict.ts`** — Maps every `RoundEnum` to its Svelte component. When adding a new round, register it here.

### Adding a New Round
1. Add to `RoundEnum` and create a `Round` subclass in `shared/rounds/index.ts`, add it to the `Rounds` array.
2. Create a `ServerXRound` extending `ServerRound` in `server/src/lib/components/rounds/`.
3. Register it in `server/src/lib/components/rounds/Rounds.ts` `initializeRounds()`.
4. Create a Svelte component in `client/src/lib/components/rounds/`.
5. Register it in `client/src/lib/constants/RoundTypeComponentDict.ts`.
6. Server round: implement `sendReconnectState()` if a rejoining player needs round data, and clear any timers in `cleanup()`. Client component: wrap in `Round.svelte` and stamp everything you send with `myRound`.
7. Add a bot-driven case to `server/src/__tests__/integration/gameFlow.test.ts` (and teach `BotClient.submitRound` the new round).

### TypeScript Quirks
The server has **two tsconfig files**: `tsconfig.json` (root `..` for local dev) and `docker.tsconfig.json` (root `.` for Docker, where `shared/` is copied in). Keep them in sync when modifying compiler options.

The Worker has its own `server/tsconfig.worker.json` (Workers runtime types from `server/src/worker/worker-configuration.d.ts`); `server/tsconfig.json` excludes `src/worker`. `npm run typecheck` checks both.

Shared code is imported with `@shared/*` path aliases — configured in both `client/tsconfig.json` and `server/tsconfig.json`.

---

## Connection & Reconnection System

### Round numbers (the core sync rule)
- The server numbers rounds from 1. `START_ROUND`, `END_ROUND` and every client round action (`SEND_DRAWING`, `SEND_VOTE`, `END_ROUND`, `PRESENTER_END`) carry `payload.roundNumber`.
- Round components capture `const myRound = currentServerRound()` at mount and use it for everything they send, because submits are async (canvas encoding / image loads) and the next round can start before they resolve. Before this, a late reply to the previous round's `END_ROUND` could end the *next* round. That skipped End-of-the-World entirely and left clients stuck on "Great job! Wait for everyone else."
- The client sets its round from `START_ROUND.payload.roundNumber` rather than incrementing, so a missed message can't leave it on the wrong round.

### How reconnection works (server)
- Each `Player` has a stable UUID (`player.id`). On socket close, `Room.deactivatePlayer()` marks them disconnected and starts a 3-minute removal timer; the seat is kept.
- On reconnect (`handleNewConnection` with `playerId`), `Player.reconnect(ws, room)` swaps sockets (re-attaching all action listeners and `onClose` callbacks), closes any still-open old socket with **4001** (duplicate tab), then sends `JoinRoom(inGame)` → `RoomSettingsChange` → `Game.sendReconnectState()` (`StartGame{currentRound, timer, roundDone, playersDone}` or `StartGame{}` + `IntroStart` during the intro, last drawing, then the round's own `sendReconnectState`) → `PlayerListChange` → `HostChange`.
- Unknown `playerId` (room gone, timed out, server restarted) → `SESSION_ENDED`, and the socket stays usable for create/join.
- `JOIN_ROOM` with the name of a *disconnected* player reclaims that seat, mid-game included.
- Drawing rounds accept `SEND_DRAWING{autosave: true}` (sent on `beforeunload`): stored as the player's work and resume point, without marking them done.

### How reconnection works (client)
- `JOIN_ROOM` with `inGame: true` does not navigate to the lobby; `START_GAME` follows and `jumpToRound` keeps the round component mounted when it's the same round, so a network blip doesn't wipe the canvas.
- `Lobby.svelte` must NOT add a `START_GAME` listener that sends `StartGame` back to the server.

### ActionTarget listener system
- `addActionListener(type, fn)` returns a remover. **Always use the remover** in component cleanup.
- `removeActionListener(type)` removes **all** listeners of that type (used only by `GameState.resetState` and `RoomForm`). Calling it from a component would also kill other components' listeners.

### Round lifecycle (client)
- `Round.svelte` listens for `END_ROUND` (matching `myRound`) and on its own timer's last tick calls `handleEnd()`: `await onRoundEnd()` (the round's submit) → `endCurrentRound(undefined, myRound)`.
- `DrawingRound.svelte` also submits ~250ms before the timer expires and on `END_ROUND`.
- `Game.svelte` only handles music/intro display. It has no round listeners.

### Durable Object specifics
- Hibernation can't happen while timers are pending, so a running game keeps the object awake (billed duration, bounded by game length). Idle lobbies hibernate. In-memory state is then gone, and `GameRoom` rebuilds the room from the `kv` table snapshot (`lobby`) plus each socket's attachment (`{playerId}`). Mid-game state is not persisted: if Cloudflare restarts the object during a game (e.g. on deploy), players reconnect into the lobby.
- `PING` → `PONG` is answered by `setWebSocketAutoResponse` without waking the object. The client must send the exact string `{"type":"PING","payload":{}}`.
- Static assets are capped at 25 MiB per file. Re-encode media rather than adding larger files.

### Local testing
Multiple players can be tested using separate tabs on the same browser (`sessionStorage` is per tab). Note that **duplicating** a tab copies its session: the new tab takes over the player and the old one shows "opened in another tab". For automated checks use `BotClient` (`server/src/sim/`).
