import {
  expect,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';

/** localStorage key the client reads room settings from (sent on CREATE_ROOM). */
const SETTINGS_KEY = 'scribble-beasts-room-settings';

/** Round titles shown in the game card heading. */
export const ROUND = {
  scribble: 'Scribble',
  line: 'Line',
  color: 'Color',
  detail: 'Detail',
  name: 'Name',
  eotw: "It's the End of the World",
  present: 'Present',
  vote: 'Vote',
  winners: 'Podium',
} as const;

export const DRAW_ROUNDS = [ROUND.scribble, ROUND.line, ROUND.color, ROUND.detail];

export function fastSettings(overrides: Record<string, number> = {}) {
  return {
    allowSelfVote: false,
    skipIntro: true,
    skipTutorials: true,
    soundMode: 'none',
    captions: false,
    roundTimers: {
      SCRIBBLE: 8,
      LINE: 8,
      COLOR: 8,
      DETAIL: 8,
      NAME: 8,
      END_OF_THE_WORLD: 6,
      PRESENT: 4,
      VOTE: 10,
      WINNERS: 6,
      ...overrides,
    },
  };
}

export interface Point {
  x: number;
  y: number;
}

let roomCounter = 0;
export const uniqueRoom = (prefix = 'E2E') =>
  `${prefix}${Date.now().toString(36).toUpperCase()}${++roomCounter}`;

export class Player {
  readonly errors: string[] = [];
  private cdp?: CDPSession;

  private constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly touch: boolean,
  ) {
    // Uncaught exceptions are what leave a player stuck on a dead screen.
    page.on('pageerror', (err) => this.errors.push(`[${name}] ${err.message}`));
  }

  static async create(
    browser: Browser,
    name: string,
    opts: {
      settings?: object;
      contextOptions?: Parameters<Browser['newContext']>[0];
    } = {},
  ): Promise<Player> {
    const context = await browser.newContext(opts.contextOptions);
    const settings = opts.settings ?? fastSettings();
    await context.addInitScript(
      ([key, value]) => {
        // Only seed once so a mid-game reload doesn't reset anything
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      [SETTINGS_KEY, JSON.stringify(settings)] as const,
    );
    const page = await context.newPage();
    const touch = !!(opts.contextOptions as { hasTouch?: boolean } | undefined)?.hasTouch;
    return new Player(name, context, page, touch);
  }

  async goto() {
    await this.page.goto('/');
    await expect(this.page.locator('#roomName')).toBeVisible();
  }

  async createRoom(room: string) {
    await this.goto();
    await this.page.fill('#roomName', room);
    await this.page.fill('#playerName', this.name);
    await this.page.click('#createRoom');
    await expect(this.page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  }

  async joinRoom(room: string) {
    await this.goto();
    await this.page.fill('#roomName', room);
    await this.page.fill('#playerName', this.name);
    await this.page.click('#joinRoom');
    await expect(this.page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  }

  /** Join a room whose game is already running (reclaiming a disconnected seat by name). */
  async joinRoomMidGame(room: string) {
    await this.goto();
    await this.page.fill('#roomName', room);
    await this.page.fill('#playerName', this.name);
    await this.page.click('#joinRoom');
  }

  async startGame() {
    await this.page.getByRole('button', { name: 'Start Game' }).click();
  }

  get roundHeading(): Locator {
    return this.page.locator('.game-card h1');
  }

  async waitForRound(title: string, timeout = 30_000) {
    await expect(this.roundHeading).toHaveText(title, { timeout });
  }

  get canvas(): Locator {
    return this.page.locator('canvas.drawing-canvas');
  }

  /** Draw one stroke through points given in canvas fractions (0..1). */
  async stroke(points: Point[], { delayMs = 4 } = {}) {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error(`[${this.name}] no drawing canvas on screen`);
    const abs = points.map((p) => ({
      x: box.x + p.x * box.width,
      y: box.y + p.y * box.height,
    }));
    if (this.touch) return this.touchStroke(abs, delayMs);

    const { mouse } = this.page;
    await mouse.move(abs[0].x, abs[0].y);
    await mouse.down();
    for (const p of abs.slice(1)) {
      await mouse.move(p.x, p.y);
      if (delayMs) await this.page.waitForTimeout(delayMs);
    }
    await mouse.up();
  }

  /** Real touch events (what a phone sends), via the DevTools protocol. */
  private async touchStroke(abs: Point[], delayMs: number) {
    this.cdp ??= await this.context.newCDPSession(this.page);
    const send = (type: string, pts: Point[]) =>
      this.cdp!.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    await send('touchStart', [abs[0]]);
    for (const p of abs.slice(1)) {
      await send('touchMove', [p]);
      if (delayMs) await this.page.waitForTimeout(delayMs);
    }
    await send('touchEnd', []);
  }

  async draw(strokes: Point[][]) {
    for (const s of strokes) await this.stroke(s);
  }

  /** Click "Done" once the anti-spam delay has passed. */
  async clickDone() {
    const done = this.page.locator('button.done-button');
    await expect(done).toBeEnabled({ timeout: 15_000 });
    await done.click();
  }

  /**
   * Centre of mass (x,y in 0..1) and amount of ink on the layer showing the
   * *previous* drawer's work, or null when it's blank. Used to prove a player
   * received someone else's drawing as the starting point.
   */
  async overlayInk(): Promise<{ x: number; y: number; ink: number } | null> {
    return this.page.evaluate(() => {
      const canvas = (document.querySelector('canvas.overlay-canvas') ??
        document.querySelector('canvas.background-canvas')) as HTMLCanvasElement | null;
      if (!canvas) return null;
      const { width, height } = canvas;
      const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
      let ink = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const a = data[(y * width + x) * 4 + 3];
          if (a > 0) {
            ink += a;
            sx += x * a;
            sy += y * a;
          }
        }
      }
      return ink === 0 ? null : { x: sx / ink / width, y: sy / ink / height, ink };
    });
  }

  async close() {
    await this.context.close();
  }
}

/** A loopy scribble confined to a vertical band, so each player's is identifiable. */
export function scribbleInBand(centerX: number, loops = 6): Point[][] {
  const pts: Point[] = [];
  for (let i = 0; i <= loops * 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    pts.push({
      x: centerX + 0.07 * Math.cos(t * 1.0) + 0.02 * Math.sin(t * 3),
      y: 0.2 + (0.6 * i) / (loops * 24) + 0.08 * Math.sin(t),
    });
  }
  return [pts];
}

export function line(a: Point, b: Point, steps = 12): Point[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / steps,
    y: a.y + ((b.y - a.y) * i) / steps,
  }));
}

export function assertNoPageErrors(players: Player[]) {
  const all = players.flatMap((p) => p.errors);
  expect(all, `uncaught page errors:\n${all.join('\n')}`).toEqual([]);
}
