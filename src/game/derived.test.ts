import { describe, expect, it } from 'vitest';
import type { GameEvents } from '../shared/events';
import {
  CountdownTracker,
  findNearestLoot,
  InteractPromptTracker,
  PhaseTracker,
  pickupRefusal,
  RemoteMotionTracker,
  StrideCounter,
  ZoneStatusTracker,
  ZoneTracker,
  type Bus,
} from './derived';
import { BALANCE } from '../shared/balance';
import type { LootState } from '../shared/types';
import { makeLocal, makeMatch, makePlayer, makeZone } from './testFixtures';
import { isOutsideZone, zoneAt } from './zoneView';

function recorder() {
  const events: { type: keyof GameEvents; payload: unknown }[] = [];
  const bus: Bus = { emit: (type, payload) => events.push({ type, payload }) };
  return { bus, events };
}

describe('PhaseTracker', () => {
  it('emits on the first snapshot (prev null) and on each change only', () => {
    const { bus, events } = recorder();
    const t = new PhaseTracker();
    t.onSnapshot(makeMatch({ phase: 'lobby' }), bus);
    t.onSnapshot(makeMatch({ phase: 'lobby' }), bus);
    t.onSnapshot(makeMatch({ phase: 'countdown', phaseEndsAt: 10_000 }), bus);
    expect(events).toEqual([
      { type: 'matchPhaseChanged', payload: { phase: 'lobby', prev: null, endsAt: null } },
      { type: 'matchPhaseChanged', payload: { phase: 'countdown', prev: 'lobby', endsAt: 10_000 } },
    ]);
  });
});

describe('CountdownTracker', () => {
  it('emits N..1 once each, ignoring jitter upward', () => {
    const { bus, events } = recorder();
    const t = new CountdownTracker();
    for (const now of [0, 100, 999, 1001, 900, 2500, 8999, 9001, 9999, 10_000, 10_500]) t.update(10_000, now, bus);
    expect(events.map((e) => (e.payload as { secondsLeft: number }).secondsLeft)).toEqual([10, 9, 8, 2, 1]);
  });

  it('restarts when the countdown restarts', () => {
    const { bus, events } = recorder();
    const t = new CountdownTracker();
    t.update(3_000, 0, bus);
    t.update(null, 100, bus);
    t.update(5_000, 200, bus);
    expect(events.map((e) => (e.payload as { secondsLeft: number }).secondsLeft)).toEqual([3, 5]);
  });
});

describe('ZoneTracker', () => {
  it('zoneChanged on first zone, phase change and shrinking change', () => {
    const { bus, events } = recorder();
    const t = new ZoneTracker();
    t.onSnapshot(null, bus);
    t.onSnapshot(makeZone(), bus);
    t.onSnapshot(makeZone({ radius: 99 }), bus);
    t.onSnapshot(makeZone({ shrinking: true }), bus);
    t.onSnapshot(makeZone({ phaseIndex: 1 }), bus);
    expect(events.filter((e) => e.type === 'zoneChanged')).toHaveLength(3);
  });

  it('zoneWarning once per phase when the wait drops to warningSeconds', () => {
    const { bus, events } = recorder();
    const t = new ZoneTracker();
    const zone = makeZone({ phaseEndsAt: 60_000 });
    t.updateWarning(zone, 40_000, 1, 10, bus);
    t.updateWarning(zone, 50_500, 1, 10, bus);
    t.updateWarning(zone, 55_000, 1, 10, bus);
    t.updateWarning({ ...zone, shrinking: true }, 61_000, 1, 10, bus);
    expect(events).toEqual([{ type: 'zoneWarning', payload: { phaseIndex: 0, secondsUntilShrink: 10 } }]);
    // Next match, same phase index -> warns again.
    t.updateWarning(zone, 55_000, 2, 10, bus);
    expect(events).toHaveLength(2);
  });

  it('no warning before the first phase (-1)', () => {
    const { bus, events } = recorder();
    new ZoneTracker().updateWarning(makeZone({ phaseIndex: -1 }), 55_000, 1, 10, bus);
    expect(events).toHaveLength(0);
  });
});

describe('ZoneStatusTracker', () => {
  it('emits on crossing only', () => {
    const { bus, events } = recorder();
    const t = new ZoneStatusTracker();
    t.set(false, bus);
    t.set(true, bus);
    t.set(true, bus);
    t.set(false, bus);
    expect(events.map((e) => (e.payload as { outside: boolean }).outside)).toEqual([true, false]);
  });
});

describe('interact prompt', () => {
  const loot: LootState[] = [
    { id: 1, item: 'pistol', qty: 1, pos: { x: 2, y: 0, z: 0 } },
    { id: 2, item: 'bandage', qty: 3, pos: { x: 1, y: 0, z: 0 } },
    { id: 3, item: 'vest_2', qty: 1, pos: { x: 0, y: 5, z: 0 }, durability: 31 },
  ];

  it('findNearestLoot uses 3D distance within range', () => {
    expect(findNearestLoot(loot, { x: 0, y: 0, z: 0 }, 2.2)?.id).toBe(2);
    expect(findNearestLoot(loot, { x: 0, y: 4, z: 0 }, 2.2)?.id).toBe(3);
    expect(findNearestLoot(loot, { x: 50, y: 0, z: 0 }, 2.2)).toBeNull();
  });

  it('emits when id or qty changes, and null when out of range', () => {
    const { bus, events } = recorder();
    const t = new InteractPromptTracker();
    t.set(null, bus);
    t.set(loot[1]!, bus);
    t.set(loot[1]!, bus);
    t.set({ ...loot[1]!, qty: 1 }, bus);
    t.set(null, bus);
    expect(events.map((e) => e.payload)).toEqual([
      { lootId: 2, item: 'bandage', qty: 3, durability: null, maxDurability: null, refusal: null },
      { lootId: 2, item: 'bandage', qty: 1, durability: null, maxDurability: null, refusal: null },
      { lootId: null, item: null, qty: 0, durability: null, maxDurability: null, refusal: null },
    ]);
  });

  it('M2a: carries armor durability and re-emits when the refusal changes', () => {
    const { bus, events } = recorder();
    const t = new InteractPromptTracker();
    t.set(loot[2]!, bus, null);
    t.set(loot[2]!, bus, null);
    t.set(loot[2]!, bus, 'betterArmor');
    t.set(null, bus, 'betterArmor'); // no loot: refusal is dropped
    expect(events.map((e) => e.payload)).toEqual([
      { lootId: 3, item: 'vest_2', qty: 1, durability: 31, maxDurability: null, refusal: null },
      { lootId: 3, item: 'vest_2', qty: 1, durability: 31, maxDurability: null, refusal: 'betterArmor' },
      { lootId: null, item: null, qty: 0, durability: null, maxDurability: null, refusal: null },
    ]);
  });

  it('M2b (REVIEW-M2a M6): maxDurability = items.<armor>.durability for armor, null otherwise (with balance)', () => {
    const { bus, events } = recorder();
    const t = new InteractPromptTracker();
    t.set(loot[2]!, bus, null, BALANCE);
    t.set(loot[1]!, bus, null, BALANCE);
    expect(events.map((e) => (e.payload as GameEvents['interactPromptChanged']).maxDurability)).toEqual([
      BALANCE.items.vest_2.durability,
      null,
    ]);
    t.reset();
    t.set(loot[1]!, bus, null, BALANCE);
    expect(events).toHaveLength(3);
  });

  it('M2a pickupRefusal: betterArmor for a same-or-lower tier, inventoryFull at carry limits, guns never', () => {
    const at = (item: LootState['item'], extra: Partial<LootState> = {}): LootState => ({ id: 9, item, qty: 1, pos: { x: 0, y: 0, z: 0 }, ...extra });
    const wearing = makeLocal(1, { vest: { tier: 2, durability: 5 }, helmet: null });
    expect(pickupRefusal(at('vest_2'), wearing, BALANCE)).toBe('betterArmor');
    expect(pickupRefusal(at('vest_1'), wearing, BALANCE)).toBe('betterArmor');
    expect(pickupRefusal(at('vest_3'), wearing, BALANCE)).toBeNull();
    expect(pickupRefusal(at('helmet_1'), wearing, BALANCE)).toBeNull();
    const full = makeLocal(1, {
      grenades: BALANCE.items.grenade.maxCarry,
      ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: BALANCE.items.ammo_sniper.maxCarry },
      heals: { bandage: BALANCE.items.bandage.maxStack, medkit: 0 },
    });
    expect(pickupRefusal(at('grenade'), full, BALANCE)).toBe('inventoryFull');
    expect(pickupRefusal(at('ammo_sniper'), full, BALANCE)).toBe('inventoryFull');
    expect(pickupRefusal(at('ammo_light'), full, BALANCE)).toBeNull();
    expect(pickupRefusal(at('bandage'), full, BALANCE)).toBe('inventoryFull');
    expect(pickupRefusal(at('medkit'), full, BALANCE)).toBeNull();
    expect(pickupRefusal(at('sniper'), full, BALANCE)).toBeNull();
    expect(pickupRefusal(at('grenade'), makeLocal(1, { grenades: 1 }), BALANCE)).toBeNull();
  });
});

describe('StrideCounter', () => {
  it('steps every stride of distance', () => {
    const s = new StrideCounter();
    let steps = 0;
    for (let i = 0; i < 100; i++) if (s.add(1, 0.1, 1.4)) steps++;
    expect(steps).toBe(7); // 10 m / 1.4 m
  });
});

describe('RemoteMotionTracker', () => {
  const tuning = { footstepStrideWalk: 1, footstepStrideSprint: 2, maxFrameTravel: 5 };
  const surface = () => 'sand' as const;

  it('emits footsteps from distance, jump on takeoff with upward velY, land with fall speed', () => {
    const { bus, events } = recorder();
    const t = new RemoteMotionTracker();
    const at = (x: number, extra: Partial<ReturnType<typeof makePlayer>> = {}) => [makePlayer(2, { pos: { x, y: 0, z: 0 }, ...extra })];
    t.update(at(0), 1, surface, tuning, bus);
    t.update(at(0.6), 1, surface, tuning, bus);
    t.update(at(1.2), 1, surface, tuning, bus); // 1.2 m -> one step
    const air = { ...makePlayer(2).anim, airborne: true };
    t.update(at(1.3, { anim: air, velY: 5 }), 1, surface, tuning, bus);
    t.update(at(1.4, { anim: air, velY: -7 }), 1, surface, tuning, bus);
    t.update(at(1.5), 1, surface, tuning, bus);
    expect(events.map((e) => e.type)).toEqual(['footstep', 'jump', 'land']);
    expect(events[2]!.payload).toMatchObject({ fallSpeed: 7, surface: 'sand', isLocal: false });
    // REVIEW-M2a M4: footsteps carry the remote's stance.
    expect(events[0]!.payload).toMatchObject({ stance: 'stand' });
    const { bus: bus2, events: ev2 } = recorder();
    const t2 = new RemoteMotionTracker();
    t2.update([makePlayer(2, { stance: 'prone', stanceFrom: 'prone' })], 1, surface, tuning, bus2);
    t2.update([makePlayer(2, { stance: 'prone', stanceFrom: 'prone', pos: { x: 1.1, y: 0, z: 0 } })], 1, surface, tuning, bus2);
    expect(ev2[0]!.payload).toMatchObject({ stance: 'prone' });
  });

  it('skips the local id, dead players and teleports', () => {
    const { bus, events } = recorder();
    const t = new RemoteMotionTracker();
    t.update([makePlayer(1), makePlayer(3, { alive: false })], 1, surface, tuning, bus);
    t.update(
      [makePlayer(1, { pos: { x: 9, y: 0, z: 0 } }), makePlayer(3, { alive: false, pos: { x: 3, y: 0, z: 0 } })],
      1,
      surface,
      tuning,
      bus,
    );
    const t2 = new RemoteMotionTracker();
    t2.update([makePlayer(4)], null, surface, tuning, bus);
    t2.update([makePlayer(4, { pos: { x: 40, y: 0, z: 0 } })], null, surface, tuning, bus);
    expect(events).toHaveLength(0);
  });
});

describe('zoneView', () => {
  it('extrapolates a linear shrink between snapshots', () => {
    const z = makeZone({ shrinking: true, radius: 100, targetRadius: 50, center: { x: 0, z: 0 }, targetCenter: { x: 10, z: 0 }, phaseEndsAt: 10_000 });
    const mid = zoneAt(z, 0, 5_000);
    expect(mid.radius).toBeCloseTo(75);
    expect(mid.center.x).toBeCloseTo(5);
    expect(zoneAt(z, 0, 20_000).radius).toBeCloseTo(50);
    const waiting = makeZone();
    expect(zoneAt(waiting, 0, 5_000)).toBe(waiting);
  });

  it('edge counts as inside', () => {
    const z = makeZone({ radius: 10 });
    expect(isOutsideZone({ x: 10, z: 0 }, z)).toBe(false);
    expect(isOutsideZone({ x: 10.01, z: 0 }, z)).toBe(true);
  });
});
