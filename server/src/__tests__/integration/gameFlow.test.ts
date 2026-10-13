/**
 * End-to-end tests: real Node server on an ephemeral port + headless bot
 * clients speaking the actual wire protocol. These cover the multiplayer
 * failure modes unit tests can't (refreshes, duplicate tabs, stale messages).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type GameServer } from '../../app';
import { BotClient, createLobby, FAST_SETTINGS, sleep } from '../../sim/BotClient';
import { ActionEnum, ActionTarget } from '../../../../shared/actions/index';
import { RoundEnum, Rounds } from '../../../../shared/rounds/index';

let server: GameServer;
let baseUrl: string;
let roomCounter = 0;
const nextRoom = () => `ROOM${++roomCounter}`;
const roundIndex = (type: RoundEnum) => Rounds.findIndex((r) => r.roundType === type) + 1;

beforeAll(async () => {
  ActionTarget.logSends = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = createServer(0);
  const port = await server.ready;
  baseUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  vi.restoreAllMocks();
});

let bots: BotClient[] = [];
beforeEach(() => {
  bots.forEach((b) => b.disconnect());
  bots = [];
});

describe('full game', () => {
  it('plays every round, returns to the lobby, and can play again', async () => {
    const room = nextRoom();
    bots = await createLobby(baseUrl, room, 3);
    const [host, p1] = bots;

    host.send(ActionEnum.START_GAME);
    await Promise.all(bots.map((b) => b.waitForType(ActionEnum.END_GAME, 30_000)));

    // Each bot saw every round exactly once, in order
    for (const b of bots) {
      const rounds = b.received(ActionEnum.START_ROUND).map((m) => m.payload.roundNumber);
      expect(rounds).toEqual(Rounds.map((_, i) => i + 1));
    }

    // Room is unlocked: a newcomer can join after the game…
    const late = new BotClient({ baseUrl, room, name: 'late' });
    bots.push(late);
    await late.connect();
    late.join();
    await late.waitForType(ActionEnum.JOIN_ROOM);

    // …and the host can start a second game
    host.send(ActionEnum.START_GAME);
    await p1.waitFor((m) => m.type === ActionEnum.START_ROUND && m.payload.roundNumber === 1);
  }, 40_000);

  it('ignores a duplicate START_GAME while a game is running', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);
    await sleep(300);
    expect(p1.received(ActionEnum.START_GAME)).toHaveLength(1);
    expect(p1.received(ActionEnum.START_ROUND)).toHaveLength(1);
  });
});

describe('reconnect / refresh', () => {
  it('refresh mid-round resumes the same round with the remaining time', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.SCRIBBLE]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);

    await p1.refresh();
    const join = await p1.waitForType(ActionEnum.JOIN_ROOM, 5000, true);
    expect(join.payload.playerName).toBe('p1');
    const start = await p1.waitFor((m) => m.type === ActionEnum.START_GAME && !!m.payload.currentRound, 5000, true);
    expect(start.payload.currentRound).toBe(1);
    expect(start.payload.roundDone).toBe(false);
    expect(start.payload.timer).toBeGreaterThan(25);
    expect(start.payload.timer).toBeLessThanOrEqual(30);
  });

  it('refresh after submitting does not re-open the round', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.SCRIBBLE]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);
    p1.submitRound();
    await host.waitForType(ActionEnum.PLAYER_DONE);

    await p1.refresh();
    const start = await p1.waitFor((m) => m.type === ActionEnum.START_GAME && !!m.payload.currentRound, 5000, true);
    expect(start.payload.roundDone).toBe(true);
    expect(start.payload.playersDone).toEqual(['p1']);

    // Re-submitting after the refresh must not announce p1 as done twice
    p1.roundDone = false;
    p1.submitRound();
    await sleep(200);
    expect(host.received(ActionEnum.PLAYER_DONE)).toHaveLength(1);
  });

  it('an unload autosave keeps the drawing without marking the player done', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.SCRIBBLE]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);
    const wip = 'data:image/png;base64,V0lQ';
    p1.send(ActionEnum.SEND_DRAWING, { image: wip, roundNumber: 1, autosave: true });
    await p1.refresh();
    const start = await p1.waitFor((m) => m.type === ActionEnum.START_GAME && !!m.payload.currentRound, 5000, true);
    expect(start.payload.roundDone).toBe(false);
    await sleep(100);
    const drawings = p1.received(ActionEnum.SEND_DRAWING);
    expect(drawings[drawings.length - 1].payload.image).toBe(wip);
    expect(host.received(ActionEnum.PLAYER_DONE)).toHaveLength(0);
  });

  it('a player who refreshes keeps playing through to the end of the game', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 3);
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitFor((m) => m.type === ActionEnum.START_ROUND && m.payload.roundNumber === 2);
    await p1.refresh();
    await Promise.all(bots.map((b) => b.waitForType(ActionEnum.END_GAME, 30_000)));
  }, 40_000);

  it('refresh during the intro restores the intro', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, { ...FAST_SETTINGS, skipIntro: false });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.INTRO_START);
    await p1.refresh();
    await p1.waitForType(ActionEnum.JOIN_ROOM, 5000, true);
    await sleep(100);
    expect(p1.received(ActionEnum.INTRO_START)).toHaveLength(2);
  });

  it('tells a client with an unknown session that its game is over', async () => {
    const ghost = new BotClient({ baseUrl, room: nextRoom(), name: 'ghost' });
    bots = [ghost];
    ghost.playerId = 'not-a-real-player';
    await ghost.connect();
    await ghost.waitForType(ActionEnum.SESSION_ENDED, 5000, true);
  });

  it('a duplicated tab replaces the old one without a reconnect fight', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false });
    const [, p1] = bots;
    const twin = new BotClient({ baseUrl, room: p1.opts.room, name: 'p1', autoPlay: false });
    bots.push(twin);
    twin.playerId = p1.playerId;
    await twin.connect();
    await twin.waitForType(ActionEnum.JOIN_ROOM, 5000, true);
    await sleep(100);
    expect(p1.closeCode).toBe(4001);
  });

  it('rejoining by name reclaims a disconnected seat mid-game', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.SCRIBBLE]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);
    p1.disconnect();
    await host.waitFor((m) => m.type === ActionEnum.PLAYER_LIST_CHANGE && m.payload.playerList.length === 1);

    // Same name, brand-new session (e.g. reopened the browser)
    const again = new BotClient({ baseUrl, room: p1.opts.room, name: 'p1', autoPlay: false });
    bots.push(again);
    await again.connect();
    again.join();
    const start = await again.waitFor((m) => m.type === ActionEnum.START_GAME && !!m.payload.currentRound);
    expect(start.payload.currentRound).toBe(1);
    expect(again.playerId).toBe(p1.playerId);
  });
});

describe('round integrity', () => {
  it('ignores round actions stamped with a previous round number', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.SCRIBBLE]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    await p1.waitForType(ActionEnum.START_ROUND);
    // A late END_ROUND/SEND_DRAWING from "round 0" must not count for round 1
    p1.send(ActionEnum.SEND_DRAWING, { image: 'data:,', roundNumber: 0 });
    await sleep(200);
    expect(host.received(ActionEnum.PLAYER_DONE)).toHaveLength(0);
  });

  it('a late reply to END_ROUND cannot skip the next confirmation round', async () => {
    // Name round (drawing) is followed by the End-of-the-World round, which
    // completes on any END_ROUND. Old clients replied to END_ROUND after the
    // next round had already started and skipped it.
    const eotw = roundIndex(RoundEnum.END_OF_THE_WORLD);
    bots = await createLobby(baseUrl, nextRoom(), 2, { autoPlay: false }, {
      ...FAST_SETTINGS,
      roundTimers: { ...FAST_SETTINGS.roundTimers, [RoundEnum.END_OF_THE_WORLD]: 30 },
    });
    const [host, p1] = bots;
    host.send(ActionEnum.START_GAME);
    for (let r = 1; r < eotw; r++) {
      await p1.waitFor((m) => m.type === ActionEnum.START_ROUND && m.payload.roundNumber === r);
      host.submitRound(r);
      p1.submitRound(r);
    }
    await p1.waitFor((m) => m.type === ActionEnum.START_ROUND && m.payload.roundNumber === eotw);
    p1.send(ActionEnum.END_ROUND, { roundNumber: eotw - 1 });
    await sleep(200);
    expect(host.received(ActionEnum.PLAYER_DONE).filter((m) => m.payload.playerName === 'p1')).toHaveLength(eotw - 1);
  });

  it('only the current host can start the game', async () => {
    bots = await createLobby(baseUrl, nextRoom(), 3, { autoPlay: false });
    const [host, p1, p2] = bots;
    host.disconnect();
    await p1.waitForType(ActionEnum.HOST_CHANGE);
    expect(p1.isHost).toBe(true);
    // Old host comes back; they must not keep host powers
    await host.connect();
    await host.waitForType(ActionEnum.HOST_CHANGE, 5000, true);
    host.send(ActionEnum.START_GAME);
    await sleep(200);
    expect(p2.received(ActionEnum.START_ROUND)).toHaveLength(0);
    p1.send(ActionEnum.START_GAME);
    await p2.waitForType(ActionEnum.START_ROUND);
  });

  it('rejects create/join for a different room than the connection URL', async () => {
    const bot = new BotClient({ baseUrl, room: nextRoom(), name: 'x' });
    bots = [bot];
    await bot.connect();
    bot.send(ActionEnum.CREATE_ROOM, { roomName: 'SOMEWHERE ELSE', hostName: 'x' });
    const err = await bot.waitForType(ActionEnum.ROOM_ERROR);
    expect(err.payload.roomInputMessage).toMatch(/wrong room/i);
  });

  it('rejects a blank room or player name', async () => {
    const bot = new BotClient({ baseUrl, room: nextRoom(), name: '   ' });
    bots = [bot];
    await bot.connect();
    bot.create();
    const err = await bot.waitForType(ActionEnum.ROOM_ERROR);
    expect(err.payload.nameInputMessage).toMatch(/empty/i);
  });

  it('answers heartbeats', async () => {
    const bot = new BotClient({ baseUrl, room: nextRoom(), name: 'hb' });
    bots = [bot];
    await bot.connect();
    bot.ping();
    await bot.waitForType(ActionEnum.PONG, 2000);
  });
});
