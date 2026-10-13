---
name: verify-multiplayer
description: How to verify a change to Scribble Beasts' game flow, rounds, reconnection, protocol (shared/actions), or the Cloudflare Worker/Durable Object. Use before committing any change under server/, shared/, client/src/lib/{ClientWebsocket,GameState}.ts, client/src/lib/stores/roundStore.ts, or a round component.
---

# Verifying multiplayer changes

Multiplayer bugs (wrong round after refresh, stuck "wait for everyone" screen,
dropped players) almost never show up in single-component tests. Use the
layers below, cheapest first. Stop at the first layer that fails.

## 1. Fast loop — always (≈10s)

```bash
npm run verify          # tsc (Node + Worker) + client vitest + server vitest
```

`server/src/__tests__/integration/gameFlow.test.ts` boots a real Node server
on a random port and drives it with `BotClient`s over real WebSockets. **Add a
test there for every multiplayer bug you fix**: reproduce it with bots first,
watch it fail, then fix. Useful pieces:

- `createLobby(baseUrl, room, n, { autoPlay: false }, settings)` — host + n-1 joined bots
- `FAST_SETTINGS` — 2s round timers, no intro; override one round's timer when a test needs time
- `bot.refresh()` — page refresh (drops socket, reconnects with saved playerId)
- `bot.submitRound(roundNumber?)` — what the current round expects, stamped with the round number
- `bot.waitFor(pred, ms, includePast)` — pass `includePast: true` for messages that may arrive during `await bot.refresh()`

## 2. Real Durable Object — for server/worker/protocol changes (≈1 min)

```bash
npm run cf:dev                                   # terminal 1 (builds client, workerd on :8787)
npm run sim -- --url ws://127.0.0.1:8787         # terminal 2
```

Runs full games, a mid-game refresh, a duplicate tab, an unknown session and a
heartbeat against the actual Worker + `GameRoom` DO. CI runs this too
(`worker-smoke-test` job).

If you touched lobby persistence (`GameRoom.#persist/#restore`) also run:

```bash
npm run sim:hibernate    # idles ~75s so workerd hibernates the DO, then starts a game
```

and confirm wrangler printed `[GameRoom] restored lobby`.

## 3. Production smoke test — after a deploy only

```bash
npm run sim -- --url wss://scribble-beasts.com --players 3
```

## Invariants to keep (each has a test)

- Round-scoped messages carry `roundNumber` (server 1-indexed). Server ignores
  stale ones; client `endCurrentRound(…, roundNumber)` ignores stale ones.
  Capture the round **before** any `await` in a round component (`myRound`).
- Client sets the round from `START_ROUND.payload.roundNumber`; never increment.
- Reconnect state lives in `Game.sendReconnectState` (+ each round's
  `sendReconnectState`). `JOIN_ROOM.inGame` tells the client not to bounce
  through the lobby.
- Game logic only touches `GameSocket` — never import `ws` or Workers APIs
  outside `server/src/lib/net/nodeSocket.ts` and `server/src/worker/`.
- Anything holding timers must clear them in `cleanup()`/`abort()`; pending
  timers keep the Durable Object awake (billed).
- Never deploy (`cf:deploy`, `deploy`) or change DNS without the user's go-ahead.
