import { devices, expect, test, type Browser } from '@playwright/test';
import {
  assertNoPageErrors,
  fastSettings,
  line,
  Player,
  ROUND,
  scribbleInBand,
  uniqueRoom,
} from './helpers';

const PHONE = devices['Pixel 7'];

/** Everything a person does in one round, written against the real UI. */
async function playRound(p: Player, title: string, index: number, bands: number[]) {
  await p.waitForRound(title);
  switch (title) {
    case ROUND.scribble:
      await p.draw(scribbleInBand(bands[index]));
      break;

    case ROUND.line: {
      // The starting image must be the NEXT player's scribble (images rotate),
      // not our own: components read it once on mount, so ordering bugs show here.
      const ink = await p.overlayInk();
      expect(ink, `${p.name}: Line round started with a blank canvas`).not.toBeNull();
      const theirs = bands[(index + 1) % bands.length];
      expect(Math.abs(ink!.x - theirs), `${p.name}: wrong starting scribble`).toBeLessThan(0.1);
      await p.stroke(line({ x: theirs - 0.1, y: 0.3 }, { x: theirs + 0.1, y: 0.7 }));
      break;
    }

    case ROUND.color:
      await p.page.locator('.color-picker label').nth(index + 1).click();
      await p.stroke(line({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }));
      if (index === 0) await p.clickDone(); // finish early; the others run out the clock
      break;

    case ROUND.detail:
      await p.stroke(line({ x: 0.4, y: 0.4 }, { x: 0.45, y: 0.45 }, 4));
      break;

    case ROUND.name:
      await p.page.fill('#scribble-beast-name', `Beast ${p.name}`);
      break;

    case ROUND.eotw:
      await expect(p.page.locator('.card-front img')).toHaveAttribute('src', /\/images\/eotw\//);
      await expect(p.page.locator('.description-container p')).not.toBeEmpty();
      break;

    case ROUND.present: {
      const end = p.page.getByRole('button', { name: 'End Presentation' });
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && (await p.roundHeading.textContent()) === ROUND.present) {
        if (await end.isVisible()) await end.click({ timeout: 2000 }).catch(() => {});
        await p.page.waitForTimeout(250);
      }
      break;
    }

    case ROUND.vote: {
      const buttons = p.page.locator('.vote-btn');
      await expect(buttons.first()).toBeVisible();
      for (let i = 0; i < 2; i++) await buttons.nth(i).click();
      await p.page.getByRole('button', { name: 'Finish Voting' }).click();
      break;
    }

    case ROUND.winners:
      await expect(p.page.locator('.podium .winner').first()).toBeVisible();
      break;
  }
}

const ALL_ROUNDS = [
  ROUND.scribble,
  ROUND.line,
  ROUND.color,
  ROUND.detail,
  ROUND.name,
  ROUND.eotw,
  ROUND.present,
  ROUND.vote,
  ROUND.winners,
];

async function playGame(players: Player[], bands: number[]) {
  await Promise.all(
    players.map(async (p, i) => {
      for (const title of ALL_ROUNDS) await playRound(p, title, i, bands);
    }),
  );
}

async function lobby(browser: Browser, names: string[], phoneIndex?: number) {
  const players = await Promise.all(
    names.map((name, i) =>
      Player.create(browser, name, {
        settings: fastSettings(),
        contextOptions: i === phoneIndex ? { ...PHONE } : { viewport: { width: 1100, height: 900 } },
      }),
    ),
  );
  const room = uniqueRoom();
  await players[0].createRoom(room);
  for (const p of players.slice(1)) await p.joinRoom(room);
  return { players, room };
}

test('desktop + phone + desktop play a full game and everyone lands back in the lobby', async ({
  browser,
}) => {
  const { players } = await lobby(browser, ['host', 'phone', 'guest'], 1);
  try {
    await players[0].startGame();
    await playGame(players, [0.25, 0.5, 0.75]);

    // Game over: the room is reusable, not stuck on "Game already started"
    for (const p of players) {
      await expect(p.page.getByRole('heading', { name: 'Lobby' })).toBeVisible({ timeout: 30_000 });
    }

    // ...and a second game actually starts
    await players[0].startGame();
    for (const p of players) await p.waitForRound(ROUND.scribble);

    assertNoPageErrors(players);
  } finally {
    await Promise.all(players.map((p) => p.close()));
  }
});

test('refreshing mid-game resumes the same round with its data (drawing + EOTW)', async ({
  browser,
}) => {
  const { players } = await lobby(browser, ['host', 'refresher']);
  const [host, refresher] = players;
  const bands = [0.3, 0.7];
  try {
    await host.startGame();

    await Promise.all([
      (async () => {
        await playRound(host, ROUND.scribble, 0, bands);
        await playRound(host, ROUND.line, 0, bands);
      })(),
      (async () => {
        await playRound(refresher, ROUND.scribble, 1, bands);
        await refresher.waitForRound(ROUND.line);
        await refresher.page.waitForTimeout(1500);
        await refresher.page.reload();

        // Same round, with the neighbour's scribble under the canvas again
        await refresher.waitForRound(ROUND.line);
        await expect
          .poll(async () => (await refresher.overlayInk())?.x ?? -1, { timeout: 10_000 })
          .toBeGreaterThan(0.2);
        const ink = await refresher.overlayInk();
        expect(Math.abs(ink!.x - bands[0])).toBeLessThan(0.1);
      })(),
    ]);

    // Refresh again inside End-of-the-World: the card must come back
    await Promise.all(
      players.map(async (p) => {
        await p.waitForRound(ROUND.eotw, 60_000);
      }),
    );
    await refresher.page.waitForTimeout(500);
    await refresher.page.reload();
    await refresher.waitForRound(ROUND.eotw);
    await expect(refresher.page.locator('.card-front img')).toHaveAttribute(
      'src',
      /\/images\/eotw\//,
    );

    // and the game still finishes for everyone
    for (const p of players) {
      await expect(p.page.getByRole('heading', { name: 'Lobby' })).toBeVisible({ timeout: 90_000 });
    }
    assertNoPageErrors(players);
  } finally {
    await Promise.all(players.map((p) => p.close()));
  }
});

test('a player whose browser closed rejoins their seat by name, mid-game', async ({ browser }) => {
  const { players, room } = await lobby(browser, ['host', 'flaky']);
  const [host, flaky] = players;
  try {
    await host.startGame();
    await host.waitForRound(ROUND.scribble);
    await flaky.waitForRound(ROUND.scribble);

    await flaky.close(); // browser gone: no session left to resume
    await host.page.waitForTimeout(1000);

    const back = await Player.create(browser, 'flaky', {
      contextOptions: { viewport: { width: 1100, height: 900 } },
    });
    players.push(back);
    await back.joinRoomMidGame(room);
    await expect(back.roundHeading).toBeVisible({ timeout: 15_000 });
    await expect(back.canvas).toBeVisible();

    assertNoPageErrors([host, back]);
  } finally {
    await Promise.all(players.map((p) => p.close().catch(() => {})));
  }
});

test('a duplicated tab takes over the player and the old tab stops fighting', async ({ browser }) => {
  const { players } = await lobby(browser, ['host', 'twin']);
  const [host, twin] = players;
  try {
    await host.startGame();
    await twin.waitForRound(ROUND.scribble);

    // Same sessionStorage, as when a tab is duplicated
    const copy = await twin.context.newPage();
    const session = await twin.page.evaluate(() => JSON.stringify({ ...sessionStorage }));
    await copy.addInitScript((s) => {
      for (const [k, v] of Object.entries(JSON.parse(s))) sessionStorage.setItem(k, v as string);
    }, session);
    await copy.goto('/');

    await expect(copy.locator('.game-card h1')).toBeVisible({ timeout: 15_000 });
    await expect(twin.page.locator('.toast-error')).toContainText('another tab');

    // The old tab must not reconnect and steal the seat back
    await twin.page.waitForTimeout(4000);
    await expect(copy.locator('.game-card h1')).toBeVisible();
    await expect(twin.page.locator('.toast-error')).toContainText('another tab');
  } finally {
    await Promise.all(players.map((p) => p.close()));
  }
});
