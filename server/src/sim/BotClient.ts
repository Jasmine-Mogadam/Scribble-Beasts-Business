/**
 * Headless game client for integration tests and live smoke tests.
 *
 * Speaks the real wire protocol against any server that implements the
 * room-scoped URL contract (`/api/room/<ROOM>?playerId=…`): the local Node
 * server, `wrangler dev`, or production. See sim/cli.ts for the CLI.
 */
import WebSocket from 'ws';
import { ActionEnum } from '../../../shared/actions/index.js';
import { RoundEnum, Rounds } from '../../../shared/rounds/index.js';

const PING = '{"type":"PING","payload":{}}';
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface Msg {
  type: string;
  payload: any;
}

export interface BotOptions {
  /** Base URL, e.g. ws://localhost:5001 or wss://scribble-beasts.com */
  baseUrl: string;
  room: string;
  name: string;
  /** Respond to rounds automatically, like an eager player. Default true. */
  autoPlay?: boolean;
  /** Delay before auto-responding (ms). */
  responseDelayMs?: number;
}

export class BotClient {
  opts: Required<BotOptions>;
  ws: WebSocket | undefined;
  playerId: string | undefined;
  messages: Msg[] = [];
  /** 1-indexed server round number this bot believes it is in */
  round = 0;
  roundDone = false;
  presenter: string | undefined;
  isHost = false;
  gameOver = false;
  closeCode: number | undefined;
  #waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(opts: BotOptions) {
    this.opts = { autoPlay: true, responseDelayMs: 0, ...opts };
  }

  get url(): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const q = this.playerId ? `?playerId=${encodeURIComponent(this.playerId)}` : '';
    return `${base}/api/room/${encodeURIComponent(this.opts.room)}${q}`;
  }

  get roundType(): RoundEnum | undefined {
    return Rounds[this.round - 1]?.roundType;
  }

  connect(): Promise<void> {
    this.closeCode = undefined;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('message', (data) => this.#onMessage(data.toString()));
    ws.on('close', (code) => {
      if (this.ws === ws) this.closeCode = code;
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
  }

  /** Simulates a page refresh / network drop + reconnect with the saved playerId. */
  async refresh(gapMs = 50): Promise<void> {
    this.disconnect();
    await sleep(gapMs);
    await this.connect();
  }

  disconnect() {
    const ws = this.ws;
    this.ws = undefined;
    ws?.terminate();
  }

  send(type: string, payload: object = {}) {
    this.ws?.send(JSON.stringify({ type, payload }));
  }

  ping() {
    this.ws?.send(PING);
  }

  create(settings?: object) {
    this.send(ActionEnum.CREATE_ROOM, {
      roomName: this.opts.room,
      hostName: this.opts.name,
      settings,
    });
  }

  join() {
    this.send(ActionEnum.JOIN_ROOM, {
      roomName: this.opts.room,
      playerName: this.opts.name,
    });
  }

  /** Resolve with the first future (or already received, if `includePast`) message matching. */
  waitFor(
    pred: (m: Msg) => boolean,
    timeoutMs = 10_000,
    includePast = false,
  ): Promise<Msg> {
    if (includePast) {
      const found = this.messages.find(pred);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve: (m: Msg) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`[${this.opts.name}] timed out waiting (${timeoutMs}ms). Last messages: ${this.messages.slice(-5).map((m) => m.type).join(', ')}`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  waitForType(type: string, timeoutMs?: number, includePast = false) {
    return this.waitFor((m) => m.type === type, timeoutMs, includePast);
  }

  received(type: string): Msg[] {
    return this.messages.filter((m) => m.type === type);
  }

  /** Submit whatever the current round expects, stamped with the round number. */
  submitRound(roundNumber = this.round) {
    if (this.roundDone && roundNumber === this.round) return;
    const type = Rounds[roundNumber - 1]?.roundType;
    if (roundNumber === this.round) this.roundDone = true;
    switch (type) {
      case RoundEnum.SCRIBBLE:
      case RoundEnum.LINE:
      case RoundEnum.COLOR:
      case RoundEnum.DETAIL:
      case RoundEnum.NAME:
        this.send(ActionEnum.SEND_DRAWING, { image: TINY_PNG, roundNumber });
        break;
      case RoundEnum.VOTE:
        this.send(ActionEnum.SEND_VOTE, { first: '', second: '', third: '', roundNumber });
        break;
      case RoundEnum.PRESENT:
        if (this.presenter === this.opts.name) {
          this.send(ActionEnum.PRESENTER_END, { roundNumber });
        }
        break;
      case RoundEnum.WINNERS:
        if (this.isHost) this.send(ActionEnum.END_ROUND, { roundNumber });
        break;
      default:
        this.send(ActionEnum.END_ROUND, { roundNumber });
    }
  }

  #onMessage(raw: string) {
    let msg: Msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.messages.push(msg);
    this.#track(msg);
    for (const w of [...this.#waiters]) {
      if (w.pred(msg)) {
        this.#waiters = this.#waiters.filter((x) => x !== w);
        w.resolve(msg);
      }
    }
  }

  #track(msg: Msg) {
    const p = msg.payload ?? {};
    switch (msg.type) {
      case ActionEnum.RECONNECT:
        this.playerId = p.playerId;
        break;
      case ActionEnum.CREATE_ROOM:
        this.isHost = true;
        break;
      case ActionEnum.JOIN_ROOM:
        this.isHost = p.hostName === this.opts.name;
        break;
      case ActionEnum.HOST_CHANGE:
        this.isHost = p.newHostName === this.opts.name;
        break;
      case ActionEnum.START_GAME:
        this.gameOver = false;
        if (p.currentRound) {
          this.round = p.currentRound;
          this.roundDone = !!p.roundDone;
          if (!this.roundDone) this.#autoRespond();
        } else {
          this.round = 0;
          this.roundDone = false;
        }
        break;
      case ActionEnum.INTRO_START:
        if (this.opts.autoPlay && this.isHost) this.send(ActionEnum.INTRO_END);
        break;
      case ActionEnum.START_ROUND:
        this.round = p.roundNumber ?? this.round + 1;
        this.roundDone = false;
        this.presenter = undefined;
        this.#autoRespond();
        break;
      case ActionEnum.PRESENTER_CHANGE:
        this.presenter = p.newPresenter;
        if (this.roundType === RoundEnum.PRESENT) this.#autoRespond();
        break;
      case ActionEnum.END_ROUND:
        // Like the real client: a server END_ROUND forces a submit
        if (this.opts.autoPlay && !this.roundDone && (p.roundNumber ?? this.round) === this.round) {
          this.submitRound();
        }
        break;
      case ActionEnum.END_GAME:
        this.gameOver = true;
        this.round = 0;
        break;
    }
  }

  #autoRespond() {
    if (!this.opts.autoPlay) return;
    const round = this.round;
    const presenter = this.presenter;
    setTimeout(() => {
      if (this.round !== round) return;
      if (this.roundType === RoundEnum.PRESENT) {
        if (presenter === this.opts.name && this.presenter === presenter) {
          this.send(ActionEnum.PRESENTER_END, { roundNumber: round });
        }
        return;
      }
      this.submitRound(round);
    }, this.opts.responseDelayMs);
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Short timers so a full simulated game takes seconds. */
export const FAST_SETTINGS = {
  allowSelfVote: false,
  skipIntro: true,
  skipTutorials: true,
  soundMode: 'none',
  captions: false,
  roundTimers: Object.fromEntries(Rounds.map((r) => [r.roundType, 2])),
};

/** Create a room with a host + N-1 joiners, all connected. */
export async function createLobby(
  baseUrl: string,
  room: string,
  playerCount: number,
  botOpts: Partial<BotOptions> = {},
  settings: object = FAST_SETTINGS,
): Promise<BotClient[]> {
  const host = new BotClient({ baseUrl, room, name: 'host', ...botOpts });
  await host.connect();
  host.create(settings);
  await host.waitForType(ActionEnum.RECONNECT);
  const bots = [host];
  for (let i = 1; i < playerCount; i++) {
    const bot = new BotClient({ baseUrl, room, name: `p${i}`, ...botOpts });
    await bot.connect();
    bot.join();
    await bot.waitForType(ActionEnum.RECONNECT);
    bots.push(bot);
  }
  return bots;
}
