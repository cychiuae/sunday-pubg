/**
 * M2c flows through the real browser client (qa-tester, Phase 3), island01 with LAYOUT_SEED pinned.
 *
 * Two browsers (A host, B guest) in one private island room. Loot tables are overridden so the beach is full of M2c
 * items (rifles, 2x scopes, smokes, frags, knives, RPGs and rockets). Checked:
 *   look line in the waiting room at the lock (same text on both); "Layout #" on the pause overlay equal to the pin;
 *   no layout-mismatch / console errors on either browser (the client verifies the server's layout hash);
 *   rifle pickup with its level badge (HUD numeral = server weaponLevel); a 2x scope mounts, T moves it to the pouch
 *   and back (server sight); 4 / G cycles frag <-> smoke and a smoke deploys (smokeDeployed); a knife hit on B
 *   (meleeHit + damage); an RPG shot (rocketFired, explosion).
 * The dev hook has no M2c fields yet (BUG-014), so server state comes from the observer and HUD state from the DOM.
 * Canvas screenshots: test-results/shots/m2c-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { calibrateLook, fetchLoot, look, me, turnTo, walkTo } from './support/drive';
import { createRoom, game, joinByCode, lockPointer, newPlayer, openTitle, SHOTS, startMatch, toBrowser, ui, unexpectedErrors, waitForMatch, type ConsoleLog } from './support/game';
import { dist2, Observer, yawTo } from './support/observer';
import { startStack, type Stack } from './support/stack';

const LAYOUT_SEED = 4821;
const ITEMS = [
  'ammo_heavy', 'ammo_light', 'ammo_rocket', 'ammo_shell', 'ammo_sniper', 'bandage', 'dbshotgun', 'dmr', 'grenade', 'helmet_1',
  'helmet_2', 'helmet_3', 'helmet_4', 'knife', 'lmg', 'machete', 'medkit', 'paddle', 'pistol', 'revolver', 'rifle', 'rpg', 'scope_2x',
  'scope_4x', 'scope_8x', 'scope_red_dot', 'shotgun', 'smg', 'smoke', 'sniper', 'vest_1', 'vest_2', 'vest_3', 'vest_4',
];
const ZERO = Object.fromEntries(ITEMS.map((i) => [i, 0]));
const M2C_LOOT = { ...ZERO, rifle: 3, scope_2x: 2, smoke: 2, grenade: 2, knife: 2, rpg: 2, ammo_rocket: 2 };

interface P { page: Page; log: ConsoleLog; name: string; close(): Promise<void> }
let stack: Stack;
let A: P;
let B: P;
let obs: Observer;
let code = '';
let radPerPx = 0.0022;
const notes: string[] = [];
/** Results of the smoke test, asserted in the smokeHidden test below it. */
const smoke = { checked: false, hookA: false, hookB: false };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  stack = await startStack({
    label: 'm2c-island',
    seed: 2024,
    layoutSeed: LAYOUT_SEED,
    balance: {
      match: { countdownSeconds: 6, resultsSeconds: 5, targetPlayers: 4 },
      bots: { reactionMs: 600_000 },
      loot: { spawnChance: 1, tiers: { common: M2C_LOOT, rare: M2C_LOOT, epic: M2C_LOOT } },
      zone: { phases: [{ waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.5, dps: 1 }] },
    },
  });
  const mk = async (name: string): Promise<P> => {
    const p = await newPlayer(browser, stack.baseURL);
    return { page: p.page, log: p.log, name, close: () => p.ctx.close() };
  };
  A = await mk('QA Alpha');
  B = await mk('QA Bravo');
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  obs?.close();
  await A?.close();
  await B?.close();
  await stack?.stop();
});

async function shot(p: P, label: string): Promise<void> {
  await p.page.locator('#app canvas').screenshot({ path: `${SHOTS}/m2c-${label}.png` });
}
async function locked(p: P): Promise<void> {
  if (!(await p.page.evaluate(() => document.pointerLockElement !== null))) expect(await lockPointer(p.page)).toBe(true);
}
const ev = (type: string, pred: (e: Record<string, unknown>) => boolean = () => true) => obs.eventsOf(type).filter((e) => pred(e as Record<string, unknown>));

test('waiting room: the look line appears at the lock with the same text on both browsers', async () => {
  await openTitle(A.page);
  await toBrowser(A.page, A.name);
  code = await createRoom(A.page, { visibility: 'private', map: 'island01', bots: true });
  await openTitle(B.page);
  await toBrowser(B.page, B.name);
  await joinByCode(B.page, code);
  await startMatch(A.page);
  const lookA = A.page.locator('.ui-look');
  await expect(lookA).toBeVisible({ timeout: 10_000 });
  await expect(B.page.locator('.ui-look')).toBeVisible({ timeout: 10_000 });
  const [ta, tb] = [await lookA.innerText(), await B.page.locator('.ui-look').innerText()];
  notes.push(`look line A "${ta.replace(/\s+/g, ' ')}" / B "${tb.replace(/\s+/g, ' ')}"`);
  expect(ta).toMatch(/forecast/i);
  expect(ta).toBe(tb);
  await A.page.screenshot({ path: `${SHOTS}/m2c-room-look.png` });
});

test('same pinned layout on both browsers: no mismatch or console errors; "Layout #" shows the pin on the pause overlay', async () => {
  await Promise.all([waitForMatch(A.page, 40_000), waitForMatch(B.page, 40_000)]);
  obs = await Observer.connect(stack.serverPort, code);
  await expect.poll(() => obs.latest?.match.mapId ?? null, { timeout: 10_000 }).toBe('island01');
  for (const p of [A, B]) await locked(p);
  // Both jump on the same tick-ish: same carrier point, no steering -> they land next to each other.
  await expect.poll(() => game(A.page, (g) => g.aboard), { timeout: 10_000 }).toBe(true);
  const until = Date.now() + 40_000;
  while (Date.now() < until && ((await game(A.page, (g) => g.aboard)) || (await game(B.page, (g) => g.aboard)))) {
    await Promise.all([A.page.keyboard.press('Space'), B.page.keyboard.press('Space')]);
    await A.page.waitForTimeout(150);
  }
  for (const p of [A, B]) await expect.poll(async () => (await me(obs, p.name)).anim.dropping || (await me(obs, p.name)).aboard, { timeout: 30_000 }).toBe(false);
  const [pa, pb] = [await me(obs, A.name), await me(obs, B.name)];
  notes.push(`landed A (${pa.pos.x.toFixed(1)}, ${pa.pos.z.toFixed(1)}) B (${pb.pos.x.toFixed(1)}, ${pb.pos.z.toFixed(1)}), ${dist2(pa.pos, pb.pos).toFixed(1)} m apart`);
  await shot(A, 'island-landed');
  // Pause overlay shows the layout code; both browsers show the same text.
  const codes: string[] = [];
  for (const p of [A, B]) {
    await p.page.evaluate(() => document.exitPointerLock());
    await expect(ui.play(p.page)).toBeVisible({ timeout: 5000 });
    const lc = p.page.locator('.ui-layoutcode:visible');
    await expect(lc).toBeVisible();
    codes.push((await lc.innerText()).trim());
  }
  await A.page.screenshot({ path: `${SHOTS}/m2c-pause-layoutcode.png` });
  notes.push(`layout code A "${codes[0]}" B "${codes[1]}"`);
  expect(codes[0]).toBe(codes[1]);
  expect(codes[0]).toMatch(new RegExp(`Layout #(${LAYOUT_SEED}|0x0*${LAYOUT_SEED.toString(16)})`, 'i'));
  // The client rebuilt the layout from the seed and its hash matches the server's (BUG-014 hook field).
  const lays = await Promise.all([A, B].map((p) => game(p.page, (g) => g.layout)));
  notes.push(`layout A ${JSON.stringify(lays[0])} / B hashMatched ${lays[1]?.hashMatched}`);
  for (const l of lays) {
    expect(l?.seed).toBe(LAYOUT_SEED);
    expect(l?.hashMatched).toBe(true);
    expect(l?.clientHash).toBe(l?.hash);
  }
  expect(lays[0]!.hash).toBe(lays[1]!.hash);
  for (const p of [A, B]) {
    expect(p.log.all.filter((l) => /layout mismatch|LayoutMismatch/i.test(l)), p.name).toEqual([]);
    expect(unexpectedErrors(p.log), p.log.all.join('\n')).toEqual([]);
    await locked(p);
  }
  radPerPx = await calibrateLook(A.page, obs, A.name);
});

test('melee: a knife hit on B (meleeHit + damage cause melee)', async () => {
  test.setTimeout(200_000);
  await locked(A);
  const got = await fetchLoot(A.page, obs, A.name, (l) => l.item === 'knife', radPerPx, notes, 30_000);
  expect(got, 'picked a knife').not.toBeNull();
  await A.page.keyboard.press('3');
  await expect.poll(async () => (await me(obs, A.name)).weapon, { timeout: 5000 }).toBe('knife');
  // Both walk toward each other (a single walker can stall on a prop between them).
  await locked(B);
  const radB = await calibrateLook(B.page, obs, B.name);
  const bPos = () => obs.player(B.name)?.pos ?? null;
  const aPos = () => obs.player(A.name)?.pos ?? null;
  const [d] = await Promise.all([
    walkTo(A.page, obs, A.name, bPos, 1.3, radPerPx, 60_000),
    walkTo(B.page, obs, B.name, aPos, 1.3, radB, 60_000),
  ]);
  notes.push(`walked to B: ${d.toFixed(2)} m (now ${dist2(obs.player(A.name)!.pos, obs.player(B.name)!.pos).toFixed(2)} m)`);
  const aId = obs.player(A.name)!.id;
  const bId = obs.player(B.name)!.id;
  let hits = 0;
  for (let i = 0; i < 6 && hits === 0; i++) {
    const a = await me(obs, A.name);
    await turnTo(A.page, obs, A.name, yawTo(a.pos, obs.player(B.name)!.pos), radPerPx);
    // One short click = one swing (holding LMB re-swings every cycle and would kill B, who is needed alive later).
    await A.page.mouse.down();
    await A.page.waitForTimeout(60);
    await A.page.mouse.up();
    const until = Date.now() + 1500;
    while (Date.now() < until && hits === 0) {
      await A.page.waitForTimeout(100);
      hits = ev('damage', (e) => e.attackerId === aId && e.victimId === bId).length;
    }
  }
  expect(hits, 'exactly one knife hit').toBe(1);
  await expect.poll(async () => (await me(obs, B.name)).alive, { timeout: 3000 }).toBe(true);
  await shot(A, 'melee-hit');
  const dmg = ev('damage', (e) => e.attackerId === aId && e.victimId === bId)[0];
  notes.push(`melee: swings ${ev('meleeSwing', (e) => e.playerId === aId).length}, damage ${JSON.stringify(dmg)}`);
  expect(dmg, 'knife damage on B').toBeDefined();
  expect(dmg!.weapon).toBe('knife');
  expect(ev('meleeSwing', (e) => e.playerId === aId).length).toBeGreaterThan(0);
});

test('pick up a rifle: the slot shows the level badge equal to the server weaponLevel', async () => {
  test.setTimeout(150_000);
  await locked(A);
  const got = await fetchLoot(A.page, obs, A.name, (l) => l.item === 'rifle', radPerPx, notes, 30_000);
  expect(got, 'picked a rifle').not.toBeNull();
  await A.page.keyboard.press('1');
  await expect.poll(async () => (await me(obs, A.name)).weapon, { timeout: 5000 }).toBe('rifle');
  const lvl = (await me(obs, A.name)) as unknown as { weaponLevel: number | null };
  expect(lvl.weaponLevel).toBeGreaterThanOrEqual(1);
  const badge = A.page.locator('.ui-slot').first().locator('.ui-slot__badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(String(lvl.weaponLevel));
  notes.push(`rifle level ${lvl.weaponLevel}, badge "${(await badge.innerText()).replace(/\s+/g, ' ')}"`);
  // Hook (BUG-014): the held level and slot 0 agree with the server.
  expect(await game(A.page, (g) => g.weaponLevel)).toBe(lvl.weaponLevel);
  expect(await game(A.page, (g) => g.localSlots[0]?.level ?? null)).toBe(lvl.weaponLevel);
  await A.page.locator('.ui-hud__br, .ui-slots').first().screenshot({ path: `${SHOTS}/m2c-level-badge.png` }).catch(() => {});
  await shot(A, 'rifle-level');
});

test('2x scope mounts on the rifle; T moves it to the pouch (red dot back) and T mounts it again', async () => {
  test.setTimeout(150_000);
  await locked(A);
  const got = await fetchLoot(A.page, obs, A.name, (l) => l.item === 'scope_2x', radPerPx, notes, 30_000);
  expect(got, 'picked a 2x').not.toBeNull();
  const sight = async (): Promise<string> => ((await me(obs, A.name)) as unknown as { sight: string }).sight;
  await A.page.keyboard.press('1');
  await expect.poll(sight, { timeout: 5000 }).toBe('scope_2x');
  await A.page.keyboard.press('t');
  await expect.poll(sight, { timeout: 5000 }).toBe('red_dot');
  await expect(A.page.locator('.ui-pouch')).toBeVisible();
  await shot(A, 'scope-pouch');
  await A.page.keyboard.press('t');
  await expect.poll(sight, { timeout: 5000 }).toBe('scope_2x');
  expect(ev('scopeChanged', (e) => e.playerId === (obs.player(A.name)?.id ?? -1)).length).toBeGreaterThanOrEqual(2);
  await A.page.mouse.down({ button: 'right' });
  await A.page.waitForTimeout(800);
  await shot(A, 'scope-2x-ads');
  await A.page.mouse.up({ button: 'right' });
});

test('throwables: 4 / G cycles frag <-> smoke; a smoke deploys and lies between A and B (client rule says hidden)', async () => {
  test.setTimeout(420_000);
  await locked(A);
  for (const item of ['smoke', 'grenade']) {
    const got = await fetchLoot(A.page, obs, A.name, (l) => l.item === item, radPerPx, notes, 30_000);
    expect(got, `picked ${item}`).not.toBeNull();
  }
  const slot4 = A.page.locator('.ui-slot').nth(3);
  await A.page.keyboard.press('4');
  await A.page.waitForTimeout(600);
  const t1 = (await slot4.innerText()).replace(/\s+/g, ' ');
  await A.page.keyboard.press('4');
  await A.page.waitForTimeout(600);
  const t2 = (await slot4.innerText()).replace(/\s+/g, ' ');
  notes.push(`throwable slot: "${t1}" -> "${t2}"`);
  expect(t1).not.toBe(t2);
  // throwableCycled is a client GameEvent (predicted), not a SimEvent; the HUD text change above is the evidence.
  expect(/smoke/i.test(t1) !== /smoke/i.test(t2)).toBe(true);
  // Make sure smoke is selected (hook field, predicted).
  if ((await game(A.page, (g) => g.selectedThrowable)) !== 'smoke') {
    await A.page.keyboard.press('4');
    await expect.poll(() => game(A.page, (g) => g.selectedThrowable), { timeout: 3000 }).toBe('smoke');
  }
  // smoke.md 11 / M2C-UI-21..23: put the cloud between A and B. B moves at least 16 m away from A; A faces B and throws
  // level (the canister lands about 8 m out; the opaque radius is 6.5 m, so it covers the line of sight).
  await locked(B);
  const radB = await calibrateLook(B.page, obs, B.name);
  const a0 = (await me(obs, A.name)).pos;
  const b0 = (await me(obs, B.name)).pos;
  const d0 = dist2(a0, b0);
  if (d0 < 16) {
    const ux = (b0.x - a0.x) / (d0 || 1);
    const uz = (b0.z - a0.z) / (d0 || 1);
    const away = { x: a0.x + (ux || 1) * 20, y: 0, z: a0.z + uz * 20 };
    await walkTo(B.page, obs, B.name, () => away, 1.5, radB, 40_000);
  } else if (d0 > 24) {
    // A walks to 18 m from B (A has been the reliable walker in this spec).
    const spot = () => {
      const a = obs.player(A.name)!.pos;
      const b = obs.player(B.name)!.pos;
      const d = dist2(a, b) || 1;
      return { x: b.x + ((a.x - b.x) / d) * 18, y: 0, z: b.z + ((a.z - b.z) / d) * 18 };
    };
    await walkTo(A.page, obs, A.name, spot, 2, radPerPx, 120_000);
  }
  const aP = (await me(obs, A.name)).pos;
  const bP = (await me(obs, B.name)).pos;
  notes.push(`smoke line: A-B ${dist2(aP, bP).toFixed(1)} m`);
  await turnTo(A.page, obs, A.name, yawTo(aP, bP), radPerPx);
  // Level the aim (movementY > 0 looks down), in <= 200 px steps (the BUG-002 spike filter clips single moves > 300 px).
  for (let i = 0; i < 6; i++) {
    const pitch = await game(A.page, (g) => g.localPitch);
    if (Math.abs(pitch) < 0.03) break;
    await look(A.page, 0, Math.max(-200, Math.min(200, pitch / radPerPx)));
    await A.page.waitForTimeout(150);
  }
  const aId = obs.player(A.name)!.id;
  const bId = obs.player(B.name)!.id;
  // Both must be alive for the smoke check (a dead player is never smoke-hidden; smoke.md).
  expect(await game(A.page, (g) => g.players.find((p) => p.name === 'QA Bravo')?.alive ?? null), 'B alive on A').toBe(true);
  expect(await game(B.page, (g) => g.localAlive), 'B alive (own client)').toBe(true);
  const hiddenBefore = await game(A.page, (g) => g.players.find((p) => p.name === 'QA Bravo')?.smokeHidden ?? null);
  await A.page.mouse.down();
  await A.page.waitForTimeout(300);
  await A.page.mouse.up();
  await expect.poll(() => ev('smokeDeployed', (e) => e.ownerId === aId).length, { timeout: 8000 }).toBe(1);
  await expect.poll(() => ((obs.latest as unknown as { smokes?: unknown[] }).smokes ?? []).length, { timeout: 3000 }).toBeGreaterThan(0);
  await expect.poll(() => game(A.page, (g) => g.smokes.length), { timeout: 3000 }).toBeGreaterThan(0);
  // Where did the cloud land relative to the A-B line? (logged; a throw that misses the line is a harness problem)
  const c0 = await game(A.page, (g) => g.smokes[0] ?? null);
  if (c0) {
    const a = obs.player(A.name)!.pos;
    const b = obs.player(B.name)!.pos;
    const L = dist2(a, b) || 1;
    const t = Math.max(0, Math.min(1, ((c0.center.x - a.x) * (b.x - a.x) + (c0.center.z - a.z) * (b.z - a.z)) / (L * L)));
    const off = Math.hypot(a.x + (b.x - a.x) * t - c0.center.x, a.z + (b.z - a.z) * t - c0.center.z);
    notes.push(`cloud at ${(t * L).toFixed(1)} m along A-B (${L.toFixed(1)} m), ${off.toFixed(2)} m off the line`);
  }
  // Once the cloud has grown (1.5 s), A's view of B is hidden (name tag, outline), and B's view of A.
  // Wherever the canister settled, put the cloud between A and B: A walks to 3 m beyond the cloud edge on the side away
  // from B (the cloud holds about 18 s). A throw can bounce off a prop, so the throw itself is not trusted to land on
  // the line.
  {
    const c = await game(A.page, (g) => g.smokes[0]?.center ?? null);
    if (c) {
      const b = obs.player(B.name)!.pos;
      const L = Math.hypot(c.x - b.x, c.z - b.z) || 1;
      const spot = { x: c.x + ((c.x - b.x) / L) * 9.5, y: 0, z: c.z + ((c.z - b.z) / L) * 9.5 };
      const dd = await walkTo(A.page, obs, A.name, () => spot, 1.5, radPerPx, 14_000);
      notes.push(`moved A behind the cloud: ${dd.toFixed(2)} m from the spot`);
    }
  }
  await A.page.waitForTimeout(500);
  const diag = await game(A.page, (g) => {
    const b = g.players.find((p) => p.name === 'QA Bravo');
    return { now: g.serverTime, eyeH: g.cameraEyeHeight, me: g.localPos, b: b ? { pos: b.pos, hidden: b.smokeHidden, stance: b.stance, alive: b.alive } : null, smokes: g.smokes, inSmoke: g.inSmoke, view: g.cameraView, spectate: g.spectateTargetId };
  });
  // The client's own rule on the hook's numbers (dynamic import from the Vite dev server).
  const ruleSays = await A.page.evaluate(async () => {
    const SV = '/src/game/smokeView.ts';
    const BAL = '/src/shared/balance.ts';
    const sv = (await import(/* @vite-ignore */ SV)) as { hiddenBySmoke: (...a: unknown[]) => boolean };
    const bal = (await import(/* @vite-ignore */ BAL)) as { BALANCE: { items: { smoke: { cloud: unknown } } } };
    const g = (window as unknown as { __game: { serverTime: number; localPos: { x: number; y: number; z: number }; cameraEyeHeight: number; players: { name: string; pos: { x: number; y: number; z: number } }[]; smokes: { id: number; ownerId: number; pos: unknown; deployedAt: number; fadeAt: number }[] } }).__game;
    const b = g.players.find((p) => p.name === 'QA Bravo')!;
    const cam = { x: g.localPos.x, y: g.localPos.y + g.cameraEyeHeight, z: g.localPos.z };
    const clouds = g.smokes.map((c) => ({ id: c.id, ownerId: c.ownerId, pos: c.pos, deployedAt: c.deployedAt, fadeAt: c.fadeAt }));
    const head = { x: b.pos.x, y: b.pos.y + 1.05, z: b.pos.z };
    const chest = { x: b.pos.x, y: b.pos.y + 0.65, z: b.pos.z };
    return { rule: sv.hiddenBySmoke(clouds, cam, head, chest, g.serverTime, bal.BALANCE.items.smoke.cloud), now: g.serverTime, clouds };
  });
  notes.push(`client rule on hook numbers: hiddenBySmoke = ${ruleSays.rule}; now ${ruleSays.now}; clouds ${JSON.stringify(ruleSays.clouds)}`);
  if (diag.me && diag.b && diag.smokes[0]) {
    const cam = { x: diag.me.x, y: diag.me.y + (diag.eyeH ?? 1.05), z: diag.me.z };
    const head = { x: diag.b.pos.x, y: diag.b.pos.y + 1.05, z: diag.b.pos.z };
    const c = diag.smokes[0].center;
    const d = { x: head.x - cam.x, y: head.y - cam.y, z: head.z - cam.z };
    const len2 = d.x * d.x + d.y * d.y + d.z * d.z;
    const u = Math.max(0, Math.min(1, ((c.x - cam.x) * d.x + (c.y - cam.y) * d.y + (c.z - cam.z) * d.z) / len2));
    const off = Math.hypot(cam.x + d.x * u - c.x, cam.y + d.y * u - c.y, cam.z + d.z * u - c.z);
    notes.push(`smoke diag: view ${diag.view}, inSmoke ${diag.inSmoke}, cloud r ${diag.smokes[0].radius.toFixed(2)} centre (${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)}), A eye (${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, ${cam.z.toFixed(1)}), B (${diag.b.pos.x.toFixed(1)}, ${diag.b.pos.z.toFixed(1)}) ${diag.b.stance}, closest approach of eye->head ${off.toFixed(2)} m, hook smokeHidden ${diag.b.hidden}, B alive ${diag.b.alive}, A spectateTargetId ${diag.spectate}`);
  }
  // The geometry is right when the client's own rule says hidden; the hook value is checked in the smokeHidden test below.
  expect(ruleSays.rule, 'cloud between A and B (client rule on the hook numbers)').toBe(true);
  const bSpectating = await game(B.page, (g) => ({ alive: g.localAlive, spectate: g.spectateTargetId }));
  notes.push(`B client: alive ${bSpectating.alive}, spectateTargetId ${bSpectating.spectate}`);
  expect(bSpectating.alive).toBe(true);
  for (let i = 0; i < 12 && !smoke.hookA; i++) {
    smoke.hookA = (await game(A.page, (g) => g.players.find((p) => p.name === 'QA Bravo')?.smokeHidden ?? null)) === true;
    smoke.hookB = (await game(B.page, (g) => g.players.find((p) => p.name === 'QA Alpha')?.smokeHidden ?? null)) === true;
    await A.page.waitForTimeout(500);
  }
  smoke.checked = true;
  const cloud = await game(A.page, (g) => g.smokes[0]);
  notes.push(`smokeHidden: before ${hiddenBefore}, hook after: A sees B hidden ${smoke.hookA}, B sees A hidden ${smoke.hookB}; cloud ${JSON.stringify(cloud)}; ids A ${aId} B ${bId}`);
  expect(hiddenBefore).toBe(false);
  await A.page.waitForTimeout(1500);
  await shot(A, 'smoke-cloud');
  await B.page.locator('#app canvas').screenshot({ path: `${SHOTS}/m2c-smoke-from-b.png` });
});

test('smoke.md 11: with the cloud between them (both alive), each browser hides the other (PlayerView.smokeHidden)', async () => {
  expect(smoke.checked, 'the smoke test ran').toBe(true);
  expect(smoke.hookA, "A's view of B").toBe(true);
  expect(smoke.hookB, "B's view of A").toBe(true);
});

test('RPG: fire at the ground ahead: rocketFired then an explosion from A', async () => {
  test.setTimeout(200_000);
  await locked(A);
  const got = await fetchLoot(A.page, obs, A.name, (l) => l.item === 'rpg', radPerPx, notes, 30_000);
  expect(got, 'picked an rpg').not.toBeNull();
  await fetchLoot(A.page, obs, A.name, (l) => l.item === 'ammo_rocket', radPerPx, notes, 30_000);
  for (const k of ['2', '1']) {
    if ((await me(obs, A.name)).weapon === 'rpg') break;
    await A.page.keyboard.press(k);
    await A.page.waitForTimeout(700);
  }
  await expect.poll(async () => (await me(obs, A.name)).weapon, { timeout: 5000 }).toBe('rpg');
  const p = await me(obs, A.name);
  // Face away from B and aim at the ground about 25 m ahead (past the arming distance).
  const b = obs.player(B.name)!.pos;
  await turnTo(A.page, obs, A.name, yawTo(b, p.pos), radPerPx);
  await look(A.page, 0, 60);
  const aId = p.id;
  await A.page.mouse.down();
  await A.page.waitForTimeout(150);
  await A.page.mouse.up();
  await expect.poll(() => ev('rocketFired', (e) => e.ownerId === aId).length, { timeout: 8000 }).toBe(1);
  await A.page.waitForTimeout(250);
  await shot(A, 'rpg-flight');
  await expect.poll(() => ev('explosion', (e) => e.source === 'rocket' || e.ownerId === aId).length + ev('rocketDud', (e) => e.ownerId === aId).length, { timeout: 8000 }).toBeGreaterThan(0);
  const exp = ev('explosion', (e) => e.source === 'rocket');
  notes.push(`rpg: rocketFired ${ev('rocketFired').length}, rocket explosions ${exp.length}, duds ${ev('rocketDud').length}`);
  expect(exp.length).toBeGreaterThan(0);
  await shot(A, 'rpg-explosion');
  for (const q of [A, B]) expect(unexpectedErrors(q.log), q.log.all.join('\n')).toEqual([]);
});
