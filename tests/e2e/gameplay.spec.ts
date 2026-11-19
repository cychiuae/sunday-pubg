/**
 * Gameplay through the real browser client: pointer lock, drop steering, WASD/Shift/Space, mouse look, E pickup,
 * LMB fire, R reload, 1/2/3 switch, tide damage + outside banner, and renderer budgets in a live match.
 *
 * Authoritative state is read from a spectator socket (support/observer.ts) so assertions compare the browser's
 * inputs/HUD with what the server actually simulated.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  hpValue,
  jumpAndLand,
  lockPointer,
  soloMatch,
  newPlayer,
  openTitle,
  renderStats,
  SHOTS,
  ui,
  unexpectedErrors,
} from './support/game';
import { dist2, Observer, wrap, yawTo, type ObsLoot, type ObsPlayer } from './support/observer';
import { startStack, type Stack } from './support/stack';

const NAME = 'QA Hands';
const GUNS = new Set(['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper']);

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({
    label: 'gameplay',
    seed: 777,
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 4 },
      bots: { reactionMs: 600_000 },
      // Long first wait so looting is not interrupted, then a small circle so the tide check has someone outside.
      zone: {
        phases: [
          { waitSeconds: 100, shrinkSeconds: 4, radiusFraction: 0.08, dps: 5 },
          { waitSeconds: 600, shrinkSeconds: 10, radiusFraction: 0.03, dps: 5 },
        ],
        warningSecondsBeforeShrink: 5,
      },
    },
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Synthetic relative mouse move (pointer-locked look input). */
async function look(page: Page, dx: number, dy = 0): Promise<void> {
  await page.evaluate(
    ([x, y]) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true })),
    [dx, dy] as const,
  );
}

async function me(obs: Observer): Promise<ObsPlayer> {
  await obs.fresh();
  const p = obs.player(NAME);
  if (!p) throw new Error(`${NAME} not in snapshot`);
  return p;
}

/** Closed-loop turn toward `targetYaw` using the calibrated radians-per-pixel. */
async function turnTo(page: Page, obs: Observer, targetYaw: number, radPerPx: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const err = wrap(targetYaw - (await me(obs)).yaw);
    if (Math.abs(err) < 0.05) return;
    await look(page, -err / radPerPx);
    await page.waitForTimeout(250);
  }
}

test('browser input drives the authoritative player: drop, move, look, loot, shoot, reload, switch, tide', async ({ browser }) => {
  test.setTimeout(240_000);
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  // Smaller viewport = more frames per second under SwiftShader (HUD layout is covered by other specs at 1280x720).
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  const code = await soloMatch(page, NAME, { map: 'island01' });
  const obs = await Observer.connect(stack.serverPort, code);
  const notes: string[] = [];

  try {
    await test.step('pointer lock on click', async () => {
      await expect(ui.play(page)).toBeVisible();
      const locked = await lockPointer(page);
      expect(locked, 'canvas click grants pointer lock').toBe(true);
      await expect(ui.play(page)).toBeHidden();
    });

    // Nominal look gain at default sensitivity (measured 0.0022 rad/px); the closed loop corrects any error and the
    // look step below re-measures it after landing.
    let radPerPx = 0.0022;
    let target: ObsLoot | null = null;
    await test.step('carrier drop (M2b): Space at the door, freefall, chute, land; then walk to the nearest gun', async () => {
      // The M1 steered spawn drop is gone (drop.md); the carrier flow itself is covered by m2b-fp.spec.ts.
      await jumpAndLand(page, 90_000);
      const landed = await me(obs);
      expect(landed.anim.dropping).toBe(false);
      expect(landed.aboard).toBe(false);
      target =
        obs.latest!.loot
          .filter((l) => GUNS.has(l.item))
          .sort((a, b) => dist2(landed.pos, a.pos) - dist2(landed.pos, b.pos))[0] ?? null;
      expect(target, 'a gun exists').not.toBeNull();
      notes.push(`landed ${dist2(landed.pos, target!.pos).toFixed(1)} m from the nearest gun ${target!.item}#${target!.id}`);
      await page.screenshot({ path: `${SHOTS}/gameplay-landed.png` });
    });

    await test.step('mouse look: pointer-locked mousemove turns the player (right = yaw decreases)', async () => {
      // Headless Chromium limitation: CDP mouse moves under pointer lock arrive as +N then -N movementX (the cursor is
      // re-centred), so page.mouse.move nets zero. Real-mouse feel is a manual check; here we dispatch the same
      // MouseEvent the browser would deliver (movementX) on the document, which is what InputController listens to.
      const y0 = (await me(obs)).yaw;
      await look(page, 100);
      await page.waitForTimeout(400);
      const y1 = (await me(obs)).yaw;
      const d = wrap(y1 - y0);
      notes.push(`look +100px: yaw ${y0.toFixed(3)} -> ${y1.toFixed(3)}`);
      expect(d, 'moving right turns right (yaw decreases)').toBeLessThan(-0.01);
      radPerPx = Math.abs(d) / 100;
      notes.push(`radPerPx at default sensitivity: ${radPerPx.toFixed(5)}`);
    });

    let picked: ObsLoot | null = null;
    await test.step('loot: walk the last metres to the gun, pickup prompt, press E', async () => {
      const t = target!;
      // Short W pulses with settle time: the headless page applies key-up 0.5-1 s late, so holding W overshoots.
      const until = Date.now() + 40_000;
      let best = Infinity;
      let stuck = 0;
      while (Date.now() < until && obs.latest!.loot.some((l) => l.id === t.id)) {
        const p = await me(obs);
        const d = dist2(p.pos, t.pos);
        if (d < 1.5) break;
        // Blocked by a prop (a palm or rock between us and the gun): side-step, alternating sides.
        if (d > best - 0.2) stuck++;
        else stuck = 0;
        best = Math.min(best, d);
        if (stuck >= 2) {
          await page.keyboard.down(stuck % 4 < 2 ? 'd' : 'a');
          await page.waitForTimeout(500);
          await page.keyboard.up('d');
          await page.keyboard.up('a');
          await page.waitForTimeout(600);
          best = Infinity;
          notes.push(`side-step at ${d.toFixed(1)} m`);
        }
        await turnTo(page, obs, yawTo(p.pos, t.pos), radPerPx);
        await page.keyboard.down('w');
        await page.waitForTimeout(Math.min(400, 40 + d * 40));
        await page.keyboard.up('w');
        await page.waitForTimeout(700);
      }
      const stillThere = obs.latest!.loot.some((l) => l.id === t.id);
      const dEnd = dist2((await me(obs)).pos, t.pos);
      notes.push(`at target: ${dEnd.toFixed(1)} m, still on ground: ${stillThere}`);
      test.skip(!stillThere, 'a bot took the target gun first');
      expect(dEnd, 'reached the gun').toBeLessThan(2.0);
      await expect(ui.prompt(page), 'pickup prompt near loot').toBeVisible({ timeout: 3000 });
      await page.screenshot({ path: `${SHOTS}/gameplay-prompt.png` });
      // E takes the nearest item; the gun's ammo stacks lie within 0.8 m, so a few presses may grab ammo first.
      const myId = (await me(obs)).id;
      const pickups0 = obs.eventsOf('pickup').filter((e) => e.playerId === myId).length;
      for (let i = 0; i < 5 && obs.latest!.loot.some((l) => l.id === t.id); i++) {
        await page.keyboard.press('e');
        await page.waitForTimeout(1200);
      }
      const mine = obs.eventsOf('pickup').filter((e) => e.playerId === myId);
      notes.push(`pickups: ${mine.slice(pickups0).map((e) => `${String(e.item)}x${String(e.qty)}`).join(', ')}`);
      expect(mine.length).toBeGreaterThan(pickups0);
      await expect.poll(() => obs.latest!.loot.some((l) => l.id === t.id), { timeout: 4000 }).toBe(false);
      picked = t;
      await expect.poll(async () => (await me(obs)).weapon, { timeout: 3000 }).toBe(t.item);
      // Slot 1 now holds the gun (toasts expire after a few seconds, so the slot is the stable check).
      await expect(page.locator('.ui-slot__name').first()).not.toHaveText(/empty/i);
      await expect(ui.ammo(page)).toHaveText(/\d+\s*\/\s*\d+/);
      await page.screenshot({ path: `${SHOTS}/gameplay-picked.png` });
    });

    await test.step('walk and sprint speeds match balance (5.0 / 7.2 m/s of server time)', async () => {
      // Measured from the observer's snapshot history against serverTime, not wall clock: the headless page runs at
      // ~9-13 fps under SwiftShader. Peak speed over 0.5 s windows, so a prop met later in the run does not count.
      // Face the island centre first (open grass), away from the beach props around the loot.
      const here = await me(obs);
      await turnTo(page, obs, yawTo(here.pos, { x: 0, y: 0, z: 0 }), radPerPx);
      await page.keyboard.down('w');
      await page.waitForTimeout(300);
      const t0 = obs.latest!.tick;
      await page.waitForTimeout(1500);
      const walk = obs.peakSpeed(NAME, t0);
      await page.keyboard.down('Shift');
      await page.waitForTimeout(300);
      const t1 = obs.latest!.tick;
      await page.waitForTimeout(1500);
      const sprint = obs.peakSpeed(NAME, t1);
      await page.keyboard.up('Shift');
      await page.keyboard.up('w');
      notes.push(`peak walk ${walk.toFixed(2)} m/s, peak sprint ${sprint.toFixed(2)} m/s (server time)`);
      // Never faster than balance (+3% for snapshot quantisation); reaches it on open ground.
      expect(walk).toBeLessThanOrEqual(5.0 * 1.03);
      expect(walk).toBeGreaterThan(5.0 * 0.85);
      expect(sprint).toBeLessThanOrEqual(7.2 * 1.03);
      expect(sprint).toBeGreaterThan(7.2 * 0.85);
    });

    await test.step('jump: Space (tap and hold) makes the player airborne ~v^2/2g high', async () => {
      for (const mode of ['tap', 'hold'] as const) {
        await page.waitForTimeout(800);
        const t0 = obs.latest!.tick;
        const y0 = obs.player(NAME)!.pos.y;
        if (mode === 'tap') await page.keyboard.press('Space');
        else {
          await page.keyboard.down('Space');
          await page.waitForTimeout(120);
          await page.keyboard.up('Space');
        }
        await page.waitForTimeout(1500);
        const tr = obs.track(NAME, t0);
        const peak = Math.max(...tr.map((x) => x.p.pos.y)) - y0;
        const airborne = tr.some((x) => x.p.anim.airborne);
        notes.push(`jump (${mode}) peak +${peak.toFixed(2)} m (balance v^2/2g = ${((6.5 * 6.5) / 40).toFixed(2)})`);
        expect(airborne, `${mode}: airborne`).toBe(true);
        expect(peak, `${mode}: height`).toBeGreaterThan(0.7);
        expect(peak, `${mode}: height`).toBeLessThan(1.2);
      }
    });

    await test.step('LMB fires (mag decreases, shot event), R reloads, 3/1 switch', async () => {
      const id = (await me(obs)).id;
      const magOf = async (): Promise<number> => Number(((await ui.ammo(page).textContent()) ?? '').split('/')[0]!.trim());
      const mag0 = await magOf();
      const shots0 = obs.eventsOf('shot').filter((e) => e.shooterId === id).length;
      notes.push(`before LMB: HUD mag ${mag0}, server shots so far ${shots0}, reloads ${obs.eventsOf('reloadStart').filter((e) => e.playerId === id).length}, weapon ${(await me(obs)).weapon}`);
      // Note: the headless page thread runs at ~9-13 fps, so the DOM sees mouseup 0.5-1.3 s after mousedown and an
      // automatic weapon may fire many rounds; only "fired at least once" is asserted here.
      await page.mouse.down();
      await page.waitForTimeout(120);
      await page.mouse.up();
      await expect.poll(magOf, { timeout: 3000 }).toBeLessThan(mag0);
      const shots1 = obs.eventsOf('shot').filter((e) => e.shooterId === id).length;
      notes.push(`mag ${mag0} -> ${await magOf()}, shot events ${shots0} -> ${shots1}`);
      expect(shots1).toBeGreaterThan(shots0);

      const reserve = Number(((await ui.ammo(page).textContent()) ?? '').split('/')[1]?.trim() ?? '0');
      const mine = (type: string): number => obs.eventsOf(type).filter((e) => e.playerId === id).length;
      const reloads0 = mine('reloadStart');
      await page.keyboard.press('r');
      if (reserve > 0) {
        await page.waitForTimeout(600);
        const diag = await page.evaluate(() => {
          const g = (window as unknown as { __game: Record<string, unknown> }).__game;
          return { weapon: g['localWeapon'], vm: g['viewmodel'], pending: g['pendingInputs'], locked: document.pointerLockElement !== null, phase: g['phase'] };
        });
        notes.push(`after R: reserve ${reserve}, reloadStart ${mine('reloadStart') - reloads0}, server anim.reloading ${(await me(obs)).anim.reloading}, client ${JSON.stringify(diag)}`);
        await expect.poll(() => mine('reloadStart'), { timeout: 3000 }).toBeGreaterThan(reloads0);
        // A one-shell reload (pump shotgun) can finish before the bar is checked: accept the bar or a finished reload.
        await expect.poll(async () => (await page.locator('.ui-ammo__reload').isVisible()) || mine('reloadEnd') > 0, { timeout: 5000 }).toBe(true);
        await expect.poll(() => mine('reloadEnd'), { timeout: 4000 }).toBeGreaterThan(0);
        notes.push(`after R: mag ${await magOf()} (reserve was ${reserve})`);
        expect(await magOf()).toBeGreaterThan(mag0 - 1);
      } else {
        await page.waitForTimeout(800);
        notes.push(`R with reserve 0: reloadStart ${mine('reloadStart') - reloads0} (actionFailed is owner-only, not visible to the observer)`);
        expect(mine('reloadStart')).toBe(reloads0);
      }

      await page.keyboard.press('3');
      await expect.poll(async () => (await me(obs)).weapon, { timeout: 3000 }).toBe('fists');
      await expect(ui.ammo(page)).toHaveText('∞');
      await page.keyboard.press('1');
      await expect.poll(async () => (await me(obs)).weapon, { timeout: 3000 }).toBe(picked!.item);
    });

    await test.step('renderer budgets in a live match (<= 250 calls, <= 600k tris)', async () => {
      const rs = await renderStats(page);
      notes.push(`render ${JSON.stringify(rs)}`);
      expect(rs).not.toBeNull();
      expect(rs!.calls).toBeLessThanOrEqual(250);
      expect(rs!.triangles).toBeLessThanOrEqual(600_000);
    });

    await test.step('tide: after the shrink, HUD outside-banner and HP drain match server state', async () => {
      await expect.poll(() => obs.latest!.zone?.phaseIndex ?? -1, { timeout: 90_000 }).toBeGreaterThanOrEqual(0);
      await expect.poll(() => obs.latest!.zone!.shrinking === false && obs.latest!.zone!.phaseIndex >= 1 ? 1 : obs.latest!.zone!.radius < 15 ? 1 : 0, { timeout: 90_000 }).toBe(1);
      await page.waitForTimeout(1500);
      const p = await me(obs);
      const z = obs.latest!.zone!;
      const outside = dist2(p.pos, { x: z.center.x, y: 0, z: z.center.z }) > z.radius;
      notes.push(`zone r=${z.radius.toFixed(1)}, player ${outside ? 'outside' : 'inside'}, hp ${p.hp}`);
      if (outside) {
        await expect(page.locator('.ui-outside')).toBeVisible();
        const t0 = obs.latest!.tick;
        await page.waitForTimeout(3500);
        const tr = obs.track(NAME, t0).filter((x) => x.p.alive);
        const a = tr[0]!;
        const b = tr[tr.length - 1]!;
        const secs = (b.serverTime - a.serverTime) / 1000;
        const lost = a.p.hp - b.p.hp;
        notes.push(`tide drain ${a.p.hp} -> ${b.p.hp} over ${secs.toFixed(2)} s server time at 5 dps (vest tier ${a.p.vestTier} -> ${b.p.vestTier})`);
        // Whole damage ticks of zone.damageTickMs (1 s): floor or ceil of elapsed seconds, 5 HP each.
        expect(lost).toBeGreaterThanOrEqual(Math.floor(secs) * 5);
        expect(lost).toBeLessThanOrEqual(Math.ceil(secs) * 5);
        expect(b.p.vestTier).toBe(a.p.vestTier);
        // HUD agrees with the server within one damage tick (the HUD reads the same snapshots, ~100 ms later).
        const hud = await hpValue(page);
        expect(Math.abs(hud - obs.player(NAME)!.hp)).toBeLessThanOrEqual(5);
        await page.screenshot({ path: `${SHOTS}/gameplay-outside-tide.png` });
      } else {
        await expect(page.locator('.ui-outside')).toBeHidden();
      }
    });
  } finally {
    test.info().annotations.push({ type: 'notes', description: notes.join('\n') });
    console.log(notes.join('\n'));
    obs.close();
  }

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});
