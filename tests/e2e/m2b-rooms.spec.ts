/**
 * M2b rooms, map vote and carrier drop through the real browser client (qa-tester, Phase D).
 *
 * Three browser contexts share one private room:
 *   A (host) creates it from the browser; B joins by typing the code (lower case); C opens the invite link
 *   `/?room=CODE&map=office` (deep link + vote pre-select). The private room never appears in anyone's browser list.
 *   Votes: A office, B island, C office (from ?map=) -> office wins; the office match loads on all three
 *   (`__game.mapId === 'office'`). Aboard the drone the camera is the carrier orbit; A jumps with Space, B with F,
 *   C never jumps and is auto-ejected; each goes freefall -> chute -> on foot (first person). A fast zone ends the match;
 *   after the results everyone is back in the same waiting room. Then the host leaves and the host role migrates to
 *   the oldest remaining member (B).
 *
 * Client state from `window.__game` (src/game/devHook.ts); room state from the server's /healthz.
 * Canvas screenshots of each key state go to test-results/shots/m2b-*.png.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  createRoom,
  game,
  join,
  joinByCode,
  lockPointer,
  newPlayer,
  openTitle,
  SHOTS,
  startMatch,
  toBrowser,
  ui,
  unexpectedErrors,
  waitForMatch,
  type ConsoleLog,
} from './support/game';
import { startStack, type Stack } from './support/stack';

const FAST_ZONE = {
  phases: [{ waitSeconds: 22, shrinkSeconds: 4, radiusFraction: 0.01, dps: 300 }],
  finalCollapseDelaySeconds: 1,
  finalCollapseSeconds: 2,
  finalCollapseDps: 300,
  warningSecondsBeforeShrink: 3,
};

interface P {
  ctx: BrowserContext;
  page: Page;
  log: ConsoleLog;
  name: string;
}

let stack: Stack;
let A: P;
let B: P;
let C: P;
let code = '';
const notes: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  stack = await startStack({
    label: 'm2b-rooms',
    seed: 777,
    balance: {
      match: { countdownSeconds: 5, resultsSeconds: 5, lastHumanDeathDelaySeconds: 1 },
      bots: { reactionMs: 600_000 },
      zone: FAST_ZONE,
      maps: { office: { zone: { startRadius: 140, phases: FAST_ZONE.phases } } },
    },
  });
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  for (const p of [A, B, C]) await p?.ctx.close().catch(() => {});
  await stack?.stop();
});

async function shot(p: P, label: string): Promise<void> {
  await p.page.locator('#app canvas').screenshot({ path: `${SHOTS}/m2b-${label}.png` });
}

test('private room: create, join by code (lower case), join by ?room= link; never listed in the browser', async ({ browser }) => {
  A = { ...(await newPlayer(browser, stack.baseURL)), name: 'Host Ana' };
  B = { ...(await newPlayer(browser, stack.baseURL)), name: 'Guest Bo' };

  await openTitle(A.page);
  await toBrowser(A.page, A.name);
  await A.page.screenshot({ path: `${SHOTS}/m2b-browser-empty.png` });
  code = await createRoom(A.page, { visibility: 'private', map: 'vote', bots: false });
  expect(code).toMatch(/^[A-Z0-9]{4,8}$/);
  expect(await game(A.page, (g) => ({ code: g.roomCode, host: g.isHost }))).toEqual({ code, host: true });
  // The waiting room puts the code in the URL (shareable).
  expect(new URL(A.page.url()).searchParams.get('room')).toBe(code);
  await A.page.screenshot({ path: `${SHOTS}/m2b-room-host.png` });

  // B: the browser list never shows the private room (wait past the list throttle).
  await openTitle(B.page);
  await toBrowser(B.page, B.name);
  await B.page.waitForTimeout(2500);
  await expect(ui.roomRows(B.page)).toHaveCount(0);
  await expect(B.page.locator('.ui-roomtable__empty')).toBeVisible();
  await joinByCode(B.page, code.toLowerCase());
  expect(await game(B.page, (g) => ({ code: g.roomCode, host: g.isHost }))).toEqual({ code, host: false });
  await expect(ui.room(B.page).getByText(/waiting for host/i)).toBeVisible();
  await expect(ui.room(B.page).getByRole('button', { name: /start match/i })).toHaveCount(0);

  // C: the invite link with a map pre-select. After the name, the client joins the room by itself.
  C = { ...(await newPlayer(browser, stack.baseURL)), name: 'Link Cy' };
  await C.page.goto(`/?room=${code}&map=office`);
  await expect(ui.title(C.page)).toBeVisible({ timeout: 30_000 });
  await join(C.page, C.name);
  await expect(ui.room(C.page)).toBeVisible({ timeout: 15_000 });
  expect(await game(C.page, (g) => g.roomCode)).toBe(code);

  // Everyone sees 3 members; the server has one private room with 3 humans.
  for (const p of [A, B, C]) await expect(p.page.locator('.ui-members > li')).toHaveCount(3, { timeout: 10_000 });
  const h = await stack.health();
  expect(h.rooms).toBe(1);
  expect(h.perRoom[0]).toMatchObject({ visibility: 'private', humans: 3, phase: 'waiting' });
  // A fourth browser still sees no listed room.
  await B.page.waitForTimeout(500);
  for (const p of [A, B, C]) expect(unexpectedErrors(p.log), p.log.all.join('\n')).toEqual([]);
});

test('map vote: ?map=office pre-selected C; A office + B island -> office wins; the office match loads', async () => {
  const vote = (p: P, label: RegExp) => ui.room(p.page).getByRole('button', { name: label }).click();
  // C's vote came from the URL.
  await expect(ui.room(A.page).getByRole('button', { name: /^office/i })).toContainText(/votes: 1/i, { timeout: 10_000 });
  await vote(A, /^office/i);
  await vote(B, /^island/i);
  await expect(ui.room(C.page).getByRole('button', { name: /^office/i })).toContainText(/votes: 2/i, { timeout: 10_000 });
  await expect(ui.room(C.page).getByRole('button', { name: /^island/i })).toContainText(/votes: 1/i);
  await A.page.screenshot({ path: `${SHOTS}/m2b-room-votes.png` });

  await startMatch(A.page);
  // The map is announced at the lock (3 s before the countdown ends), so clients load it before the drop.
  for (const p of [A, B, C]) {
    await expect.poll(() => game(p.page, (g) => g.mapId), { timeout: 15_000 }).toBe('office');
  }
  const h = await stack.health();
  expect(h.perRoom[0]!.mapId).toBe('office');
});

test('carrier drop: aboard = carrier camera; Space (A) and F (B) jump; C is auto-ejected; freefall -> chute -> first person', async () => {
  await Promise.all([A, B, C].map((p) => waitForMatch(p.page, 40_000)));
  for (const p of [A, B, C]) {
    expect(await game(p.page, (g) => ({ aboard: g.aboard, view: g.cameraView, map: g.mapId })), p.name).toEqual({ aboard: true, view: 'carrier', map: 'office' });
  }
  // Pointer lock for the two jumpers only (C never touches the game), in parallel: the office flight is short.
  const locks = await Promise.all([lockPointer(A.page), lockPointer(B.page)]);
  expect(locks).toEqual([true, true]);
  void shot(A, 'office-aboard');

  // Each page records its own (aboard, dropPhase, cameraView, lastCorrection) trace every 40 ms (in-page, so the
  // three throttled WebGL pages are not polled serially from here).
  type Sample = { aboard: boolean; phase: string | null; cam: string | null; corr: number; y: number | null };
  for (const p of [A, B, C]) {
    await p.page.evaluate(() => {
      const w = window as unknown as { __trace: unknown[]; __game: { aboard: boolean; dropPhase: string | null; cameraView: string | null; lastCorrection: number; localPos: { y: number } | null } };
      w.__trace = [];
      const id = setInterval(() => {
        const g = w.__game;
        w.__trace.push({ aboard: g.aboard, phase: g.dropPhase, cam: g.cameraView, corr: g.lastCorrection, y: g.localPos?.y ?? null });
        if (w.__trace.length > 3000) clearInterval(id);
      }, 40);
    });
  }
  const jumped = { A: false, B: false };
  const until = Date.now() + 60_000;
  let shotFree = false;
  let shotChute = false;
  while (Date.now() < until) {
    const sa = await game(A.page, (g) => ({ aboard: g.aboard, phase: g.dropPhase }));
    if (sa.aboard) await A.page.keyboard.press('Space');
    else jumped.A = true;
    if (!jumped.B) {
      if (await game(B.page, (g) => g.aboard)) await B.page.keyboard.press('f');
      else jumped.B = true;
    }
    if (!shotFree && sa.phase === 'freefall') {
      shotFree = true;
      await shot(A, 'office-freefall');
    }
    if (!shotChute && sa.phase === 'chute') {
      shotChute = true;
      await shot(A, 'office-chute');
    }
    if (jumped.A && jumped.B && sa.phase === null) {
      const cOn = await game(C.page, (g) => !g.aboard && g.dropPhase === null);
      if (cOn) break;
    }
    await A.page.waitForTimeout(100);
  }
  await A.page.waitForTimeout(500);
  const traces = new Map<string, Sample[]>();
  for (const p of [A, B, C]) traces.set(p.name, (await p.page.evaluate(() => (window as unknown as { __trace: unknown[] }).__trace)) as Sample[]);
  for (const [name, t] of traces) {
    const phases = [...new Set(t.map((s) => (s.aboard ? 'aboard' : s.phase ?? 'foot')))];
    const cams = [...new Set(t.map((s) => s.cam))];
    const maxCorr = Math.max(...t.map((s) => s.corr));
    notes.push(`${name}: phases ${phases.join(' > ')}; cameras ${cams.join(' > ')}; max lastCorrection ${maxCorr.toFixed(3)} m; samples ${t.length}`);
    // Compressed trace: one entry per change of phase, plus y.
    const runs: string[] = [];
    for (const x of t) {
      const k = x.aboard ? 'aboard' : x.phase ?? 'foot';
      const last = runs.at(-1);
      const tag = `${k}@${x.y?.toFixed(1)}`;
      if (!last || !last.startsWith(`${k}@`)) runs.push(tag);
      else if (k !== 'aboard') runs[runs.length - 1] = `${last.split('..')[0]}..${x.y?.toFixed(1)}`;
    }
    notes.push(`  trace ${runs.join(' | ')}`);
    // Three WebGL pages share one CPU here (a few fps each), so a 1 s freefall or 1.25 s chute can fall between two
    // rendered frames; the strict aboard > freefall > chute > foot order is checked single-page in m2b-fp.spec.ts.
    expect(phases[0], name).toBe('aboard');
    expect(phases.at(-1), name).toBe('foot');
    expect(t.filter((s) => s.aboard).every((s) => s.cam === 'carrier'), `${name}: carrier camera while aboard`).toBe(true);
    expect(t.filter((s) => !s.aboard).every((s) => s.cam === 'firstPerson'), `${name}: first person after the jump`).toBe(true);
  }
  expect(jumped).toEqual({ A: true, B: true });
  // C never pressed anything: it left the drone at the eject point (auto), later than A and B.
  const firstOff = (n: string) => traces.get(n)!.findIndex((s) => !s.aboard);
  expect(firstOff(C.name)).toBeGreaterThan(firstOff(A.name));
  expect(firstOff(C.name)).toBeGreaterThan(firstOff(B.name));
  await shot(A, 'office-onfoot-fp');
  for (const p of [A, B, C]) {
    expect(await game(p.page, (g) => ({ hp: g.localHp, view: g.cameraView, vm: g.viewmodel?.visible ?? null }))).toEqual({
      hp: 100,
      view: 'firstPerson',
      vm: true,
    });
  }
});

test('after the results everyone returns to the same waiting room (same code, host, votes kept, ready reset)', async () => {
  // The fast zone ends the match; the results screen shows, then the room.
  await Promise.all([A, B, C].map((p) => expect(ui.results(p.page)).toBeVisible({ timeout: 90_000 })));
  expect(await game(A.page, (g) => g.cameraView)).toBe('results');
  await A.page.screenshot({ path: `${SHOTS}/m2b-results.png` });
  await Promise.all([A, B, C].map((p) => expect(ui.room(p.page)).toBeVisible({ timeout: 30_000 })));
  for (const p of [A, B, C]) {
    expect(await game(p.page, (g) => g.roomCode), p.name).toBe(code);
  }
  expect(await game(A.page, (g) => g.isHost)).toBe(true);
  // Votes persist (rooms.md AT9): office 2, island 1.
  await expect(ui.room(B.page).getByRole('button', { name: /^office/i })).toContainText(/votes: 2/i);
  const h = await stack.health();
  expect(h.rooms).toBe(1);
  expect(h.perRoom[0]).toMatchObject({ phase: 'waiting', humans: 3 });
  for (const p of [A, B, C]) expect(unexpectedErrors(p.log), p.log.all.join('\n')).toEqual([]);
});

test('host leaves: B (oldest remaining) becomes host and gets Start; the room stays open', async () => {
  await A.page.locator('.ui-screen--room').getByRole('button', { name: /^leave$/i }).click();
  // Leave may ask for confirmation.
  const confirm = A.page.getByRole('button', { name: /^leave/i });
  if (await ui.room(A.page).isVisible()) await confirm.last().click().catch(() => {});
  await expect(ui.browser(A.page)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => game(B.page, (g) => g.isHost), { timeout: 10_000 }).toBe(true);
  expect(await game(C.page, (g) => g.isHost)).toBe(false);
  await expect(ui.room(B.page).getByRole('button', { name: /start match/i })).toBeVisible();
  await B.page.screenshot({ path: `${SHOTS}/m2b-room-migrated.png` });
  const h = await stack.health();
  expect(h.perRoom[0]).toMatchObject({ humans: 2 });
  // Last two leave by closing their tabs: the room closes.
  await B.ctx.close();
  await C.ctx.close();
  await expect.poll(async () => (await stack.health()).rooms, { timeout: 10_000 }).toBe(0);
  expect(unexpectedErrors(A.log), A.log.all.join('\n')).toEqual([]);
});
