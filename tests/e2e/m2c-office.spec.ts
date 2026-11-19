/**
 * M2c office glass through the real browser client (qa-tester, Phase 3), LAYOUT_SEED pinned.
 *
 * One player in a private office room; the loot tables hold knives, RPGs, rockets and smokes. The player lands near the
 * Yellow Room's glass front (panes 22 / 23 on z = -16.87, facing the main aisle), breaks pane 23 with a knife and walks
 * through it, then breaks pane 22 with a rocket. A late observer that joins after that receives the broken panes (and
 * any live smoke cloud) in its first snapshot (late-join state). Server state from the observer; HUD from the DOM.
 * Canvas screenshots: test-results/shots/m2c-office-*.png.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { calibrateLook, look, me, turnTo, walkTo } from './support/drive';
import { game, lockPointer, newPlayer, openTitle, SHOTS, soloMatch, unexpectedErrors, type ConsoleLog } from './support/game';
import { dist2, Observer, yawTo, type Vec3 } from './support/observer';
import { startStack, type Stack } from './support/stack';
import { followPath, officePaths } from './support/nav';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'QA Glass';
/** Baseline layout (seed 0, M2b props): deterministic paths; nav paths come from the same layout. */
const LAYOUT_SEED = 0;
const ITEMS = [
  'ammo_heavy', 'ammo_light', 'ammo_rocket', 'ammo_shell', 'ammo_sniper', 'bandage', 'dbshotgun', 'dmr', 'grenade', 'helmet_1',
  'helmet_2', 'helmet_3', 'helmet_4', 'knife', 'lmg', 'machete', 'medkit', 'paddle', 'pistol', 'revolver', 'rifle', 'rpg', 'scope_2x',
  'scope_4x', 'scope_8x', 'scope_red_dot', 'shotgun', 'smg', 'smoke', 'sniper', 'vest_1', 'vest_2', 'vest_3', 'vest_4',
];
const ZERO = Object.fromEntries(ITEMS.map((i) => [i, 0]));
const LOOT = { ...ZERO, knife: 10, rpg: 4, ammo_rocket: 2, smoke: 1 };
const TIERS = { common: LOOT, rare: LOOT, epic: LOOT };
type Pane = { id: number; x1: number; z1: number; x2: number; z2: number; cx: number; cz: number };

let stack: Stack;
let ctx: BrowserContext;
let page: Page;
let log: ConsoleLog;
let obs: Observer;
let code = '';
let radPerPx = 0.0022;
let panes: Pane[] = [];
const notes: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  panes = JSON.parse(
    execFileSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'tests/e2e/support/office-panes.ts')], { cwd: ROOT, encoding: 'utf8' }),
  ) as Pane[];
  stack = await startStack({
    label: 'm2c-office',
    seed: 7070,
    layoutSeed: 'baseline',
    balance: {
      match: { countdownSeconds: 5, resultsSeconds: 5, targetPlayers: 3 },
      bots: { reactionMs: 600_000 },
      loot: { spawnChance: 1, tiers: TIERS },
      // Long office zone phases: nobody is caught by the sprinklers while walking (the zone is not under test here).
      maps: { office: { loot: { tiers: TIERS }, zone: { phases: [{ waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.9, dps: 1 }] } } },
    },
  });
  ({ ctx, page, log } = await newPlayer(browser, stack.baseURL));
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  code = await soloMatch(page, NAME, { map: 'office' });
  obs = await Observer.connect(stack.serverPort, code);
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  obs?.close();
  await ctx?.close();
  await stack?.stop();
});

async function shot(label: string): Promise<void> {
  await page.locator('#app canvas').screenshot({ path: `${SHOTS}/m2c-office-${label}.png` });
}
async function ensureLocked(): Promise<void> {
  if (!(await page.evaluate(() => document.pointerLockElement !== null))) expect(await lockPointer(page)).toBe(true);
}
const pane = (id: number): Pane => panes.find((p) => p.id === id)!;
/** Unit normal of a pane's wall (walls run along X or Z). */
const normalOf = (p: Pane): { x: number; z: number } => (Math.abs(p.z2 - p.z1) < 1e-6 ? { x: 0, z: 1 } : { x: 1, z: 0 });
const width = (p: Pane): number => Math.hypot(p.x2 - p.x1, p.z2 - p.z1);
/** A point `d` m off the pane centre on `side` (+1 / -1 along the normal). */
const offPane = (p: Pane, side: number, d: number): Vec3 => {
  const n = normalOf(p);
  return { x: p.cx + n.x * side * d, y: 0, z: p.cz + n.z * side * d };
};
const sideOf = (p: Pane, q: Vec3): number => {
  const n = normalOf(p);
  return Math.sign((q.x - p.cx) * n.x + (q.z - p.cz) * n.z) || 1;
};
let meleePane: Pane | null = null;
/** Walk to `target` along the office nav path (the W-pulse walker alone stalls on furniture). Returns the final distance. */
async function goTo(target: Vec3, label: string): Promise<number> {
  const here = (await me(obs, NAME)).pos;
  const [path] = officePaths([{ layoutSeed: LAYOUT_SEED, from: here, to: target }]);
  if (!path) {
    notes.push(`${label}: no nav path`);
    return Infinity;
  }
  const d = await followPath(page, obs, NAME, [...path, target], radPerPx, 150_000, notes);
  notes.push(`${label}: ${path.length} nav points, ended ${d.toFixed(2)} m from the target`);
  return d;
}
/** Nearest floor item of `item` by nav-path length; walk there and press E until it is gone. */
async function pickNearest(item: string): Promise<boolean> {
  const here = (await me(obs, NAME)).pos;
  const items = obs.latest!.loot.filter((l) => l.item === item && l.pos.y < 1).sort((a, b) => dist2(here, a.pos) - dist2(here, b.pos)).slice(0, 4);
  const paths = officePaths(items.map((l) => ({ layoutSeed: LAYOUT_SEED, from: here, to: l.pos })));
  const len = (pts: Vec3[] | null): number => (pts ? pts.reduce((a, p, i) => a + (i ? dist2(pts[i - 1]!, p) : 0), 0) : Infinity);
  const order = items.map((l, i) => ({ l, n: len(paths[i]!) })).sort((a, b) => a.n - b.n);
  for (const { l } of order) {
    const alive = () => obs.latest!.loot.some((x) => x.id === l.id);
    if (!alive()) continue;
    await goTo(l.pos, `${item}#${l.id}`);
    for (let i = 0; i < 6 && alive(); i++) {
      await page.keyboard.press('e');
      await page.waitForTimeout(900);
      const q = await me(obs, NAME);
      if (alive() && dist2(q.pos, l.pos) > 1.4) await walkTo(page, obs, NAME, () => l.pos, 0.8, radPerPx, 8000);
    }
    if (!alive()) return true;
  }
  return false;
}
let meleeSide = 1;
const ev = (type: string, pred: (e: Record<string, unknown>) => boolean = () => true) => obs.eventsOf(type).filter((e) => pred(e as Record<string, unknown>));
const broken = (): number[] => ((obs.latest as unknown as { brokenPanes?: number[] }).brokenPanes ?? []).slice();

let plannedPane: Pane | null = null;
test('drop next to a floor knife that has a glass pane within 10 m (chosen from the live loot and the drone route)', async () => {
  test.setTimeout(90_000);
  await expect.poll(() => obs.latest?.match.route ?? null, { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => obs.latest?.loot.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(20);
  const r = obs.latest!.match.route as unknown as { entry: { x: number; z: number }; exit: { x: number; z: number }; speed: number; startsAt: number; noJumpUntil: number; ejectAt: number };
  const len = Math.hypot(r.exit.x - r.entry.x, r.exit.z - r.entry.z);
  const ux = (r.exit.x - r.entry.x) / len;
  const uz = (r.exit.z - r.entry.z) / len;
  type Cand = { knife: Vec3; pane: Pane; lateral: number; s: number };
  const cands: Cand[] = [];
  for (const l of obs.latest!.loot) {
    if (l.item !== 'knife' || l.pos.y > 1) continue;
    const pn = panes.filter((p) => width(p) >= 3).sort((a, b2) => dist2(l.pos, offPane(a, sideOf(a, l.pos), 1.6)) - dist2(l.pos, offPane(b2, sideOf(b2, l.pos), 1.6)))[0];
    if (!pn || dist2(l.pos, offPane(pn, sideOf(pn, l.pos), 1.6)) > 10) continue;
    const sAlong = (l.pos.x - r.entry.x) * ux + (l.pos.z - r.entry.z) * uz;
    cands.push({ knife: l.pos, pane: pn, lateral: Math.abs((l.pos.x - r.entry.x) * uz - (l.pos.z - r.entry.z) * ux), s: sAlong });
  }
  cands.sort((a, b2) => a.lateral - b2.lateral);
  notes.push(`knife+pane candidates ${cands.length}; best lateral ${cands[0]?.lateral.toFixed(1)} m (pane ${cands[0]?.pane.id})`);
  expect(cands.length, 'a floor knife within 10 m of a glass pane').toBeGreaterThan(0);
  const best = cands[0]!;
  plannedPane = best.pane;
  const target = best.knife;
  const planned = Math.min(Math.max(r.startsAt + (best.s / r.speed) * 1000, r.noJumpUntil + 100), r.ejectAt - 200) - 300;
  await ensureLocked();
  while ((await game(page, (g) => g.serverTime)) < planned && (await game(page, (g) => g.aboard))) await page.waitForTimeout(40);
  await page.keyboard.down('w');
  while (await game(page, (g) => g.aboard)) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(120);
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until && (await game(page, (g) => g.dropPhase !== null))) {
    const p = await me(obs, NAME);
    if (dist2(p.pos, target) > 2) await turnTo(page, obs, NAME, yawTo(p.pos, target), radPerPx);
    await page.waitForTimeout(60);
  }
  await page.keyboard.up('w');
  await expect.poll(async () => (await me(obs, NAME)).anim.dropping, { timeout: 10_000 }).toBe(false);
  const p = await me(obs, NAME);
  notes.push(`landed (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(1)}), ${dist2(p.pos, target).toFixed(1)} m from the knife`);
  radPerPx = await calibrateLook(page, obs, NAME);
  await shot('landed');
});

test('knife breaks the nearest glass pane (glassBroken cause melee) and the player walks through the opening', async () => {
  test.setTimeout(240_000);
  await ensureLocked();
  expect(await pickNearest('knife'), 'picked a knife').toBe(true);
  // The pane (>= 3 m wide, so the opening is walkable) nearest to us, approached from our side.
  const here = await me(obs, NAME);
  const cands = panes.filter((p) => width(p) >= 3).sort((a, b) => dist2(here.pos, offPane(a, sideOf(a, here.pos), 1.6)) - dist2(here.pos, offPane(b, sideOf(b, here.pos), 1.6)));
  meleePane = cands[0]!; // nearest to where we picked the knife (plannedPane was only for the drop)
  void plannedPane;
  meleeSide = sideOf(meleePane, here.pos);
  const p23 = meleePane;
  const stand = offPane(p23, meleeSide, 1.6);
  const d = await goTo(stand, `pane ${p23.id} stand point`);
  notes.push(`at pane ${p23.id} (${p23.cx.toFixed(1)}, ${p23.cz.toFixed(1)}): ${d.toFixed(2)} m`);
  expect(d, 'near the pane').toBeLessThan(4);
  await page.keyboard.press('3');
  await expect.poll(async () => (await me(obs, NAME)).weapon, { timeout: 5000 }).toBe('knife');
  await turnTo(page, obs, NAME, yawTo(stand, { x: p23.cx, y: 0, z: p23.cz }), radPerPx);
  await shot('before-glass');
  // Step toward the glass between swings until a swing breaks it (knife reach 2 m from the eye).
  const toPane = async (): Promise<number> => {
    const q = await me(obs, NAME);
    const n = normalOf(p23);
    return Math.abs((q.pos.x - p23.cx) * n.x + (q.pos.z - p23.cz) * n.z);
  };
  for (let i = 0; i < 10 && !broken().includes(p23.id); i++) {
    const q = await me(obs, NAME);
    const face = { x: q.pos.x - normalOf(p23).x * meleeSide * 5, y: 0, z: q.pos.z - normalOf(p23).z * meleeSide * 5 };
    await turnTo(page, obs, NAME, yawTo(q.pos, face), radPerPx);
    if ((await toPane()) > 1.3) {
      await page.keyboard.down('w');
      await page.waitForTimeout(250);
      await page.keyboard.up('w');
      await page.waitForTimeout(300);
    }
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  notes.push(`distance to the pane plane at the end: ${(await toPane()).toFixed(2)} m`);
  const g = ev('glassBroken', (e) => e.paneId === p23.id)[0];
  notes.push(`glassBroken ${p23.id}: ${JSON.stringify(g)}; brokenPanes ${JSON.stringify(broken())}`);
  expect(g?.cause).toBe('melee');
  expect(broken()).toContain(p23.id);
  // The client draws it broken too (BUG-014 hook field).
  await expect.poll(() => game(page, (x) => x.brokenPanes), { timeout: 5000 }).toContain(p23.id);
  await page.waitForTimeout(500);
  await shot('glass-broken-melee');
  // Walk through the opening into the Yellow Room.
  // Line up on the pane centre, then walk straight through (walkTo's side-steps would drift into the next pane).
  const inside = offPane(p23, -meleeSide, 3);
  await walkTo(page, obs, NAME, () => offPane(p23, meleeSide, 1.4), 0.5, radPerPx, 20_000);
  let d2 = Infinity;
  for (let i = 0; i < 6 && sideOf(p23, (await me(obs, NAME)).pos) === meleeSide; i++) {
    const q = await me(obs, NAME);
    await turnTo(page, obs, NAME, yawTo(q.pos, inside), radPerPx);
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    await page.waitForTimeout(400);
    d2 = dist2((await me(obs, NAME)).pos, inside);
  }
  const q = await me(obs, NAME);
  notes.push(`through the opening: now (${q.pos.x.toFixed(2)}, ${q.pos.z.toFixed(2)}), ${d2.toFixed(2)} m from the far-side point`);
  expect(sideOf(p23, q.pos)).toBe(-meleeSide);
  await shot('through-glass');
});

test('a rocket breaks another pane (glassBroken cause rocket, then an explosion)', async () => {
  test.setTimeout(240_000);
  await ensureLocked();
  expect(await pickNearest('rpg'), 'picked an rpg').toBe(true);
  // Another pane, shot from 8 m on our current side (past the 5 m arming distance, outside the 5 m blast radius).
  const now = await me(obs, NAME);
  const others = panes.filter((p) => p.id !== meleePane?.id && !broken().includes(p.id));
  others.sort((a, b) => dist2(now.pos, offPane(a, sideOf(a, now.pos), 8)) - dist2(now.pos, offPane(b, sideOf(b, now.pos), 8)));
  const p22 = others[0]!;
  const stand = offPane(p22, sideOf(p22, now.pos), 8);
  const d = await goTo(stand, `8 m from pane ${p22.id}`);
  notes.push(`8 m in front of pane ${p22.id} (${p22.cx.toFixed(1)}, ${p22.cz.toFixed(1)}): ${d.toFixed(2)} m`);
  for (const k of ['1', '2']) {
    if ((await me(obs, NAME)).weapon === 'rpg') break;
    await page.keyboard.press(k);
    await page.waitForTimeout(700);
  }
  await expect.poll(async () => (await me(obs, NAME)).weapon, { timeout: 5000 }).toBe('rpg');
  const here = await me(obs, NAME);
  await turnTo(page, obs, NAME, yawTo(here.pos, { x: p22.cx, y: 0, z: p22.cz }), radPerPx);
  // Level the view (look up a lot, then down to about level): the pane is 27 m tall, so any level-ish aim hits it.
  await look(page, 0, -300);
  await look(page, 0, 250);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect.poll(() => ev('rocketFired').length, { timeout: 8000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await shot('rpg-flight');
  await expect.poll(() => ev('glassBroken', (e) => e.cause === 'rocket').length, { timeout: 8000 }).toBeGreaterThan(0);
  const g = ev('glassBroken', (e) => e.cause === 'rocket')[0]!;
  notes.push(`rocket glass: ${JSON.stringify(g)}; explosions ${ev('explosion').length}; brokenPanes ${JSON.stringify(broken())}`);
  expect(ev('explosion').length).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await shot('glass-broken-rocket');
});

test('late join: an observer joining now receives the broken panes in its first snapshot; no console errors', async () => {
  const before = broken();
  expect(before.length).toBeGreaterThanOrEqual(2);
  const late = await Observer.connect(stack.serverPort, code, 'QA Late');
  try {
    await expect.poll(() => late.latest !== null, { timeout: 5000 }).toBe(true);
    const got = ((late.latest as unknown as { brokenPanes?: number[] }).brokenPanes ?? []).slice().sort((a, b) => a - b);
    notes.push(`late observer brokenPanes ${JSON.stringify(got)} (live ${JSON.stringify(before.sort((a, b) => a - b))}), smokes ${JSON.stringify((late.latest as unknown as { smokes?: unknown[] }).smokes?.length ?? 0)}`);
    expect(got).toEqual(before);
  } finally {
    late.close();
  }
  expect(log.all.filter((l) => /layout mismatch/i.test(l))).toEqual([]);
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
});
