/**
 * Verifies a lobby survives Durable Object hibernation.
 *
 * Creates a lobby, stays idle (heartbeats only — those are auto-answered and
 * don't wake the object) long enough for workerd to hibernate it, then starts a
 * game. Passing means the lobby was rebuilt from its snapshot. Check the
 * wrangler output for "[GameRoom] restored lobby" to confirm hibernation happened.
 *
 *   npm run cf:dev            # in one terminal
 *   npm run sim:hibernate     # in another (≈90s)
 */
import { ActionEnum, ActionTarget } from '../../../shared/actions/index.js';
import { createLobby, sleep } from './BotClient.js';

ActionTarget.logSends = false;

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const baseUrl = arg('url', 'ws://localhost:8787');
const idleSeconds = Number(arg('idle', '75'));

async function main() {
  const room = `HIBER-${Date.now().toString(36).toUpperCase()}`;
  const bots = await createLobby(baseUrl, room, 2);
  console.log(`Lobby ${room} ready; idling ${idleSeconds}s…`);
  const heartbeat = setInterval(() => bots.forEach((b) => b.ping()), 25_000);
  await sleep(idleSeconds * 1000);
  clearInterval(heartbeat);

  bots[0].send(ActionEnum.START_GAME);
  try {
    await Promise.all(
      bots.map((b) => b.waitForType(ActionEnum.END_GAME, 60_000)),
    );
    console.log('PASS  game ran after the idle period');
    process.exit(0);
  } catch (err) {
    console.log(`FAIL  ${err}`);
    process.exit(1);
  } finally {
    bots.forEach((b) => b.disconnect());
  }
}

main();
