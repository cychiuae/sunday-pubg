/**
 * M2a exploratory edge cases (qa-tester, 2a-D1). Each test probes a corner the specs name only in passing: stuck
 * states, NaN, refused or silently dropped actions, and bot use of the new content. Findings that fail here are filed
 * as bugs in docs/qa/bugs/ and referenced by id in the test title.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../../src/shared/balance';
import { BALANCE } from '../../src/shared/balance';
import { SIM_DT } from '../../src/shared/constants';
import type { GunId, IslandMapData, MapData, MovementState, PlayerState, PropPlacement, SimEvent, WorldSnapshot } from '../../src/shared/types';
import { ISLAND } from '../../src/game/levels/island';
import { balanceWith, flatMap, land, noSpreadBalance, playingWorld, run } from '../../src/shared/sim/testkit';
import { createDebugWorld, type DebugWorld } from '../../src/shared/sim/World';
import { createMovementContext, initialMovementState, stepMovement } from '../../src/shared/sim/movement';
import { rayHitbox } from '../../src/shared/sim/stance';
import { heightAt } from '../../src/shared/sim/terrain';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const ticks = (ms: number): number => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);
const GROUND = 2;
const EYE_Y = GROUND + BALANCE.player.eyeHeight;
const BIG = (props: PropPlacement[] = [], over: Partial<IslandMapData> = {}): IslandMapData =>
  flatMap({ islandRadius: 300, worldRadius: 330, ...over }, props);
const BOT_NAMES = Array.from({ length: 24 }, (_, i) => `Bot ${i}`);

function thrower(opts: { map?: MapData; balance?: Balance; players?: number } = {}) {
  const { w, ids } = playingWorld(opts.players ?? 2, { map: opts.map ?? BIG(), balance: opts.balance });
  ids.forEach((id, i) => land(w, id, i * 40, 0));
  const id = ids[0]!;
  const p = w.debugPlayer(id)!;
  p.inv.grenades = 2;
  p.inv.activeSlot = 3;
  return { w, ids, id, p };
}

/** Every number in a value is finite (recursively). Returns the first bad path, or null. */
function firstNonFinite(v: unknown, path = '$'): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} = ${v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = firstNonFinite(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // Infinity is a legitimate sentinel in a few places (e.g. lastShotAt = -Infinity before the first shot).
      const r = firstNonFinite(x, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

describe('stance edge cases', () => {
  it('prone, crawling into deep water: forced stand fires once (public stanceChange), ends standing, no NaN', () => {
    // Shallow shelf at -0.1 dipping to -0.4 ahead (-Z).
    const map = flatMap({ islandRadius: 300, worldRadius: 330, baseHeight: -0.1, hills: [{ x: 0, z: -8, radius: 6, height: -0.3 }] });
    const { w, ids } = playingWorld(2, { map });
    const [a, b] = ids as [number, number];
    const pa = w.debugPlayer(a)!;
    pa.move = initialMovementState({ x: 0, y: -0.1, z: 0 }, false);
    w.debugPlayer(b)!.move = initialMovementState({ x: 60, y: -0.1, z: 60 }, false);
    run(w, ticks(700), { [a]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null }) });
    expect(pa.move.stance).toBe('prone');
    const ev = run(w, 300, { [a]: () => ({ moveForward: 1 }) });
    const forced = ofType(ev, 'stanceChange').filter((e) => e.playerId === a && e.forced);
    expect(forced.length).toBe(1);
    expect(forced[0]).toMatchObject({ from: 'prone', to: 'stand' });
    expect(pa.move.stance).toBe('stand');
    expect(pa.move.stanceMs).toBe(0);
    expect(firstNonFinite(pa.move)).toBeNull();
    // Z again in the deep part is refused, and the refusal is private (actionFailed).
    pa.move = initialMovementState({ x: 0, y: -0.4, z: -8 }, false);
    const z = run(w, 1, { [a]: () => ({ stanceToggle: 'prone' }) });
    expect(ofType(z, 'actionFailed')[0]).toMatchObject({ playerId: a, action: 'stance', reason: 'tooDeep' });
    expect(pa.move.stance).toBe('stand');
  });

  it('hut: a prone player hugging each wall of a hut can stand up (the hut is a solid prism, no false noHeadroom)', () => {
    const hut: PropPlacement = { kind: 'hut', x: 0, z: 0, rotY: 0.3, scale: 1 };
    const ctx = createMovementContext(BIG([hut]), BALANCE);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7]] as const) {
      // Walk prone into the wall until push-out holds us against it, then stand.
      let s: MovementState = { ...initialMovementState({ x: dx * 6, y: GROUND, z: dz * 6 }, false), stance: 'prone', stanceFrom: 'prone' };
      const yaw = Math.atan2(dx, dz); // face the hut centre (forward = (-sin yaw, -cos yaw))
      for (let i = 0; i < 200; i++) {
        s = stepMovement(s, { moveForward: 1, moveRight: 0, yaw, jump: false, sprint: false, speedMultiplier: 1, canSprint: true, stanceToggle: null, ads: false, held: 'fists', adsBlocked: false }, SIM_DT, ctx).state;
      }
      const r = stepMovement(s, { moveForward: 0, moveRight: 0, yaw, jump: false, sprint: false, speedMultiplier: 1, canSprint: true, stanceToggle: 'prone', ads: false, held: 'fists', adsBlocked: false }, SIM_DT, ctx);
      expect(r.stanceRefused, `side ${dx},${dz}`).toBeNull();
      expect(r.state.stance).toBe('stand');
      // And nobody can get under the roof: every hut collider is ground-rooted, so the player stays outside the walls.
      const local = Math.hypot(s.pos.x, s.pos.z);
      expect(local).toBeGreaterThan(2.05);
    }
    const huts = ctx.colliders.colliders.filter((c) => c.prop === 0);
    expect(huts.every((c) => c.bottom === -Infinity), 'no raised hut part a player could stand under').toBe(true);
  });

  it('raised palm trunk segments (the only floating colliders on the island) are far above a standing player', () => {
    const ctx = createMovementContext(ISLAND, BALANCE);
    const raised = ctx.colliders.colliders.filter((c) => c.bottom !== -Infinity);
    expect(raised.length).toBeGreaterThan(0);
    // Headroom can only trigger under a raised part whose bottom is lower than base + stand height + margin. On the
    // shipped island none is, so the headroom rule never fires in play (informational; see BUG-005).
    const lowest = Math.min(...raised.map((c) => c.bottom - Math.max(0, heightAt(c.x, c.z, ISLAND))));
    expect(lowest).toBeGreaterThan(BALANCE.movement.stances.stand.height + BALANCE.movement.stances.headroomMargin);
  });

  it('prone hitbox vs a crawling target: the box follows yaw on the server (shots along the body hit, across miss)', () => {
    const { w, ids } = playingWorld(2, { map: BIG(), balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -10);
    const tp = w.debugPlayer(t)!;
    // Target goes prone facing +X (yaw -90 deg): its 1.5 m box lies along X, 0.8 m wide along Z.
    run(w, ticks(700), { [t]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null, yaw: -Math.PI / 2 }) });
    expect(tp.move.stance).toBe('prone');
    expect(tp.move.stanceMs).toBe(0);
    // Vertical rays through the server's own hitbox for this player: 0.6 m along +X is the head end, 0.6 m along -X
    // the body, and 0.5 m to the side (|across| > proneWidth / 2) misses.
    const down = (x: number, z: number) =>
      rayHitbox({ x, y: GROUND + 5, z }, { x: 0, y: -1, z: 0 }, 10, tp.move.pos, tp.yaw, tp.move, BALANCE);
    expect(down(0.6, -10)).toMatchObject({ headshot: true });
    expect(down(-0.6, -10)).toMatchObject({ headshot: false });
    expect(down(0, -10.5)).toBeNull();
    expect(down(0, -9.5)).toBeNull();
    // And a real World shot at the body end from the shooter hits (the World uses the same box).
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    sp.inv.activeSlot = 0;
    const pitch = Math.atan2(GROUND + 0.25 - EYE_Y, 10 - 0.4);
    const ev = run(w, 2, { [s]: (i) => ({ fire: i === 0, pitch }), [t]: () => ({ yaw: -Math.PI / 2 }) });
    expect(ofType(ev, 'damage').filter((e) => e.victimId === t).length).toBe(1);
  });

  it('rapid C/Z/Space mashing never leaves a stuck or NaN movement state and always settles', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    const keys = ['crouch', 'prone', null] as const;
    for (let i = 0; i < 600; i++) {
      run(w, 1, { [id]: () => ({ stanceToggle: keys[(i * 7) % 3]!, jump: i % 5 === 0, sprint: i % 11 < 3, moveForward: 1, ads: i % 4 === 0 }) });
      expect(firstNonFinite(p.move), `tick ${i}`).toBeNull();
      expect(p.move.stanceMs).toBeGreaterThanOrEqual(0);
    }
    run(w, ticks(800), { [id]: () => ({}) });
    expect(p.move.stanceMs).toBe(0);
    expect(p.move.stanceFrom).toBe(p.move.stance);
  });
});

describe('grenade edge cases', () => {
  it('cook-out in hand with vest_3 survivor: no entity left behind, one grenade spent, still holding the grenade, can cook again', () => {
    const t = thrower();
    t.p.vest = { tier: 3, durability: 75 };
    t.p.hp = 100;
    const ev = run(t.w, ticks(3600), { [t.id]: () => ({ fire: true }) });
    expect(ofType(ev, 'explosion').filter((e) => e.inHand).length).toBe(1);
    expect(t.p.alive).toBe(true);
    expect(t.w.debugGrenades().length).toBe(0);
    expect(t.p.cook).toBeNull();
    expect(t.p.inv.grenades).toBe(1);
    expect(t.p.inv.activeSlot).toBe(3);
    // Release, wait out the recovery, press again: a new cook starts.
    run(t.w, ticks(BALANCE.items.grenade.throwRecoveryMs) + 2, { [t.id]: () => ({ fire: false }) });
    const again = run(t.w, 1, { [t.id]: () => ({ fire: true }) });
    expect(ofType(again, 'grenadeCook').length).toBe(1);
  });

  it('cooking the last grenade into a cook-out (survivor) auto-switches to the last gun slot', () => {
    const t = thrower();
    t.p.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    t.p.lastGunSlot = 0;
    t.p.inv.grenades = 1;
    t.p.vest = { tier: 3, durability: 75 };
    const ev = run(t.w, ticks(3600), { [t.id]: () => ({ fire: true }) });
    expect(ofType(ev, 'explosion').length).toBe(1);
    expect(t.p.inv.grenades).toBe(0);
    expect(t.p.inv.activeSlot).toBe(0);
  });

  it('switching to an EMPTY gun slot while cooking: nothing is dropped, the cook continues, release still throws', () => {
    const t = thrower();
    t.p.inv.slots = [null, null];
    run(t.w, ticks(500), { [t.id]: () => ({ fire: true }) });
    const sw = run(t.w, 1, { [t.id]: () => ({ fire: true, selectSlot: 0 }) });
    expect(ofType(sw, 'grenadeThrown').length).toBe(0);
    expect(t.p.cook).not.toBeNull();
    const rel = run(t.w, 1, { [t.id]: () => ({ fire: false }) });
    expect(ofType(rel, 'grenadeThrown')[0]).toMatchObject({ dropped: false });
  });

  it('switching to fists (slot 3 key) while cooking drops the grenade with the remaining fuse', () => {
    const t = thrower();
    run(t.w, ticks(1000), { [t.id]: () => ({ fire: true }) });
    const cookAt = t.p.cook!.explodesAt;
    const sw = run(t.w, 1, { [t.id]: () => ({ fire: true, selectSlot: 2 }) });
    const g = ofType(sw, 'grenadeThrown')[0]!;
    expect(g).toMatchObject({ dropped: true, explodesAt: cookAt });
    expect(t.p.inv.activeSlot).toBe(2);
  });

  it('shot dead while cooking: the grenade drops at the eye, explodes on its fuse, credits the dead owner for a kill', () => {
    const t = thrower({ balance: noSpreadBalance(), players: 3 });
    const [, shooter, victim] = t.ids as [number, number, number];
    land(t.w, shooter, 0, -20);
    land(t.w, victim, 2, 0);
    const vp = t.w.debugPlayer(victim)!;
    vp.hp = 30;
    const sp = t.w.debugPlayer(shooter)!;
    sp.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    sp.inv.activeSlot = 0;
    t.p.hp = 10;
    run(t.w, ticks(500), { [t.id]: () => ({ fire: true }) });
    expect(t.p.cook).not.toBeNull();
    // Shooter faces +Z toward the thrower (yaw pi), body shot.
    const pitch = Math.atan2(GROUND + 0.5 - EYE_Y, 20 - BALANCE.player.radius);
    const ev = run(t.w, 2, { [t.id]: () => ({ fire: true }), [shooter]: (i) => ({ fire: i === 0, yaw: Math.PI, pitch }) });
    expect(t.p.alive).toBe(false);
    const dropped = ofType(ev, 'grenadeThrown')[0]!;
    expect(dropped).toMatchObject({ dropped: true, ownerId: t.id });
    const later = run(t.w, ticks(3200), { [shooter]: () => ({}) });
    expect(ofType(later, 'explosion').length).toBe(1);
    const k = ofType(later, 'kill').find((e) => e.victimId === victim);
    expect(k).toMatchObject({ killerId: t.id, weapon: 'grenade' });
  });

  it('disconnect while cooking: the grenade drops at the eye with the remaining fuse and still explodes', () => {
    const t = thrower({ players: 3 });
    run(t.w, ticks(1000), { [t.id]: () => ({ fire: true }) });
    const at = t.p.cook!.explodesAt;
    t.w.removePlayer(t.id);
    const ev = run(t.w, ticks(2700));
    expect(ofType(ev, 'explosion').length).toBe(1);
    expect(t.w.debugGrenades().length).toBe(0);
    expect(t.w.timeMs).toBeGreaterThanOrEqual(at);
    expect(t.w.debugLoot().find((l) => l.item === 'grenade')!.qty).toBe(1);
  });

  it('a stance toggle mid-cook keeps the cook, and the release throws from the new eye height', () => {
    const t = thrower();
    const ev = run(t.w, ticks(1200), { [t.id]: (i) => ({ fire: true, stanceToggle: i === 2 ? 'prone' : null }) });
    expect(ofType(ev, 'stanceChange').length).toBe(1);
    expect(t.p.cook).not.toBeNull();
    const rel = ofType(run(t.w, 1, { [t.id]: () => ({ fire: false }) }), 'grenadeThrown')[0]!;
    expect(rel.dropped).toBe(false);
    expect(rel.pos.y).toBeLessThan(GROUND + BALANCE.movement.stances.crouch.eyeHeight);
  });

  it('a pin pull is refused while a stance transition runs, and works after it settles', () => {
    const t = thrower();
    const ev = run(t.w, 3, { [t.id]: (i) => ({ stanceToggle: i === 0 ? 'crouch' : null, fire: i === 1 }) });
    expect(ofType(ev, 'grenadeCook').length).toBe(0);
    run(t.w, ticks(300), { [t.id]: () => ({ fire: false }) });
    expect(ofType(run(t.w, 1, { [t.id]: () => ({ fire: true }) }), 'grenadeCook').length).toBe(1);
  });

  it('a thrown grenade bounces off a crate wall (prop contact, horizontal velocity reverses)', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -4, rotY: 0, scale: 1 };
    const t = thrower({ map: BIG([crate]) });
    land(t.w, t.id, 0, 0);
    // Straight at the crate face (z = -3.5) at mid height.
    t.w.debugSpawnGrenade(t.id, { x: 0, y: GROUND + 0.5, z: -2 }, { x: 0, y: 0, z: -10 }, 3000);
    const ev = run(t.w, 30);
    const prop = ofType(ev, 'grenadeBounce').filter((e) => e.surface === 'prop');
    expect(prop.length).toBeGreaterThanOrEqual(1);
    const g = t.w.debugGrenades()[0]!;
    expect(g.body.pos.z).toBeGreaterThan(-3.5);
    expect(firstNonFinite(g.body)).toBeNull();
  });

  it('a grenade thrown point-blank into a hut wall never ends up inside the hut', () => {
    const hut: PropPlacement = { kind: 'hut', x: 0, z: -5, rotY: 0, scale: 1 };
    const t = thrower({ map: BIG([hut]) });
    land(t.w, t.id, 0, -5 + 2.05 + BALANCE.player.radius + 0.01);
    t.p.yaw = 0;
    const ev = run(t.w, 3, { [t.id]: (i) => ({ fire: i === 0, pitch: 0.2, yaw: 0 }) });
    expect(ofType(ev, 'grenadeThrown').length).toBe(1);
    run(t.w, 60);
    const g = t.w.debugGrenades()[0];
    if (g) {
      const inside = Math.abs(g.body.pos.x) < 2.05 && Math.abs(g.body.pos.z + 5) < 2.05 && g.body.pos.y < GROUND + 3.3;
      expect(inside, JSON.stringify(g.body.pos)).toBe(false);
    }
  });
});

describe('armor edge cases', () => {
  it('helmet swap drops the old helmet with its exact durability; picking it back up is refused (lower tier)', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 50, 0);
    const p = w.debugPlayer(id)!;
    p.helmet = { tier: 1, durability: 7.25 };
    w.debugLoot().push({ id: 920, item: 'helmet_3', qty: 1, mag: null, pos: { x: 0, y: GROUND, z: 0.3 }, tier: 'epic', durability: 40 });
    run(w, 1, { [id]: () => ({ interact: true }) });
    expect(p.helmet).toEqual({ tier: 3, durability: 40 });
    const old = w.debugLoot().find((l) => l.item === 'helmet_1')!;
    expect(old.durability).toBe(7.25);
    old.pos = { x: 0, y: GROUND, z: 0.2 };
    const ev = run(w, 2, { [id]: (i) => ({ interact: i === 1 }) });
    expect(ofType(ev, 'actionFailed')[0]).toMatchObject({ reason: 'betterArmor' });
  });

  it('a broken vest (null) lets a same-tier pickup through', () => {
    const d = playingWorld(2, { map: BIG(), balance: noSpreadBalance() });
    const [s, t] = d.ids as [number, number];
    land(d.w, s, 0, 0);
    land(d.w, t, 0, -10);
    const tp = d.w.debugPlayer(t)!;
    tp.vest = { tier: 2, durability: 0.5 };
    tp.hp = 1e6;
    const sp = d.w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    sp.inv.activeSlot = 0;
    run(d.w, 2, { [s]: (i) => ({ fire: i === 0, pitch: Math.atan2(GROUND + 0.5 - EYE_Y, 10 - BALANCE.player.radius) }) });
    expect(tp.vest).toBeNull();
    d.w.debugLoot().push({ id: 930, item: 'vest_2', qty: 1, mag: null, pos: { x: 0, y: GROUND, z: -9.7 }, tier: 'rare', durability: 55 });
    run(d.w, 1, { [t]: () => ({ interact: true }) });
    expect(tp.vest).toEqual({ tier: 2, durability: 55 });
  });
});

describe('ADS and new-gun edge cases', () => {
  function armed(gun: GunId) {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 80, 80);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: gun, mag: BALANCE.weapons[gun].magSize };
    p.inv.activeSlot = 0;
    p.inv.ammo[BALANCE.weapons[gun].ammo!] = 100;
    return { w, id, p };
  }
  const speed = (p: { move: { vel: { x: number; z: number } } }): number => Math.hypot(p.move.vel.x, p.move.vel.z);

  it('ADS blocked while healing (adsMs 0, anim.ads false) and while reloading; sprint + ADS walks at walk x adsMove', () => {
    const a = armed('rifle');
    a.p.hp = 50;
    a.p.inv.heals.bandage = 1;
    run(a.w, 1, { [a.id]: () => ({ useHeal: true }) });
    run(a.w, 10, { [a.id]: () => ({ ads: true }) });
    expect(a.p.heal).not.toBeNull();
    expect(a.p.move.adsMs).toBe(0);
    expect(a.w.snapshotFor(a.id).players.find((x) => x.id === a.id)!.anim.ads).toBe(false);
    const r = armed('rifle');
    r.p.inv.slots[0]!.mag = 3;
    run(r.w, 1, { [r.id]: () => ({ reload: true }) });
    run(r.w, 5, { [r.id]: () => ({ ads: true }) });
    expect(r.p.reload).not.toBeNull();
    expect(r.p.move.adsMs).toBe(0);
    const s = armed('rifle');
    run(s.w, 60, { [s.id]: () => ({ ads: true, sprint: true, moveForward: 1 }) });
    expect(speed(s.p)).toBeCloseTo(BALANCE.movement.walkSpeed * BALANCE.weapons.rifle.adsMoveMultiplier, 2);
    expect(s.w.snapshotFor(s.id).players.find((x) => x.id === s.id)!.anim.sprinting).toBe(false);
  });

  it('LMG fire slow stacks with ADS (walk x adsMove x fireMove) and stops when you switch to another gun', () => {
    const a = armed('lmg');
    a.p.inv.slots[1] = { weapon: 'smg', mag: 30 };
    run(a.w, 45, { [a.id]: () => ({ ads: true, fire: true, moveForward: 1 }) });
    const lmg = BALANCE.weapons.lmg;
    expect(speed(a.p)).toBeCloseTo(BALANCE.movement.walkSpeed * lmg.adsMoveMultiplier * lmg.fireMoveMultiplier, 2);
    // Switch to the smg right after the last shot: the LMG window must not slow the smg.
    run(a.w, 1, { [a.id]: () => ({ selectSlot: 1, moveForward: 1 }) });
    run(a.w, ticks(BALANCE.combat.swapMs) + 20, { [a.id]: () => ({ moveForward: 1 }) });
    expect(speed(a.p)).toBeCloseTo(BALANCE.movement.walkSpeed, 2);
  });

  it('sniper headshot vs helmet_3 at full durability leaves 15 HP and breaks the helmet; the damage event says broken', () => {
    const { w, ids } = playingWorld(2, { map: BIG(), balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -120);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    sp.inv.activeSlot = 0;
    const tp = w.debugPlayer(t)!;
    tp.helmet = { tier: 3, durability: 75 };
    const pitch = Math.atan2(GROUND + 1.0 - EYE_Y, 120 - BALANCE.player.radius);
    const ev = run(w, 2, { [s]: (i) => ({ fire: i === 0, pitch }) });
    const d = ofType(ev, 'damage')[0]!;
    expect(d).toMatchObject({ headshot: true, helmet: { tier: 3, broken: true } });
    expect(tp.hp).toBeCloseTo(15, 6);
    expect(w.snapshotFor(s).players.find((x) => x.id === t)!.helmetTier).toBe(0);
  });

  it('sniper vs a prone target: the whole 0.6 m-high box is hittable from 100 m with the scope (no spread at full prone ADS)', () => {
    const b = balanceWith(() => {});
    const { w, ids } = playingWorld(2, { map: BIG(), balance: b });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -100);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    sp.inv.activeSlot = 0;
    sp.inv.ammo.ammo_sniper = 20;
    const tp = w.debugPlayer(t)!;
    tp.hp = 1e6;
    // Both prone; the shooter ADS for the full adsTimeMs.
    run(w, ticks(800), { [s]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null, ads: i > 0 }), [t]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null }) });
    run(w, ticks(500), { [s]: () => ({ ads: true }), [t]: () => ({}) });
    expect(sp.move.stance).toBe('prone');
    expect(sp.move.adsMs).toBe(BALANCE.weapons.sniper.adsTimeMs);
    const eyeY = GROUND + BALANCE.movement.stances.prone.eyeHeight;
    let hits = 0;
    for (let i = 0; i < 5; i++) {
      sp.nextFireAt = 0;
      const pitch = Math.atan2(GROUND + 0.25 - eyeY, 100 - 0.75);
      const ev = run(w, 2, { [s]: (k) => ({ fire: k === 0, ads: true, pitch }), [t]: () => ({}) });
      hits += ofType(ev, 'damage').length;
    }
    expect(hits).toBe(5);
  });
});

describe('input stalls (> MAX_INPUT_REPEAT_TICKS) while holding LMB / RMB (BUG-010)', () => {
  /** Feed one real input, then `gap` ticks with no input (the client stalled), then real inputs again. */
  function stall(gun: GunId, held: Partial<import('../../src/shared/types').PlayerInput>, gap: number, after: number) {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 80, 80);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: gun, mag: BALANCE.weapons[gun].magSize };
    p.inv.activeSlot = 0;
    p.inv.ammo[BALANCE.weapons[gun].ammo!] = 50;
    const ev: SimEvent[] = [];
    const adsTrace: number[] = [];
    ev.push(...run(w, 1, { [id]: () => held }));
    for (let i = 0; i < gap; i++) {
      ev.push(...run(w, 1));
      adsTrace.push(p.move.adsMs);
    }
    for (let i = 0; i < after; i++) {
      ev.push(...run(w, 1, { [id]: () => held }));
      adsTrace.push(p.move.adsMs);
    }
    return { ev, p, adsTrace };
  }

  it('control: a 6-tick stall (within the repeat budget) keeps one press = one semi-auto shot', () => {
    const { ev } = stall('dmr', { fire: true }, 6, 40);
    expect(ofType(ev, 'shot').length).toBe(1);
  });

  it('BUG-010 (fixed): a 10-tick stall while holding LMB on a semi-auto gun must not fire a second shot', () => {
    // The button is never released, yet the neutral fire:false the server injects after the repeat budget makes the
    // next real input a new trigger edge.
    const { ev } = stall('dmr', { fire: true }, 10, 40);
    expect(ofType(ev, 'shot').length).toBe(1);
  });

  it('BUG-010 (fixed): a 10-tick stall while holding RMB must not reset ADS (client prediction keeps it)', () => {
    const { adsTrace } = stall('sniper', { ads: true }, 10, 2);
    // Never back to 0 once aiming started (prediction never sees the stall).
    expect(adsTrace.slice(1).every((a) => a > 0)).toBe(true);
  });
});

describe('bots with M2a content (headless all-bot matches on the island)', () => {
  it('over 8 seeded matches: no NaN in snapshots; bots wear helmets, throw grenades, kill with dmr/sniper/lmg and change stance', () => {
    let helmets = 0;
    let vests = 0;
    let throws = 0;
    let explosions = 0;
    const killsBy: Record<string, number> = {};
    let stanceChanges = 0;
    let proneOrCrouchSeen = 0;
    let bad: string | null = null;
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const w: DebugWorld = createDebugWorld({
        map: ISLAND,
        balance: balanceWith((x) => {
          x.match.targetPlayers = 16;
          x.match.minHumansToStart = 0;
          x.match.endWhenNoHumansAlive = false;
        }),
        seed,
        botNames: BOT_NAMES,
      });
      const seen = new Set<number>();
      const seenV = new Set<number>();
      for (let i = 0; i < ticks(700_000) && w.getMatch().phase !== 'results'; i++) {
        const ev = w.step(SIM_DT);
        for (const e of ev) {
          if (e.type === 'grenadeThrown') throws++;
          if (e.type === 'explosion') explosions++;
          if (e.type === 'kill' && e.weapon) killsBy[e.weapon] = (killsBy[e.weapon] ?? 0) + 1;
          if (e.type === 'stanceChange') stanceChanges++;
        }
        if (i % 30 === 0 && w.getMatch().phase === 'playing') {
          const snap: WorldSnapshot = w.snapshotFor(-1);
          if (!bad) bad = firstNonFinite(snap.players.map((p: PlayerState) => ({ pos: p.pos, hp: p.hp, sp: p.stanceProgress, yaw: p.yaw })));
          if (!bad) bad = firstNonFinite(snap.grenades);
          for (const p of snap.players) {
            if (p.helmetTier > 0) seen.add(p.id);
            if (p.vestTier > 0) seenV.add(p.id);
            if (p.stance !== 'stand') proneOrCrouchSeen++;
          }
        }
      }
      expect(w.getMatch().phase, `seed ${seed} ended`).toBe('results');
      helmets += seen.size;
      vests += seenV.size;
    }
    const summary = { helmets, vests, throws, explosions, killsBy, stanceChanges, proneOrCrouchSeen };
    console.info('[m2a-edge] bot content over 8 matches:', JSON.stringify(summary));
    expect(bad, 'first non-finite value in a snapshot').toBeNull();
    expect(helmets, 'bots wearing helmets').toBeGreaterThan(0);
    expect(vests, 'bots wearing vests').toBeGreaterThan(0);
    expect(throws, 'bot grenade throws').toBeGreaterThan(0);
    expect(explosions, 'bot grenades explode').toBeGreaterThan(0);
    expect((killsBy.dmr ?? 0) + (killsBy.sniper ?? 0), 'dmr/sniper kills').toBeGreaterThan(0);
    expect(killsBy.lmg ?? 0, 'lmg kills').toBeGreaterThan(0);
    expect(stanceChanges, 'bots change stance').toBeGreaterThan(0);
  }, 120_000);
});
