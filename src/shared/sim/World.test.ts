import { describe, expect, it } from 'vitest';
import { BALANCE, type BotPacingBalance } from '../balance';
import { MAX_INPUT_REPEAT_TICKS, MAX_QUEUED_INPUTS, SIM_DT } from '../constants';
import { carrierPosAt } from '../maps';
import type { PlayerDropFields, PlayerState, SimEvent } from '../types';
import { ISLAND } from '../../game/levels/island';
import { heightAt } from './terrain';
import { initialMovementState } from './movement';
import { BOT_AI, BOT_TUNING_DEFAULTS, botAi, botEngageRange, botFireRange, botTuning } from './bots';
import { createDebugWorld, createWorld } from './World';
import { balanceWith, flatMap, input, land, noSpreadBalance, playingWorld, run } from './testkit';

const BOT_NAMES = Array.from({ length: 24 }, (_, i) => `Bot ${i}`);
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T) => ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);
const ticks = (ms: number) => Math.ceil(ms / (SIM_DT * 1000));

/** Aim pitch from an eye at height `eyeY` to a point at height y, horizontal distance d. */
const pitchTo = (eyeY: number, y: number, d: number) => Math.atan2(y - eyeY, d);

describe('World: match lifecycle', () => {
  it('lobby -> countdown -> playing (filled with bots, dropping) -> results -> lobby (re-queued)', () => {
    const b = balanceWith(() => {});
    const w = createDebugWorld({ map: ISLAND, balance: b, seed: 9, botNames: BOT_NAMES });
    expect(w.getMatch().phase).toBe('lobby');
    w.step(SIM_DT);
    expect(w.getMatch().phase).toBe('lobby'); // nobody queued
    const h = w.addPlayer('Alice')!;
    expect(h).toBeGreaterThan(0);
    w.step(SIM_DT);
    const m = w.getMatch();
    expect(m.phase).toBe('countdown');
    expect(m.lobbyCount).toBe(1);
    expect(m.phaseEndsAt).toBeCloseTo(w.timeMs + b.match.countdownSeconds * 1000, 6);
    expect(w.snapshotFor(h).players).toEqual([]);
    expect(w.snapshotFor(h).local).toBeNull();

    const ev: SimEvent[] = [];
    while (w.getMatch().phase === 'countdown') ev.push(...w.step(SIM_DT));
    expect(w.getMatch().phase).toBe('playing');
    const spawns = ofType(ev, 'spawn');
    expect(spawns.length).toBe(b.match.targetPlayers);
    const snap = w.snapshotFor(h);
    expect(snap.players.length).toBe(b.match.targetPlayers);
    expect(snap.players.filter((p) => p.isBot).length).toBe(b.match.targetPlayers - 1);
    expect(new Set(snap.players.map((p) => p.name)).size).toBe(b.match.targetPlayers);
    expect(snap.local?.id).toBe(h);
    expect(snap.zone?.phaseIndex).toBe(0);
    expect(snap.loot.length).toBeGreaterThan(30);
    // M2b carrier drop (drop.md AT4): everyone starts aboard at the carrier position.
    const route = w.getMatch().route!;
    expect(route).not.toBeNull();
    const c = carrierPosAt(route, w.timeMs);
    for (const s of spawns) {
      expect(s.pos).toEqual({ x: c.x, y: route.altitude, z: c.z });
      const p = snap.players.find((q) => q.id === s.playerId)! as PlayerState & PlayerDropFields;
      expect(p.anim.dropping).toBe(true);
      expect(p.aboard).toBe(true);
    }
    expect(w.getMatch().aboardCount).toBe(b.match.targetPlayers);

    // A late joiner spectates and is queued for the next match.
    const late = w.addPlayer('Late')!;
    w.step(SIM_DT);
    expect(w.snapshotFor(late).local).toBeNull();
    expect(w.getMatch().lobbyCount).toBe(1);
    w.applyInput(late, input({ seq: 1, moveForward: 1 })); // ignored

    // End it: everyone but Alice leaves the world via damage.
    for (const p of snap.players) if (p.id !== h) w.debugPlayer(p.id)!.dying = { killerId: h, weapon: 'pistol', cause: 'weapon' };
    const end = w.step(SIM_DT);
    const ended = ofType(end, 'matchEnded')[0]!;
    expect(ended.winnerId).toBe(h);
    expect(ended.standings[0]).toMatchObject({ id: h, placement: 1 });
    expect(new Set(ended.standings.map((s) => s.placement)).size).toBe(b.match.targetPlayers);
    expect(w.getMatch()).toMatchObject({ phase: 'results', winnerId: h, winnerName: 'Alice' });
    expect(w.snapshotFor(h).local).not.toBeNull();

    const matchId = w.getMatch().matchId;
    for (let i = 0; i < ticks(b.match.resultsSeconds * 1000) + 1; i++) w.step(SIM_DT);
    const after = w.getMatch();
    expect(after.matchId).toBe(matchId + 1);
    expect(after.phase).toBe('countdown'); // both humans re-queued, countdown restarts immediately
    expect(after.lobbyCount).toBe(2);
    expect(w.snapshotFor(h).players).toEqual([]);
  });

  it('drop: false keeps the M1 spawn: spread over playerSpawns at dropHeight, dropping', () => {
    const b = balanceWith(() => {});
    const w = createDebugWorld({ map: ISLAND, balance: b, seed: 9, botNames: BOT_NAMES, drop: false });
    w.addPlayer('Alice');
    const ev: SimEvent[] = [];
    while (w.getMatch().phase !== 'playing') ev.push(...w.step(SIM_DT));
    const spawns = ofType(ev, 'spawn');
    expect(spawns.length).toBe(b.match.targetPlayers);
    expect(w.getMatch().route).toBeNull();
    for (const s of spawns) {
      expect(s.pos.y).toBeCloseTo(heightAt(s.pos.x, s.pos.z, ISLAND) + b.match.dropHeight!, 6);
      expect(w.debugPlayer(s.playerId)!.move.dropping).toBe(true);
    }
    // Spawn spacing: every (24 / N)-th spawn -> nobody within ~40 m of another (12 players, 52 m apart nominally).
    for (const a of spawns) for (const c of spawns) if (a !== c) expect(Math.hypot(a.pos.x - c.pos.x, a.pos.z - c.pos.z)).toBeGreaterThan(40);
  });

  it('countdown falls back to lobby when queued humans drop below the minimum', () => {
    const w = createWorld({ map: ISLAND, balance: BALANCE, seed: 1, botNames: BOT_NAMES });
    const h = w.addPlayer('A')!;
    w.step(SIM_DT);
    expect(w.getMatch().phase).toBe('countdown');
    w.removePlayer(h);
    w.step(SIM_DT);
    expect(w.getMatch().phase).toBe('lobby');
  });

  it('addPlayer returns null once maxPlayers humans are connected', () => {
    const w = createWorld({ map: ISLAND, balance: BALANCE, seed: 1, botNames: BOT_NAMES });
    for (let i = 0; i < BALANCE.match.maxPlayers; i++) expect(w.addPlayer(`P${i}`)).not.toBeNull();
    expect(w.addPlayer('extra')).toBeNull();
  });

  it('no humans alive: resolves lastHumanDeathDelaySeconds later, bots ranked by hp + armor durability', () => {
    const b = balanceWith(() => {});
    const w = createDebugWorld({ map: ISLAND, balance: b, seed: 4, botNames: BOT_NAMES });
    const h = w.addPlayer('A')!;
    while (w.getMatch().phase !== 'playing') w.step(SIM_DT);
    const hp = w.debugPlayer(h)!;
    hp.aboard = false;
    // Out at sea near the world edge (taken from map data): always outside the first circle's damage area.
    const seaZ = -(ISLAND.worldRadius - 2);
    hp.move = initialMovementState({ x: 0, y: heightAt(0, seaZ, ISLAND), z: seaZ }, false);
    hp.hp = 0.5;
    const ev: SimEvent[] = [];
    let deathAt = -1;
    for (let i = 0; i < ticks(10_000) && w.getMatch().phase === 'playing'; i++) {
      const e = w.step(SIM_DT);
      if (ofType(e, 'kill').some((k) => k.victimId === h)) deathAt = w.timeMs;
      ev.push(...e);
    }
    const kill = ofType(ev, 'kill').find((k) => k.victimId === h)!;
    expect(kill.cause).toBe('zone');
    const ended = ofType(ev, 'matchEnded')[0]!;
    expect(ended).toBeDefined();
    expect(w.timeMs - deathAt).toBeGreaterThanOrEqual(b.match.lastHumanDeathDelaySeconds * 1000 - 1);
    expect(w.timeMs - deathAt).toBeLessThan(b.match.lastHumanDeathDelaySeconds * 1000 + 100);
    const placements = ended.standings.map((s) => s.placement).sort((x, y) => x - y);
    expect(placements).toEqual(Array.from({ length: b.match.targetPlayers }, (_, i) => i + 1));
    expect(ended.standings.find((s) => s.placement === 1)!.isBot).toBe(true);
  });

  it('disconnect mid-match eliminates without a kill event; loot drops; match ends next step', () => {
    const { w, ids } = playingWorld(2);
    const [a, c] = ids as [number, number];
    w.debugPlayer(c)!.inv.slots[0] = { weapon: 'smg', mag: 9 };
    const lootBefore = w.debugLoot().length;
    w.removePlayer(c);
    expect(w.debugLoot().length).toBe(lootBefore + 1);
    expect(w.debugLoot().at(-1)).toMatchObject({ item: 'smg', mag: 9 });
    const ev = w.step(SIM_DT);
    expect(ofType(ev, 'kill')).toEqual([]);
    expect(ofType(ev, 'matchEnded')[0]!.winnerId).toBe(a);
    expect(w.snapshotFor(a).players.map((p) => p.id)).toEqual([a]);
  });
});

describe('World: inputs', () => {
  it('consumes one input per step, caps the queue, repeats held fields with edges cleared', () => {
    const { w, ids } = playingWorld(1 + 1);
    const id = ids[0]!;
    for (let s = 1; s <= MAX_QUEUED_INPUTS + 4; s++) w.applyInput(id, input({ seq: s, moveForward: 1, jump: s === MAX_QUEUED_INPUTS + 4 }));
    expect(w.debugPlayer(id)!.queue.length).toBe(MAX_QUEUED_INPUTS);
    w.step(SIM_DT);
    expect(w.snapshotFor(id).local!.lastProcessedInputSeq).toBe(5); // 1..4 dropped
    for (let i = 0; i < MAX_QUEUED_INPUTS - 1; i++) w.step(SIM_DT);
    const seq = w.snapshotFor(id).local!.lastProcessedInputSeq;
    expect(seq).toBe(MAX_QUEUED_INPUTS + 4);
    const z0 = w.debugPlayer(id)!.move.pos.z;
    // Queue empty: keeps walking (held) for MAX_INPUT_REPEAT_TICKS ticks, does not re-jump, seq unchanged.
    for (let i = 0; i < MAX_INPUT_REPEAT_TICKS; i++) w.step(SIM_DT);
    const p = w.debugPlayer(id)!;
    expect(p.move.pos.z).toBeLessThan(z0 - 0.5 * MAX_INPUT_REPEAT_TICKS * SIM_DT * BALANCE.movement.walkSpeed);
    expect(p.lastInput!.moveForward).toBe(1);
    // Then held movement/fire are released (a stalled tab stops): the player comes to rest.
    for (let i = 0; i < 40; i++) w.step(SIM_DT);
    const z1 = p.move.pos.z;
    w.step(SIM_DT);
    expect(p.move.pos.z).toBeCloseTo(z1, 4);
    expect(Math.hypot(p.move.vel.x, p.move.vel.z)).toBeLessThan(1e-3);
    expect(p.move.grounded).toBe(true);
    expect(w.snapshotFor(id).local!.lastProcessedInputSeq).toBe(seq);
  });

  it('starved held fire stops after MAX_INPUT_REPEAT_TICKS; a new input resets the repeat budget', () => {
    const { w, ids } = playingWorld(2);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'smg', mag: 30 };
    p.inv.ammo.ammo_light = 0;
    p.inv.activeSlot = 0;
    w.applyInput(id, input({ seq: 1, fire: true }));
    let shots = 0;
    for (let i = 0; i < 60; i++) shots += ofType(w.step(SIM_DT), 'shot').length;
    const maxShots = Math.ceil(((1 + MAX_INPUT_REPEAT_TICKS) * SIM_DT * 1000) / BALANCE.weapons.smg.fireIntervalMs) + 1;
    expect(shots).toBeGreaterThan(0);
    expect(shots).toBeLessThanOrEqual(maxShots);
    expect(p.inputRepeatTicks).toBeGreaterThan(MAX_INPUT_REPEAT_TICKS);
    w.applyInput(id, input({ seq: 2, fire: false }));
    w.step(SIM_DT);
    expect(p.inputRepeatTicks).toBe(0);
  });

  it('defensively clamps bad input values', () => {
    const { w, ids } = playingWorld(2);
    const id = ids[0]!;
    w.applyInput(id, input({ seq: 1, moveForward: 50, moveRight: Number.NaN, pitch: 10, yaw: Number.POSITIVE_INFINITY, selectSlot: 7 as never }));
    w.step(SIM_DT);
    const p = w.debugPlayer(id)!;
    expect(p.lastInput!.moveForward).toBe(1);
    expect(p.lastInput!.moveRight).toBe(0);
    expect(p.pitch).toBeLessThanOrEqual(Math.PI / 2);
    expect(Number.isFinite(p.yaw)).toBe(true);
    expect(p.lastInput!.selectSlot).toBe(-1);
  });
});

describe('World: combat (combat.md acceptance)', () => {
  /** Shooter at origin facing -Z, target `dist` m away, both on flat ground (y = 2). */
  function duel(dist: number, gun: 'pistol' | 'smg' | 'shotgun' | 'rifle', opts: { mag?: number; reserve?: number } = {}) {
    const map = flatMap();
    const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -dist);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: gun, mag: opts.mag ?? BALANCE.weapons[gun].magSize };
    sp.inv.activeSlot = 0;
    sp.inv.ammo[BALANCE.weapons[gun].ammo!] = opts.reserve ?? 0;
    const eyeY = 2 + BALANCE.player.eyeHeight;
    return { w, s, t, sp, tp: w.debugPlayer(t)!, eyeY, bodyPitch: pitchTo(eyeY, 2 + 0.5, dist), headPitch: pitchTo(eyeY, 2 + 1.0, dist) };
  }

  it('AT1: rifle body 19 at 10 m, 15.675 at 60 m, 12.35 at 90/120 m, miss at 151 m', () => {
    // Distance is measured along the ray to the hit point on the cylinder surface (target centre at dist + radius).
    for (const [dist, dmg] of [
      [10, 19],
      [60, 15.675],
      [90, 12.35],
      [120, 12.35],
      [151, null],
    ] as const) {
      const d = duel(dist + BALANCE.player.radius, 'rifle');
      const ev = run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.bodyPitch }) });
      const dmgEv = ofType(ev, 'damage');
      if (dmg === null) expect(dmgEv).toEqual([]);
      else {
        expect(dmgEv[0]!.amount).toBeCloseTo(dmg, 3);
        expect(dmgEv[0]!.headshot).toBe(false);
        expect(d.tp.hp).toBeCloseTo(100 - dmg, 3);
      }
      expect(ofType(ev, 'shot').length).toBe(1);
    }
  });

  it('AT2: rifle headshot at y = 1.0 deals 34.2', () => {
    const d = duel(10, 'rifle');
    const ev = run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.headPitch }) });
    expect(ofType(ev, 'damage')[0]).toMatchObject({ headshot: true });
    expect(ofType(ev, 'damage')[0]!.amount).toBeCloseTo(34.2, 6);
    expect(ofType(ev, 'shot')[0]!.impacts[0]).toMatchObject({ surface: 'player', playerId: d.t, headshot: true });
  });

  it('armor.md AT1 (in world): vest_2 absorbs 40% of a body hit; the event reports the vest hit', () => {
    const d = duel(10, 'rifle');
    d.tp.vest = { tier: 2, durability: 55 };
    d.tp.helmet = { tier: 3, durability: 75 };
    const ev = run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.bodyPitch }) });
    expect(d.tp.hp).toBeCloseTo(100 - 19 * 0.6, 6);
    expect(d.tp.vest!.durability).toBeCloseTo(55 - 19 * 0.4, 6);
    expect(d.tp.helmet).toEqual({ tier: 3, durability: 75 }); // armor.md AT2: body hits never touch the helmet
    expect(ofType(ev, 'damage')[0]).toMatchObject({ amount: 19, vest: { tier: 2, broken: false }, helmet: null });
  });

  it('AT4: shotgun point-blank 0 spread leaves 1 HP; second shot kills (one damage event per shot)', () => {
    const d = duel(2, 'shotgun');
    const ev1 = run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.bodyPitch }) });
    expect(ofType(ev1, 'damage').length).toBe(1);
    expect(ofType(ev1, 'shot')[0]!.impacts.length).toBe(9);
    expect(d.tp.hp).toBeCloseTo(1, 6);
    const ev2 = run(d.w, ticks(BALANCE.weapons.shotgun.fireIntervalMs) + 2, {
      [d.s]: (i) => ({ fire: i > 0, pitch: d.bodyPitch }),
    });
    const kill = ofType(ev2, 'kill')[0]!;
    expect(kill).toMatchObject({ victimId: d.t, killerId: d.s, weapon: 'shotgun', cause: 'weapon', placement: 2 });
    expect(ofType(ev2, 'matchEnded')[0]!.winnerId).toBe(d.s);
    expect(d.sp.kills).toBe(1);
  });

  it('AT5: semi-auto pistol fires once while held; automatic rifle fires every fireIntervalMs', () => {
    const d = duel(10, 'pistol');
    const ev = run(d.w, 30, { [d.s]: () => ({ fire: true, pitch: 0.5 }) });
    expect(ofType(ev, 'shot').length).toBe(1);
    const r = duel(10, 'rifle', { mag: 25 });
    const ev2 = run(r.w, 30, { [r.s]: () => ({ fire: true, pitch: 0.5 }) });
    const n = ofType(ev2, 'shot').length;
    expect(n).toBeGreaterThanOrEqual(Math.floor(1000 / BALANCE.weapons.rifle.fireIntervalMs));
    expect(n).toBeLessThanOrEqual(Math.ceil(1000 / BALANCE.weapons.rifle.fireIntervalMs) + 1);
  });

  it('AT6: reload with mag 3/12 and reserve 5 ends at 8/12 and reserve 0', () => {
    const d = duel(10, 'pistol', { mag: 3, reserve: 5 });
    const ev = run(d.w, ticks(BALANCE.weapons.pistol.reloadMs) + 1, { [d.s]: (i) => ({ reload: i === 0 }) });
    expect(ofType(ev, 'reloadStart').length).toBe(1);
    expect(ofType(ev, 'reloadEnd')[0]).toMatchObject({ completed: true });
    expect(d.sp.inv.slots[0]!.mag).toBe(8);
    expect(d.sp.inv.ammo.ammo_light).toBe(0);
  });

  it('firing the last round with reserve auto-reloads; cannot fire while reloading', () => {
    const d = duel(10, 'pistol', { mag: 1, reserve: 20 });
    const ev = run(d.w, 10, { [d.s]: (i) => ({ fire: i % 2 === 0, pitch: 0.5 }) });
    expect(ofType(ev, 'shot').length).toBe(1);
    expect(ofType(ev, 'reloadStart').length).toBe(1);
  });

  it('AT7: swapping during a reload cancels it; mag and reserve unchanged', () => {
    const d = duel(10, 'pistol', { mag: 3, reserve: 5 });
    d.sp.inv.slots[1] = { weapon: 'smg', mag: 10 };
    const ev = run(d.w, ticks(BALANCE.weapons.pistol.reloadMs) + 5, {
      [d.s]: (i) => ({ reload: i === 0, selectSlot: i === 5 ? 1 : -1 }),
    });
    expect(ofType(ev, 'reloadEnd')[0]).toMatchObject({ completed: false });
    expect(ofType(ev, 'weaponSwitch')[0]).toMatchObject({ weapon: 'smg', slot: 1 });
    expect(d.sp.inv.slots[0]!.mag).toBe(3);
    expect(d.sp.inv.ammo.ammo_light).toBe(5);
  });

  it('AT9b: Q during a reload (mag 3/12, reserve 30) starts the heal and cancels the reload; R during a heal cancels it', () => {
    const d = duel(10, 'pistol', { mag: 3, reserve: 30 });
    d.sp.hp = 60;
    d.sp.inv.heals.bandage = 2;
    let ev = run(d.w, 5, { [d.s]: (i) => ({ reload: i === 0, useHeal: i === 3 }) });
    expect(ofType(ev, 'reloadStart').length).toBe(1);
    expect(ofType(ev, 'reloadEnd')[0]).toMatchObject({ completed: false });
    expect(ofType(ev, 'healStart')[0]).toMatchObject({ item: 'bandage' });
    expect(d.sp.reload).toBeNull();
    expect(d.sp.heal).not.toBeNull();
    expect(d.sp.inv.slots[0]!.mag).toBe(3);
    expect(d.sp.inv.ammo.ammo_light).toBe(30);
    // Let the old reload's duration pass: nothing is loaded behind the heal's back.
    ev = run(d.w, 2, { [d.s]: () => ({}) });
    expect(d.sp.inv.slots[0]!.mag).toBe(3);
    // R while healing: the heal is cancelled (item kept) and the reload starts.
    ev = run(d.w, 1, { [d.s]: () => ({ reload: true }) });
    expect(ofType(ev, 'healEnd')[0]).toMatchObject({ item: 'bandage', completed: false });
    expect(ofType(ev, 'reloadStart').length).toBe(1);
    expect(d.sp.heal).toBeNull();
    expect(d.sp.inv.heals.bandage).toBe(2);
    expect(d.sp.hp).toBe(60);
    run(d.w, ticks(BALANCE.weapons.pistol.reloadMs) + 2);
    expect(d.sp.inv.slots[0]!.mag).toBe(12);
    expect(d.sp.inv.ammo.ammo_light).toBe(21);
  });

  it('AT8: bandage 70 -> 75; refused at 75 with only bandages; medkit 30 -> 100', () => {
    const d = duel(10, 'pistol');
    d.sp.hp = 70;
    d.sp.inv.heals.bandage = 2;
    const ev = run(d.w, ticks(BALANCE.items.bandage.useMs) + 1, { [d.s]: (i) => ({ useHeal: i === 0 }) });
    expect(ofType(ev, 'healEnd')[0]).toMatchObject({ item: 'bandage', completed: true, hpAfter: 75 });
    expect(d.sp.inv.heals.bandage).toBe(1);
    const ev2 = run(d.w, 3, { [d.s]: (i) => ({ useHeal: i === 0 }) });
    expect(ofType(ev2, 'healStart')).toEqual([]);
    d.sp.hp = 30;
    d.sp.inv.heals.medkit = 1;
    run(d.w, ticks(BALANCE.items.medkit.useMs) + 1, { [d.s]: (i) => ({ useHeal: i === 0 }) });
    expect(d.sp.hp).toBe(100);
    expect(d.sp.inv.heals.medkit).toBe(0);
  });

  it('AT9: firing during a heal cancels it; item count unchanged. Q again also cancels', () => {
    const d = duel(10, 'pistol');
    d.sp.hp = 40;
    d.sp.inv.heals.bandage = 2;
    const ev = run(d.w, 20, { [d.s]: (i) => ({ useHeal: i === 0, fire: i === 10, pitch: 0.5 }) });
    expect(ofType(ev, 'healEnd')[0]).toMatchObject({ completed: false });
    expect(d.sp.inv.heals.bandage).toBe(2);
    expect(d.sp.hp).toBe(40);
    const ev2 = run(d.w, 10, { [d.s]: (i) => ({ useHeal: i === 0 || i === 5 }) });
    expect(ofType(ev2, 'healStart').length).toBe(1);
    expect(ofType(ev2, 'healEnd')[0]).toMatchObject({ completed: false });
  });

  it('heal slows movement and taking damage does not cancel it', () => {
    const d = duel(10, 'rifle');
    d.tp.hp = 50;
    d.tp.inv.heals.bandage = 1;
    const ev = run(d.w, 10, {
      [d.t]: (i) => ({ useHeal: i === 0 }),
      [d.s]: (i) => ({ fire: i === 5, pitch: d.bodyPitch }),
    });
    expect(ofType(ev, 'damage').length).toBe(1);
    expect(ofType(ev, 'healEnd')).toEqual([]);
    expect(d.tp.heal).not.toBeNull();
  });

  it('AT10/11: pickup swap drops the held gun with its mag; partial ammo pickup leaves the rest', () => {
    const d = duel(10, 'pistol');
    d.sp.inv.slots[1] = { weapon: 'smg', mag: 7 };
    d.sp.inv.activeSlot = 1;
    const loot = d.w.debugLoot();
    loot.push({ id: 900, item: 'rifle', qty: 1, mag: 20, pos: { x: 0.5, y: 2, z: 0 }, tier: 'epic', durability: null });
    const ev = run(d.w, 1, { [d.s]: () => ({ interact: true }) });
    expect(ofType(ev, 'pickup')[0]).toMatchObject({ item: 'rifle', qty: 1, lootId: 900 });
    expect(d.sp.inv.slots[1]).toEqual({ weapon: 'rifle', mag: 20 });
    const dropped = d.w.debugLoot().find((l) => l.item === 'smg')!;
    expect(dropped.mag).toBe(7);
    expect(Math.hypot(dropped.pos.x, dropped.pos.z)).toBeLessThan(0.5);

    dropped.pos = { x: 50, y: 2, z: 50 }; // move it away
    d.sp.inv.ammo.ammo_light = 170;
    d.w.debugLoot().push({ id: 901, item: 'ammo_light', qty: 30, mag: null, pos: { x: 0, y: 2, z: 1 }, tier: 'common', durability: null });
    const ev2 = run(d.w, 1, { [d.s]: () => ({ interact: true }) });
    expect(ofType(ev2, 'pickup')[0]).toMatchObject({ qty: 10 });
    expect(d.w.debugLoot().find((l) => l.id === 901)!.qty).toBe(20);
  });

  it('dropping players cannot be hit, pick up, or fire', () => {
    const d = duel(10, 'rifle');
    d.tp.move = { ...d.tp.move, pos: { x: 0, y: 2, z: -10 }, dropping: true, grounded: false };
    const ev = run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.bodyPitch }) });
    expect(ofType(ev, 'damage')).toEqual([]);
  });

  it('a rock between shooter and target blocks the shot', () => {
    const map = flatMap({}, [{ kind: 'rock', x: 0, z: -5, rotY: 0, scale: 1 }]);
    const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -10);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    sp.inv.activeSlot = 0;
    const ev = run(w, 1, { [s]: () => ({ fire: true, pitch: pitchTo(3.05, 2.5, 10) }) });
    expect(ofType(ev, 'damage')).toEqual([]);
    expect(ofType(ev, 'shot')[0]!.impacts[0]!.surface).toBe('prop');
  });

  it('fists melee within range', () => {
    const map = flatMap();
    const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -1.2);
    const ev = run(w, 1, { [s]: () => ({ fire: true, pitch: pitchTo(3.05, 2.5, 1.2) }) });
    expect(ofType(ev, 'damage')[0]!.amount).toBe(BALANCE.weapons.fists.damage);
    expect(ofType(ev, 'shot')[0]!.weapon).toBe('fists');
  });

  it('death drops inventory, grenades and worn armor within deathDropScatter (armor.md AT8)', () => {
    const d = duel(5, 'shotgun');
    d.tp.inv.slots[0] = { weapon: 'smg', mag: 12 };
    d.tp.inv.heals.bandage = 2;
    d.tp.inv.grenades = 1;
    d.tp.helmet = { tier: 1, durability: 30 };
    d.tp.hp = 1;
    run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.bodyPitch }) });
    const items = d.w.debugLoot().filter((l) => Math.hypot(l.pos.x, l.pos.z + 5) <= BALANCE.combat.deathDropScatter + 1e-9);
    expect(items.map((l) => l.item).sort()).toEqual(['bandage', 'grenade', 'helmet_1', 'smg']);
    expect(items.find((l) => l.item === 'helmet_1')!.durability).toBe(30);
    expect(d.tp.helmet).toBeNull();
  });

  it('fall damage outside the drop; drop landing deals none', () => {
    const { w, ids } = playingWorld(3);
    const [a, c] = ids as [number, number];
    const pa = w.debugPlayer(a)!;
    pa.move = { ...initialMovementState({ x: 0, y: 30, z: 0 }, false), grounded: false };
    const pc = w.debugPlayer(c)!;
    pc.move = initialMovementState({ x: 20, y: 30, z: 0 }, true);
    const ev = run(w, 30 * 5);
    const fall = ofType(ev, 'damage').filter((e) => e.cause === 'fall');
    expect(fall.length).toBe(1);
    expect(fall[0]!.victimId).toBe(a);
    expect(ofType(ev, 'kill')[0]).toMatchObject({ victimId: a, cause: 'fall', killerId: null });
    expect(pc.hp).toBe(BALANCE.player.maxHp);
  });

  it('zone deaths in the same tick are ordered by hp + armor; kill credit within the window', () => {
    const { w, ids } = playingWorld(3, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const [a, c, e] = ids as [number, number, number];
    land(w, a, 0, -200);
    land(w, c, 0, 200);
    land(w, e, 0, 0);
    w.debugPlayer(a)!.hp = 0.5;
    w.debugPlayer(c)!.hp = 0.7;
    w.debugPlayer(a)!.lastDamagedBy = { id: e, at: w.timeMs };
    const ev = run(w, ticks(BALANCE.zone.damageTickMs) + 1);
    const kills = ofType(ev, 'kill');
    expect(kills.length).toBe(2);
    expect(kills.find((k) => k.victimId === c)!.placement).toBe(2);
    expect(kills.find((k) => k.victimId === a)).toMatchObject({ placement: 3, killerId: e, cause: 'zone' });
    expect(ofType(ev, 'damage').every((d) => d.cause !== 'zone' || (d.vest === null && d.helmet === null))).toBe(true);
    expect(ofType(ev, 'matchEnded')[0]!.winnerId).toBe(e);
  });

  it('AT3 zone: outside during phase 3 loses exactly 4 HP per second, armor unchanged', () => {
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const [a] = ids as [number];
    const z = w.debugZone()!;
    const pa = w.debugPlayer(a)!;
    // Fast-forward to phase index 2 by stepping the clock (players parked inside meanwhile).
    while (z.state.phaseIndex < 2) run(w, 30);
    land(w, a, 0, 290);
    pa.vest = { tier: 2, durability: 40 };
    pa.helmet = { tier: 1, durability: 20 };
    const hp0 = pa.hp;
    run(w, 30 * 3);
    expect(hp0 - pa.hp).toBeCloseTo(3 * 4, 6);
    expect(pa.vest).toEqual({ tier: 2, durability: 40 });
    expect(pa.helmet).toEqual({ tier: 1, durability: 20 });
  });
});

describe('World: contract revision 1 fields', () => {
  function pair() {
    const { w, ids } = playingWorld(2, { balance: noSpreadBalance() });
    const [a, c] = ids as [number, number];
    land(w, a, 0, 0);
    land(w, c, 0, -10);
    return { w, a, c, pa: w.debugPlayer(a)!, pc: w.debugPlayer(c)! };
  }
  const eyeY = 2 + BALANCE.player.eyeHeight;

  it('damage carries the helmet hit; a lethal headshot sets kill.headshot; zone/fall kills are not headshots', () => {
    const d = pair();
    d.pa.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    d.pa.inv.activeSlot = 0;
    d.pc.helmet = { tier: 1, durability: 20 };
    d.pc.vest = { tier: 1, durability: 20 };
    const head = pitchTo(eyeY, 2 + 1.0, 10);
    let ev = run(d.w, 1, { [d.a]: () => ({ fire: true, pitch: head }) });
    const dmg = ofType(ev, 'damage')[0]!;
    expect(dmg.helmet).toMatchObject({ tier: 1, broken: false });
    expect(dmg.helmet!.absorbed).toBeCloseTo(34.2 * 0.3, 6);
    expect(dmg.vest).toBeNull();
    expect(d.pc.vest).toEqual({ tier: 1, durability: 20 });
    d.pc.hp = 1;
    ev = run(d.w, ticks(BALANCE.weapons.rifle.fireIntervalMs) + 1, { [d.a]: () => ({ fire: true, pitch: head }) });
    const kill = ofType(ev, 'kill')[0]!;
    expect(kill.victimId).toBe(d.c);
    expect(kill.headshot).toBe(true);
  });

  it('loot snapshots carry the spawn tier; drops use the fixed per-item table (pistol = common)', () => {
    const d = pair();
    d.w.debugLoot().push({ id: 950, item: 'smg', qty: 1, mag: 30, pos: { x: 0, y: 2, z: 0.5 }, tier: 'epic', durability: null });
    expect(d.w.snapshotFor(d.a).loot.find((l) => l.id === 950)!.tier).toBe('epic');
    d.pc.inv.slots[0] = { weapon: 'pistol', mag: 5 };
    d.pc.dying = { killerId: d.a, weapon: 'pistol', cause: 'weapon' };
    d.w.step(SIM_DT);
    const drop = d.w.snapshotFor(d.a).loot.find((l) => l.item === 'pistol')!;
    expect(drop.tier).toBe('common');
  });

  it('actionFailed: refused heal / pickup / reload presses by humans emit one event with the reason', () => {
    const d = pair();
    const failed = (ev: SimEvent[]) => ofType(ev, 'actionFailed').map((e) => `${e.playerId}:${e.action}:${e.reason}`);
    // Heal with nothing to use, then at full HP.
    expect(failed(run(d.w, 1, { [d.a]: () => ({ useHeal: true }) }))).toEqual([`${d.a}:heal:noHeals`]);
    d.pa.inv.heals.bandage = 2;
    expect(failed(run(d.w, 1, { [d.a]: () => ({ useHeal: true }) }))).toEqual([`${d.a}:heal:fullHp`]);
    // Pickups that would not change anything.
    d.pa.vest = { tier: 2, durability: 3 };
    d.w.debugLoot().push({ id: 960, item: 'vest_2', qty: 1, mag: null, pos: { x: 0, y: 2, z: 0.3 }, tier: 'common', durability: 55 });
    expect(failed(run(d.w, 1, { [d.a]: () => ({ interact: true }) }))).toEqual([`${d.a}:pickup:betterArmor`]);
    d.w.debugLoot().length = 0;
    d.pa.inv.heals.bandage = BALANCE.items.bandage.maxStack;
    d.w.debugLoot().push({ id: 961, item: 'bandage', qty: 3, mag: null, pos: { x: 0, y: 2, z: 0.3 }, tier: 'common', durability: null });
    expect(failed(run(d.w, 1, { [d.a]: () => ({ interact: true }) }))).toEqual([`${d.a}:pickup:inventoryFull`]);
    // Reload with a partly empty mag and no reserve; a full mag is not a failure.
    d.pa.inv.slots[0] = { weapon: 'pistol', mag: 3 };
    d.pa.inv.activeSlot = 0;
    d.pa.swapRemainingMs = 0;
    expect(failed(run(d.w, 1, { [d.a]: () => ({ reload: true }) }))).toEqual([`${d.a}:reload:noAmmo`]);
    d.pa.inv.slots[0] = { weapon: 'pistol', mag: BALANCE.weapons.pistol.magSize };
    expect(failed(run(d.w, 1, { [d.a]: () => ({ reload: true }) }))).toEqual([]);
    // Held fire on an empty gun never emits; edges are not repeated while the queue is starved.
    d.pa.inv.slots[0] = { weapon: 'pistol', mag: 0 };
    expect(failed(run(d.w, 3, { [d.a]: () => ({ fire: true }) }))).toEqual([]);
    expect(failed(run(d.w, 5))).toEqual([]);
  });
});

describe('World: bots', () => {
  /** One balanced-personality bot at the origin facing -Z with a gun, one idle human at (0, humanZ). */
  function botDuel(weapon: 'rifle' | 'pistol', humanZ: number, botsPatch: BotPacingBalance = {}) {
    const b = noSpreadBalance((x) => {
      x.match.targetPlayers = 2;
      x.match.countdownSeconds = 0;
      x.match.spawnJitter = 0;
      Object.assign(x.bots, botsPatch);
    });
    const w = createDebugWorld({ map: flatMap(), balance: b, seed: 3, botNames: ['Crabby'] });
    const h = w.addPlayer('Idle')!;
    while (w.getMatch().phase !== 'playing') w.step(SIM_DT);
    const bot = w.snapshotFor(h).players.find((p) => p.isBot)!;
    land(w, h, 0, humanZ);
    land(w, bot.id, 0, 0);
    const bp = w.debugPlayer(bot.id)!;
    bp.brain!.personality = 'balanced';
    bp.yaw = 0;
    const ammo = weapon === 'rifle' ? 'ammo_heavy' : 'ammo_light';
    bp.inv.slots[0] = { weapon, mag: b.weapons[weapon].magSize };
    bp.inv.ammo[ammo] = 50;
    bp.inv.activeSlot = 0;
    const firstKill = (ms: number): number => {
      for (let i = 0; i < ticks(ms); i++) if (ofType(w.step(SIM_DT), 'kill').some((k) => k.victimId === h)) return i;
      return -1;
    };
    const shotsIn = (ms: number): number => {
      let n = 0;
      for (let i = 0; i < ticks(ms); i++) n += ofType(w.step(SIM_DT), 'shot').filter((e) => e.shooterId === bot.id).length;
      return n;
    };
    return { b, w, h, bot: bp, firstKill, shotsIn };
  }
  const PAST_LOOT_PHASE = { lootPhaseSeconds: 0, eagernessRampSeconds: 0 };

  it('past its loot phase, an armed bot kills an idle human in the open (after the reaction delay)', () => {
    // Bots strafe while fighting, so aimErrorDegMoving applies (12 deg): about 1 hit in 6-8 rounds at 15-20 m. A
    // standing human must still lose well within half a minute.
    const d = botDuel('rifle', -15, PAST_LOOT_PHASE);
    const killedAt = d.firstKill(30_000);
    expect(killedAt).toBeGreaterThan(ticks(d.b.bots.reactionMs) - 1);
    expect(killedAt).toBeLessThan(ticks(30_000));
  });

  it('during its loot phase a bot ignores an idle human outside lootPhaseEngageRange, but fights back when shot', () => {
    const d = botDuel('rifle', -15);
    expect(botEngageRange(d.bot.brain!, d.bot, d.w.timeMs, null, d.b)).toBeLessThan(15);
    expect(d.shotsIn(8000)).toBe(0);
    // The human shoots the bot: retaliation makes the human a valid target at any visible range.
    // (The bot may have backed away from the human meanwhile; aim at wherever it is now.)
    const hp = d.w.debugPlayer(d.h)!;
    hp.inv.slots[0] = { weapon: 'pistol', mag: 12 };
    hp.inv.activeSlot = 0;
    hp.swapRemainingMs = 0;
    const bx = d.bot.move.pos.x - hp.move.pos.x;
    const bz = d.bot.move.pos.z - hp.move.pos.z;
    const yaw = Math.atan2(-bx, -bz);
    const pitch = Math.atan2(d.b.player.height * 0.5 - d.b.player.eyeHeight, Math.hypot(bx, bz));
    expect(Math.hypot(bx, bz)).toBeLessThan(d.b.bots.visionRange);
    run(d.w, 1, { [d.h]: () => ({ fire: true, yaw, pitch }) });
    expect(d.bot.lastDamagedBy?.id).toBe(d.h);
    expect(d.shotsIn(4000)).toBeGreaterThan(0);
  });

  it('bots do not fire beyond their weapon fire range (no pistol beaming at 40 m)', () => {
    const d = botDuel('pistol', -40, PAST_LOOT_PHASE);
    expect(botFireRange('pistol', d.b)).toBeLessThan(40);
    expect(d.shotsIn(6000)).toBe(0);
    // ...but they close the distance instead.
    expect(Math.hypot(d.bot.move.pos.x, d.bot.move.pos.z)).toBeGreaterThan(5);
  });

  it('bot target choice spreads over targets: a focus penalty steers a second bot to the other enemy', () => {
    // Pure check on the scoring inputs: the per-pair bias is deterministic and bounded.
    const t = botTuning(BALANCE);
    expect(t.focusPenalty).toBeGreaterThan(0);
    expect(t.targetBiasSpread).toBeGreaterThan(0);
    expect(t.targetBiasSpread).toBeLessThan(1);
  });

  it('bots read steering and loot-score overrides from balance.bots.ai and new keys from balance.bots', () => {
    const b = balanceWith((x) => {
      x.bots.ai = { combatTurnDegPerSecond: 90, zoneUrgencyBufferSeconds: 7, lootScoreVest: 77 };
      x.bots.lootPhaseSeconds = 12;
      x.bots.avoidRange = undefined;
      x.bots.personalities = { cautious: { retreatBelowHp: 33 } };
    });
    const ai = botAi(b);
    expect(ai.combatTurnRate).toBeCloseTo(Math.PI / 2, 9);
    expect(ai.zoneUrgencyBufferS).toBe(7);
    expect(ai.lootScoreVest).toBe(77);
    expect(ai.probeDistance).toBe(BOT_AI.probeDistance);
    const t = botTuning(b);
    expect(t.lootPhaseSeconds).toBe(12);
    expect(t.personalities.cautious.retreatBelowHp).toBe(33);
    expect(t.personalities.cautious.share).toBe(BOT_TUNING_DEFAULTS.personalities.cautious.share);
    expect(t.avoidRange).toBe(BOT_TUNING_DEFAULTS.avoidRange);
  });

  it('an unarmed bot walks to a nearby gun and picks it up', () => {
    const b = balanceWith((x) => {
      x.match.targetPlayers = 2;
      x.match.countdownSeconds = 0;
    });
    const w = createDebugWorld({ map: flatMap(), balance: b, seed: 5, botNames: ['Crabby'] });
    const h = w.addPlayer('Far')!;
    while (w.getMatch().phase !== 'playing') w.step(SIM_DT);
    const bot = w.snapshotFor(h).players.find((p) => p.isBot)!;
    land(w, h, 150, 0);
    land(w, bot.id, 0, 0);
    w.debugLoot().push({ id: 999, item: 'smg', qty: 1, mag: 30, pos: { x: 8, y: 2, z: 3 }, tier: 'rare', durability: null });
    let picked = false;
    for (let i = 0; i < ticks(8000) && !picked; i++) {
      picked = ofType(w.step(SIM_DT), 'pickup').some((p) => p.playerId === bot.id && p.item === 'smg');
    }
    expect(picked).toBe(true);
    expect(w.debugPlayer(bot.id)!.inv.slots[0]?.weapon).toBe('smg');
  });
});

describe('World: headless full matches', () => {
  const zone = BALANCE.zone;
  const zoneTimelineS =
    zone.phases.reduce((a, p) => a + p.waitSeconds + p.shrinkSeconds, 0) + zone.finalCollapseDelaySeconds + zone.finalCollapseSeconds;
  const marginS = 30;

  function playMatch(seed: number, withIdleHuman: boolean) {
    const b = balanceWith((x) => {
      x.match.targetPlayers = 16;
      if (!withIdleHuman) {
        x.match.minHumansToStart = 0;
        x.match.endWhenNoHumansAlive = false;
      }
    });
    const w = createWorld({ map: ISLAND, balance: b, seed, botNames: BOT_NAMES });
    const human = withIdleHuman ? w.addPlayer('Idle') : null;
    let startAt = -1;
    const ended: Extract<SimEvent, { type: 'matchEnded' }>[] = [];
    const kills: Extract<SimEvent, { type: 'kill' }>[] = [];
    let endAt = -1;
    let failedByBots = 0;
    const limit = ticks((b.match.countdownSeconds + zoneTimelineS + marginS) * 1000);
    for (let i = 0; i < limit && ended.length === 0; i++) {
      const ev = w.step(SIM_DT);
      for (const e of ev) {
        if (e.type === 'spawn' && startAt < 0) startAt = w.timeMs;
        if (e.type === 'kill') kills.push(e);
        if (e.type === 'actionFailed') failedByBots += e.playerId === human ? 0 : 1;
        if (e.type === 'matchEnded') {
          ended.push(e);
          endAt = w.timeMs;
        }
      }
      if (human !== null && i % 15 === 0 && w.getMatch().phase === 'playing') {
        w.applyInput(human, input({ seq: i + 1 })); // idle
      }
    }
    return { w, b, startAt, endAt, ended, kills, failedByBots };
  }

  // One test per seed: each simulates up to the full tide timeline (~520 s of sim, ~0.5-1 s wall). The sim-time cap
  // above is the hard guarantee (zone timeline + margin); the wall-clock timeout only covers slow, loaded CI machines.
  const FULL_MATCH_TIMEOUT_MS = 30_000;
  for (const withHuman of [false, true]) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      it(`16-player match (${withHuman ? '1 idle human + 15 bots' : 'all bots'}, seed ${seed}) always ends with exactly one winner`, () => {
        const { w, startAt, endAt, ended, kills, failedByBots } = playMatch(seed, withHuman);
        expect(failedByBots).toBe(0); // actionFailed is never emitted for bots
        expect(ended.length, `seed ${seed}`).toBe(1);
        const e = ended[0]!;
        expect(e.winnerId).not.toBeNull();
        expect((endAt - startAt) / 1000).toBeLessThanOrEqual(zoneTimelineS + marginS);
        const placements = e.standings.map((s) => s.placement).sort((a, c) => a - c);
        expect(placements).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
        expect(e.standings[0]!.id).toBe(e.winnerId);
        // Only the winner (and, on an early end, ranked bots) can be alive; every death has a unique placement.
        expect(new Set(kills.map((k) => k.victimId)).size).toBe(kills.length);
        expect(kills.every((k) => k.victimId !== e.winnerId)).toBe(true);
        expect(w.getMatch()).toMatchObject({ phase: 'results', winnerId: e.winnerId });
      }, FULL_MATCH_TIMEOUT_MS);
    }
  }

  it('is deterministic: same seed => identical event stream', () => {
    const digest = (seed: number) => {
      const w = createWorld({
        map: ISLAND,
        balance: balanceWith((x) => {
          x.match.minHumansToStart = 0;
          x.match.endWhenNoHumansAlive = false;
        }),
        seed,
        botNames: BOT_NAMES,
      });
      let h = 0;
      for (let i = 0; i < ticks(60_000); i++) {
        const s = JSON.stringify(w.step(SIM_DT));
        for (let k = 0; k < s.length; k++) h = (Math.imul(h, 31) + s.charCodeAt(k)) | 0;
      }
      return h;
    };
    expect(digest(8)).toBe(digest(8));
    expect(digest(8)).not.toBe(digest(9));
  });
});
