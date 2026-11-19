/**
 * layout.md acceptance 2-3 cross-checks (qa-tester, M2c), measured over 202 seeds per map from the real generator.
 * AC 2 (rewritten after BUG-015): tier totals exact; per group: island POI / inland groups exact; the island beach ring
 * alternates 2 / 1 by a seeded phase (12 gaps of each, 36 commons); office epic, rare and guaranteed-weapon groups exact;
 * office plain commons sum to 34 (per group anything from 0 to its candidates after the §5.4b top-up).
 * AC 3 is a data rule ("every group has >= ceil(use x 1.5) and >= use + 1 candidates"); here it is checked from the
 * outside: across 202 layouts each group's distinct activated positions must reach that count.
 */
import { describe, expect, it } from 'vitest';
import { getMap } from '../../src/game/levels';
import { buildMatchLayout } from '../../src/game/levels/layout/index';
import { BALANCE } from '../../src/shared/balance';
import type { LootSpawn } from '../../src/shared/types';

const SEEDS = Array.from({ length: 202 }, (_, i) => (i * 2654435761 + 12345) >>> 0);

interface Stats {
  perSeed: Map<string, Set<number>>;
  distinct: Map<string, Set<string>>;
  tiers: Record<string, Set<number>>;
  layouts: LootSpawn[][];
}
const cache = new Map<string, Stats>();
function stats(mapId: string): Stats {
  const hit = cache.get(mapId);
  if (hit) return hit;
  const base = getMap(mapId);
  const perSeed = new Map<string, Set<number>>();
  const distinct = new Map<string, Set<string>>();
  const tiers: Record<string, Set<number>> = {};
  const layouts: LootSpawn[][] = [];
  for (const seed of SEEDS) {
    const l = buildMatchLayout(base, seed, { decor: false });
    layouts.push(l.lootSpawns);
    const counts = new Map<string, number>();
    const tierCount: Record<string, number> = { common: 0, rare: 0, epic: 0, guaranteed: 0 };
    for (const s of l.lootSpawns) {
      const g = s.group ?? '(none)';
      counts.set(g, (counts.get(g) ?? 0) + 1);
      if (!distinct.has(g)) distinct.set(g, new Set());
      distinct.get(g)!.add(`${s.x.toFixed(2)},${s.z.toFixed(2)},${(s.y ?? 0).toFixed(2)}`);
      tierCount[s.tier] = (tierCount[s.tier] ?? 0) + 1;
      if (s.guarantee === 'weapon') tierCount.guaranteed!++;
    }
    for (const g of new Set([...counts.keys(), ...perSeed.keys()])) {
      if (!perSeed.has(g)) perSeed.set(g, new Set());
      perSeed.get(g)!.add(counts.get(g) ?? 0);
    }
    for (const [t, n] of Object.entries(tierCount)) (tiers[t] ??= new Set()).add(n);
  }
  const s = { perSeed, distinct, tiers, layouts };
  cache.set(mapId, s);
  return s;
}
function shortGroups(mapId: string): string[] {
  const { perSeed, distinct } = stats(mapId);
  const bad: string[] = [];
  for (const [g, uses] of perSeed) {
    const use = Math.max(...uses);
    const need = Math.max(Math.ceil(use * 1.5), use + 1);
    const got = distinct.get(g)!.size;
    if (got < need) bad.push(`${g}: ${got} distinct points over 202 seeds, need ${need} (use ${use})`);
  }
  return bad;
}
const used = (mapId: string): Record<string, number> | undefined => {
  const b = BALANCE as unknown as { maps: Record<string, { layout?: { lootUsedPerTier?: Record<string, number> } }>; layout?: { lootUsedPerTier?: Record<string, number> } };
  return b.maps?.[mapId]?.layout?.lootUsedPerTier ?? b.layout?.lootUsedPerTier;
};

for (const [mapId, guaranteed] of [['island01', 12], ['office', 16]] as const) {
  describe(`layout.md 2-3 on ${mapId} (202 seeds)`, () => {
    it('AC 2 (tiers): activated loot per tier is exactly layout.lootUsedPerTier and the guaranteed-weapon count is fixed, on every seed', () => {
      const { tiers } = stats(mapId);
      console.info(`[layout ${mapId}] tiers per seed ${JSON.stringify(Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, [...v]])))}; lootUsedPerTier ${JSON.stringify(used(mapId))}`);
      for (const t of ['common', 'rare', 'epic', 'guaranteed']) expect([...tiers[t]!], `${mapId} ${t}`).toHaveLength(1);
      const u = used(mapId);
      if (u) for (const t of ['common', 'rare', 'epic']) expect([...tiers[t]!][0], `${mapId} ${t}`).toBe(u[t]);
      expect([...tiers.guaranteed!][0]).toBe(guaranteed);
    }, 120_000);

    it('AC 3: every group reaches >= max(ceil(use x 1.5), use + 1) distinct points (BUG-015 fixed: ep.perchSW included)', () => {
      expect(shortGroups(mapId)).toEqual([]);
      expect(stats(mapId).perSeed.size).toBeGreaterThan(1);
    }, 120_000);
  });
}

describe('layout.md AC 2 per-group rules', () => {
  it('island: POI and inland groups exact per seed; the beach ring has 36 commons, 12 gaps of 2 and 12 of 1, alternating', () => {
    const { perSeed, layouts } = stats('island01');
    const varying = [...perSeed].filter(([g, n]) => !g.startsWith('beach.') && n.size !== 1).map(([g, n]) => `${g}: ${[...n].join('/')}`);
    expect(varying).toEqual([]);
    for (const spawns of layouts) {
      const gaps = new Map<string, number>();
      for (const s of spawns) if (s.group?.startsWith('beach.')) gaps.set(s.group, (gaps.get(s.group) ?? 0) + 1);
      const counts = [...gaps.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, n]) => n);
      expect(counts.reduce((a, n) => a + n, 0)).toBe(36);
      expect(counts.filter((n) => n === 2)).toHaveLength(12);
      expect(counts.filter((n) => n === 1)).toHaveLength(12);
      for (let k = 0; k < counts.length; k++) expect(counts[k]! + counts[(k + 1) % counts.length]!, `gap ${k}`).toBe(3);
    }
  }, 120_000);

  it('office: epic, rare and guaranteed-weapon groups exact per seed; plain commons sum to 34', () => {
    const { perSeed, layouts } = stats('office');
    const plain = (s: LootSpawn) => s.tier === 'common' && s.guarantee !== 'weapon';
    const plainGroups = new Set(layouts.flat().filter(plain).map((s) => s.group));
    const varying = [...perSeed].filter(([g, n]) => !plainGroups.has(g) && n.size !== 1).map(([g, n]) => `${g}: ${[...n].join('/')}`);
    expect(varying).toEqual([]);
    for (const [g, n] of perSeed) if (g.startsWith('gw.')) expect([...n], g).toEqual([1]);
    for (const spawns of layouts) expect(spawns.filter(plain)).toHaveLength(34);
  }, 120_000);
});
