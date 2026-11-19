/**
 * M2c gate prep (ARCHITECTURE §16.5, ADR 0007 §10): the World fills every new state and event field with the
 * M2b-equivalent value (level 1, built-in sights, no rockets / smoke / broken glass, frag selected).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { LocalM2cFields, PlayerM2cFields, SimEvent } from '../types';
import { AMMO_IDS, M2C_ITEM_IDS } from '../types';
import { createInventory } from './inventory';
import { dropTierOf } from './loot';
import { flatMap, land, playingWorld, run } from './testkit';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const ticks = (ms: number) => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);

function world() {
  const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
  ids.forEach((id, i) => land(w, id, i * 40, 0));
  const id = ids[0]!;
  return { w, ids, id, p: w.debugPlayer(id)! };
}

describe('World M2c gate prep', () => {
  it('snapshot: empty rockets, smokes and brokenPanes', () => {
    const { w, id } = world();
    const snap = w.snapshotFor(id);
    expect(snap.rockets).toEqual([]);
    expect(snap.smokes).toEqual([]);
    expect(snap.brokenPanes).toEqual([]);
  });

  it('PlayerState: weaponLevel 1 and the built-in sight for a gun; null and none for fists and the grenade', () => {
    const { w, id, p } = world();
    const me = () => w.snapshotFor(id).players.find((s) => s.id === id) as unknown as PlayerM2cFields;
    expect(me()).toMatchObject({ weaponLevel: null, sight: 'none' });
    p.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    p.inv.activeSlot = 0;
    expect(me()).toMatchObject({ weaponLevel: 1, sight: BALANCE.weapons.sniper.sight });
    p.inv.slots[0] = { weapon: 'rifle', mag: 5, level: 3 };
    expect(me()).toMatchObject({ weaponLevel: 3, sight: BALANCE.weapons.rifle.sight });
    p.inv.grenades = 1;
    p.inv.activeSlot = 3;
    expect(me()).toMatchObject({ weaponLevel: null, sight: 'none' });
  });

  it('LocalPlayerState: no melee, no smoke, frag selected, empty pouch, no scope switch; ammo has every AmmoId', () => {
    const { w, id } = world();
    const local = w.snapshotFor(id).local!;
    expect(local as unknown as LocalM2cFields).toMatchObject({
      melee: null,
      smokes: 0,
      selectedThrowable: 'grenade',
      spareScope: null,
      scopeSwapRemainingMs: 0,
    });
    expect(Object.keys(local.ammo).sort()).toEqual([...AMMO_IDS].sort());
    expect(Object.keys(createInventory().ammo).sort()).toEqual([...AMMO_IDS].sort());
  });

  it('grenade events and state say kind grenade; the explosion says source grenade; a frag kill has weaponLevel null', () => {
    const { w, id, p } = world();
    p.inv.grenades = 2;
    p.inv.activeSlot = 3;
    const n = ticks(200);
    const ev = run(w, n + 1, { [id]: (i) => ({ fire: i < n, pitch: 0.3 }) });
    expect(ofType(ev, 'grenadeCook')[0]).toMatchObject({ kind: 'grenade' });
    expect(ofType(ev, 'grenadeThrown')[0]).toMatchObject({ kind: 'grenade' });
    expect(w.snapshotFor(id).grenades.map((g) => g.kind)).toEqual(['grenade']);
    const rest = run(w, ticks(BALANCE.items.grenade.fuseMs + 200));
    expect(ofType(rest, 'explosion')[0]).toMatchObject({ source: 'grenade' });
    for (const b of ofType([...ev, ...rest], 'grenadeBounce')) expect(b.kind).toBe('grenade');

    const { w: w2, ids } = world();
    const victim = w2.debugPlayer(ids[1]!)!;
    victim.hp = 1;
    w2.debugSpawnGrenade(ids[0]!, { ...victim.move.pos, y: victim.move.pos.y + 0.2 }, { x: 0, y: 0, z: 0 }, 50);
    const kill = ofType(run(w2, 3), 'kill')[0]!;
    expect(kill).toMatchObject({ weapon: 'grenade', weaponLevel: null });
  });

  it('a gun kill carries weaponLevel 1', () => {
    const { w, ids } = world();
    const [s, t] = ids as [number, number];
    land(w, t, 0, -5);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'shotgun', mag: BALANCE.weapons.shotgun.magSize };
    sp.inv.activeSlot = 0;
    w.debugPlayer(t)!.hp = 1;
    const pitch = Math.atan2(0.5 - BALANCE.player.eyeHeight, 5);
    const ev = run(w, 2, { [s]: (i) => ({ fire: i === 0, pitch }) });
    expect(ofType(ev, 'kill')[0]).toMatchObject({ weapon: 'shotgun', weaponLevel: 1 });
  });

  it('drop tiers cover every item id, the M2c ones included (the table stays exhaustive after the gate)', () => {
    const tierOf = dropTierOf as (id: string) => string | undefined;
    for (const id of M2C_ITEM_IDS) expect(['common', 'rare', 'epic']).toContain(tierOf(id));
  });
});
