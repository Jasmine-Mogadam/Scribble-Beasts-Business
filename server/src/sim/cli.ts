/**
 * Live smoke test: plays complete games with headless bots against a running
 * server and exits non-zero on any failure.
 *
 *   npm run sim -- --url ws://localhost:8787            # wrangler dev
 *   npm run sim -- --url ws://localhost:5001            # Node server
 *   npm run sim -- --url wss://scribble-beasts.com --players 4
 *
 * Scenarios: a clean game, a player refreshing mid-game, a duplicate tab,
 * and an unknown session. Rooms are randomly named so runs never collide.
 */
import { ActionEnum, ActionTarget } from '../../../shared/actions/index.js';
import { BotClient, createLobby, sleep } from './BotClient.js';

ActionTarget.logSends = false;

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const baseUrl = arg('url', 'ws://localhost:8787');
const players = Number(arg('players', '3'));
const room = () => `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];

async function scenario(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - start, error: String(err) });
  }
}

async function main() {
  console.log(`Simulating against ${baseUrl} with ${players} players…`);

  await scenario('full game, then back to lobby', async () => {
    const bots = await createLobby(baseUrl, room(), players);
    try {
      bots[0].send(ActionEnum.START_GAME);
      await Promise.all(bots.map((b) => b.waitForType(ActionEnum.END_GAME, 60_000)));
    } finally {
      bots.forEach((b) => b.disconnect());
    }
  });

  await scenario('refresh mid-game keeps the player in the game', async () => {
    const bots = await createLobby(baseUrl, room(), players);
    try {
      bots[0].send(ActionEnum.START_GAME);
      const victim = bots[1];
      await victim.waitFor((m) => m.type === ActionEnum.START_ROUND && m.payload.roundNumber === 2, 30_000);
      await victim.refresh();
      const start = await victim.waitFor((m) => m.type === ActionEnum.START_GAME && !!m.payload.currentRound, 10_000, true);
      if (start.payload.currentRound < 2) throw new Error(`resumed on round ${start.payload.currentRound}`);
      await Promise.all(bots.map((b) => b.waitForType(ActionEnum.END_GAME, 60_000)));
    } finally {
      bots.forEach((b) => b.disconnect());
    }
  });

  await scenario('duplicate tab closes the old tab with 4001', async () => {
    const bots = await createLobby(baseUrl, room(), 2, { autoPlay: false });
    try {
      const [, p1] = bots;
      const twin = new BotClient({ baseUrl, room: p1.opts.room, name: 'p1', autoPlay: false });
      twin.playerId = p1.playerId;
      await twin.connect();
      await twin.waitForType(ActionEnum.JOIN_ROOM, 10_000, true);
      await sleep(300);
      twin.disconnect();
      if (p1.closeCode !== 4001) throw new Error(`old tab close code ${p1.closeCode}`);
    } finally {
      bots.forEach((b) => b.disconnect());
    }
  });

  await scenario('unknown session gets SESSION_ENDED', async () => {
    const ghost = new BotClient({ baseUrl, room: room(), name: 'ghost' });
    ghost.playerId = 'does-not-exist';
    try {
      await ghost.connect();
      await ghost.waitForType(ActionEnum.SESSION_ENDED, 10_000, true);
    } finally {
      ghost.disconnect();
    }
  });

  await scenario('heartbeat is answered', async () => {
    const bot = new BotClient({ baseUrl, room: room(), name: 'hb' });
    try {
      await bot.connect();
      bot.ping();
      await bot.waitForType(ActionEnum.PONG, 5_000);
    } finally {
      bot.disconnect();
    }
  });

  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)${r.error ? `\n      ${r.error}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} scenario(s) failed` : '\nAll scenarios passed');
  process.exit(failed ? 1 : 0);
}

main();
