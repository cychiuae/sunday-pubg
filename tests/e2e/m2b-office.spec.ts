/**
 * M2b office specifics through the real browser client (qa-tester, Phase D).
 *
 * One player in a private office room (bots filled but passive, slow zone). The player jumps from the drone when it
 * passes closest to one of the four walk-ramp climb routes (office.md 4.3: TL-A, TR-B, BL-B, BR-B, all starting in the
 * main aisle), walks to the ramp foot and walks up it onto the desk plateau (6.66 m). Then C / Z / Space stance changes
 * on the plateau and on the floor under a desk with lastCorrection tracked, and the whole office match must log no
 * console errors for 90 s. Canvas screenshots: test-results/shots/m2b-office-*.png.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { calibrateLook, hook, me, turnTo, waitHook, walkTo } from './support/drive';
import { game, lockPointer, newPlayer, openTitle, SHOTS, soloMatch, unexpectedErrors, type ConsoleLog } from './support/game';
import { dist2, Observer, yawTo, type Vec3 } from './support/observer';
import { startStack, type Stack } from './support/stack';
import { followPath, officePaths } from './support/nav';

const NAME = 'QA Office';
const DESK_TOP = 6.66;
/** Walk-ramp climb routes (src/game/levels/office.ts climbRoutes, mode 'walk' on desk blocks): foot and top. */
const RAMPS: { id: string; foot: Vec3; top: Vec3 }[] = [
  { id: 'TL-A', foot: { x: -61.7, y: 0, z: -0.5 }, top: { x: -61.7, y: DESK_TOP, z: -16.5 } },
  { id: 'TR-B', foot: { x: 76, y: 0, z: -0.5 }, top: { x: 76, y: DESK_TOP, z: -16.5 } },
  { id: 'BL-B', foot: { x: -11.1, y: 0, z: 0.5 }, top: { x: -11.1, y: DESK_TOP, z: 16.5 } },
  { id: 'BR-B', foot: { x: 90, y: 0, z: 0.5 }, top: { x: 90, y: DESK_TOP, z: 16.5 } },
];

let stack: Stack;
let ctx: BrowserContext;
let page: Page;
let log: ConsoleLog;
let obs: Observer;
let matchStart = 0;
let radPerPx = 0.0022;
let ramp = RAMPS[0]!;
const notes: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  stack = await startStack({
    label: 'm2b-office', layoutSeed: 'baseline', // M2c: pinned layout (seed 0 = the M2b props and loot) so paths are reproducible
    seed: Number(process.env.QA_OFFICE_SEED ?? 5151),
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 4 },
      bots: { reactionMs: 600_000, grenade: { throwChancePerDecision: 0 } },
    },
  });
  ({ ctx, page, log } = await newPlayer(browser, stack.baseURL));
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  const code = await soloMatch(page, NAME, { map: 'office' });
  matchStart = Date.now();
  obs = await Observer.connect(stack.serverPort, code);
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  obs?.close();
  await ctx?.close();
  await stack?.stop();
});

async function shot(label: string): Promise<void> {
  await page.locator('#app canvas').screenshot({ path: `${SHOTS}/m2b-office-${label}.png` });
}
async function ensureLocked(): Promise<void> {
  if (!(await page.evaluate(() => document.pointerLockElement !== null))) expect(await lockPointer(page)).toBe(true);
}

test('drop near a walk ramp: jump when the drone passes closest to the ramp foot, land in the office', async () => {
  test.setTimeout(90_000);
  expect(await game(page, (g) => g.mapId)).toBe('office');
  await expect.poll(() => obs.latest?.match.route ?? null, { timeout: 10_000 }).not.toBeNull();
  const r = obs.latest!.match.route as unknown as {
    entry: { x: number; z: number }; exit: { x: number; z: number }; speed: number; startsAt: number; noJumpUntil: number; ejectAt: number;
  };
  const len = Math.hypot(r.exit.x - r.entry.x, r.exit.z - r.entry.z);
  const ux = (r.exit.x - r.entry.x) / len;
  const uz = (r.exit.z - r.entry.z) / len;
  // Pick the ramp whose closest route point is reachable in the jump window, with the smallest lateral gap.
  let best: { ramp: (typeof RAMPS)[number]; at: number; lateral: number } | null = null;
  for (const rp of RAMPS) {
    const s = (rp.foot.x - r.entry.x) * ux + (rp.foot.z - r.entry.z) * uz;
    const at = r.startsAt + (s / r.speed) * 1000;
    const lateral = Math.abs((rp.foot.x - r.entry.x) * uz - (rp.foot.z - r.entry.z) * ux);
    const t = Math.min(Math.max(at, r.noJumpUntil + 100), r.ejectAt - 200);
    if (!best || lateral < best.lateral) best = { ramp: rp, at: t, lateral };
  }
  ramp = best!.ramp;
  notes.push(`route ${JSON.stringify({ entry: r.entry, exit: r.exit })}; ramp ${ramp.id}, lateral ${best!.lateral.toFixed(1)} m`);
  await ensureLocked();
  await shot('aboard');
  // Pre-aim while aboard (the carrier sends look input): yaw from the planned jump point toward the ramp foot, so W
  // steers the whole 2.25 s descent (about 21 m of reach) toward it. Then jump at the planned server time.
  const planned = best!.at - 300;
  const jumpPt = (): { x: number; y: number; z: number } => {
    const d = Math.max(0, ((planned - r.startsAt) / 1000) * r.speed);
    return { x: r.entry.x + ux * d, y: 0, z: r.entry.z + uz * d };
  };
  radPerPx = 0.0022;
  // Pre-aim only while there is time for it (a slow page can spend seconds in turnTo).
  for (let i = 0; i < 3 && (await game(page, (g) => g.serverTime)) < planned - 1500; i++) {
    await turnTo(page, obs, NAME, yawTo(jumpPt(), ramp.foot), radPerPx);
  }
  while ((await game(page, (g) => g.serverTime)) < planned && (await game(page, (g) => g.aboard))) await page.waitForTimeout(40);
  await page.keyboard.down('w');
  while (await game(page, (g) => g.aboard)) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(120);
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until && (await game(page, (g) => g.dropPhase !== null))) {
    const p = await me(obs, NAME);
    if (dist2(p.pos, ramp.foot) > 2) await turnTo(page, obs, NAME, yawTo(p.pos, ramp.foot), radPerPx);
    else await page.keyboard.up('w');
    await page.waitForTimeout(60);
  }
  await page.keyboard.up('w');
  await expect.poll(async () => (await me(obs, NAME)).anim.dropping, { timeout: 10_000 }).toBe(false);
  const landed = await me(obs, NAME);
  notes.push(`landed at (${landed.pos.x.toFixed(1)}, ${landed.pos.y.toFixed(2)}, ${landed.pos.z.toFixed(1)}), ${dist2(landed.pos, ramp.foot).toFixed(1)} m from ${ramp.id}`);
  // A late jump (slow page) can land far away: then climb the walk ramp nearest to where we are.
  const nearest = [...RAMPS].sort((a, b) => dist2(landed.pos, a.foot) - dist2(landed.pos, b.foot))[0]!;
  if (nearest.id !== ramp.id) {
    notes.push(`switching to the nearest walk ramp ${nearest.id} (${dist2(landed.pos, nearest.foot).toFixed(1)} m)`);
    ramp = nearest;
  }
  expect(landed.hp, 'no fall damage from the office drop').toBe(100);
  await shot('landed');
});

test('climb route: walk to the ramp foot and up the ramp onto the desk plateau (6.66 m)', async () => {
  test.setTimeout(240_000);
  await ensureLocked();
  radPerPx = await calibrateLook(page, obs, NAME);
  const start = await me(obs, NAME);
  if (start.pos.y > DESK_TOP - 0.2) notes.push(`landed on a plateau already (y ${start.pos.y.toFixed(2)}); walking down first is out of scope`);
  // The ramp foot is in the main aisle; aim 1.5 m in front of it so the walk ends lined up with the ramp.
  const approach = { x: ramp.foot.x, y: 0, z: ramp.foot.z + Math.sign(ramp.foot.z - ramp.top.z) * 1.5 };
  // Follow the office nav path (baseline layout) to the approach point; the W-pulse walker alone stalls on furniture.
  const [path] = officePaths([{ layoutSeed: 0, from: start.pos, to: approach }]);
  notes.push(`nav path to ${ramp.id}: ${path ? path.length : 'none'} points`);
  const d = path ? await followPath(page, obs, NAME, [...path, approach], radPerPx, 150_000, notes) : await walkTo(page, obs, NAME, () => approach, 1.0, radPerPx, 120_000);
  notes.push(`reached the ramp approach: ${d.toFixed(2)} m`);
  expect(d, `reach ${ramp.id} foot`).toBeLessThan(1.5);
  await turnTo(page, obs, NAME, yawTo(approach, ramp.top), radPerPx);
  // Walk straight up (no sprint, so the steps are taken one by one).
  let topY = 0;
  const end = Date.now() + 30_000;
  const climbLog: string[] = [];
  // Steer along the ramp's centre line (x or z fixed), not toward the top point, so a sideways drift is corrected.
  const alongZ = Math.abs(ramp.top.z - ramp.foot.z) > Math.abs(ramp.top.x - ramp.foot.x);
  while (Date.now() < end && topY < DESK_TOP - 0.05) {
    const p = await me(obs, NAME);
    topY = Math.max(topY, p.pos.y);
    const aim = alongZ ? { x: ramp.foot.x, y: 0, z: p.pos.z + Math.sign(ramp.top.z - ramp.foot.z) * 4 } : { x: p.pos.x + Math.sign(ramp.top.x - ramp.foot.x) * 4, y: 0, z: ramp.foot.z };
    const want = yawTo(p.pos, aim);
    climbLog.push(`(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(2)},${p.pos.z.toFixed(1)}) yaw ${p.yaw.toFixed(2)} want ${want.toFixed(2)}`);
    await turnTo(page, obs, NAME, want, radPerPx);
    await page.keyboard.down('w');
    await page.waitForTimeout(400);
    await page.keyboard.up('w');
    await page.waitForTimeout(250);
  }
  notes.push(`climb log: ${climbLog.slice(0, 12).join(' | ')}${climbLog.length > 12 ? ` ... (${climbLog.length})` : ''}`);
  const p = await me(obs, NAME);
  notes.push(`on ${ramp.id}: y ${p.pos.y.toFixed(2)} at (${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)}), airborne ${p.anim.airborne}`);
  expect(p.pos.y).toBeCloseTo(DESK_TOP, 1);
  expect(p.anim.airborne).toBe(false);
  expect((await hook(page, (g) => g.localPos?.y ?? 0))).toBeCloseTo(DESK_TOP, 1);
  await shot('desk-plateau');
});

test('stance on the plateau and under a desk: C / Z / Space settle, server agrees, no reconciliation snaps', async () => {
  test.setTimeout(240_000);
  await ensureLocked();
  const flow = async (where: string): Promise<number> => {
    let maxCorr = 0;
    for (const [key, stance] of [['c', 'crouch'], ['z', 'prone'], ['Space', 'crouch'], ['Space', 'stand']] as const) {
      await page.keyboard.press(key);
      await waitHook(page, (x) => x.stanceProgress === 1, 6000, `${where} ${stance}`);
      expect(await hook(page, (x) => x.stance)).toBe(stance);
      await expect.poll(async () => (await me(obs, NAME)).stance, { timeout: 4000 }).toBe(stance);
      maxCorr = Math.max(maxCorr, await hook(page, (x) => x.lastCorrection));
      if (stance === 'prone') await shot(`prone-${where}`);
    }
    return maxCorr;
  };
  const plateau = await flow('plateau');
  // Walk off the desk edge forward (the plateau is 6.66 m; office fall damage starts above 8.1 m), then under the desk.
  const p0 = await me(obs, NAME);
  await page.keyboard.down('w');
  const until = Date.now() + 15_000;
  while (Date.now() < until && (await me(obs, NAME)).pos.y > 0.5) await page.waitForTimeout(200);
  await page.keyboard.up('w');
  await page.waitForTimeout(800);
  const p1 = await me(obs, NAME);
  notes.push(`walked off the plateau: y ${p0.pos.y.toFixed(2)} -> ${p1.pos.y.toFixed(2)}, hp ${p0.hp} -> ${p1.hp}`);
  const floor = p1.pos.y < 0.5 ? await flow('floor') : NaN;
  notes.push(`stance flows: max lastCorrection plateau ${plateau.toFixed(3)} m, floor ${floor.toFixed(3)} m`);
  expect(plateau).toBeLessThan(0.1);
  if (!Number.isNaN(floor)) {
    expect(floor).toBeLessThan(0.1);
    expect(p1.hp, 'a 6.66 m walk-off deals no damage on the office (maps.md 11)').toBe(p0.hp);
  }
});

test('90 s of an office match: no console errors, still connected, renderer alive', async () => {
  test.setTimeout(150_000);
  await ensureLocked();
  const keys = ['w', 'a', 's', 'd'];
  let i = 0;
  while (Date.now() - matchStart < 90_000) {
    const k = keys[i++ % keys.length]!;
    await page.keyboard.down(k);
    await page.waitForTimeout(400);
    await page.keyboard.up(k);
    await page.evaluate((dx) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: 0, bubbles: true })), 40);
    await page.waitForTimeout(300);
    if (!(await page.evaluate(() => document.pointerLockElement !== null)) && (await hook(page, (g) => g.localAlive))) await lockPointer(page);
  }
  const s = await game(page, (g) => ({ c: g.connection, map: g.mapId, phase: g.phase }));
  notes.push(`after ${((Date.now() - matchStart) / 1000).toFixed(0)} s: ${JSON.stringify(s)}`);
  expect(s.c).toBe('connected');
  expect(s.map).toBe('office');
  await shot('90s');
  expect(unexpectedErrors(log), log.all.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]') || l.startsWith('[warning]')).join('\n')).toEqual([]);
  notes.push(`console warnings: ${log.warnings.length}${log.warnings.length ? ` (first: ${log.warnings[0]})` : ''}`);
});
