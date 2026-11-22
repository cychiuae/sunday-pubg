# System: Per-Match Layout Variety (gameplay rules) (M2c)

Numbers: `balance.json` `layout.*` and `maps.office.layout.*` (live). The level-designer owns the candidate pools,
groups, scatter zones and arrangements (`docs/design/levels/*.md`, `src/game/levels/`); graphics owns the look presets; the tech-lead owns
the `(mapData, layoutSeed) -> MatchLayout` contract. This doc sets the **gameplay rules** that every layout must satisfy.
Scope tags: **M2c**, **Later**, **Maybe**.

## Purpose
Every match should feel a little new without becoming unfair or unlearnable. The map's shape, POIs and routes stay; what moves is where
the loot lies, which cover is where inside a POI, and the light. Players keep their knowledge ("the summit has epic loot, the dock has
crates to fight around") while the details reward looking, not memorising. Decision it creates: you cannot autopilot the same loot route
every match; you scan, adapt and pick a path.

## Player-facing rules
### What varies (per map, from `layoutSeed`)
- **Island**: scatter decoration; each POI picks one of 2-4 prop arrangements (huts, crates, cover); loot points are picked from a
  larger candidate pool; one look preset (morning, noon, golden hour, overcast).
- **Office**: each desk zone picks one of several arrangements (rows, pods, rotated, a few removed); clutter scattered; loot from a
  candidate pool; one lighting preset (daytime, evening, after-hours with fewer lights). Walls, rooms, doors, glass and climb routes are
  fixed.

### What never varies (fairness rules)
1. **Loot quantity per POI is fixed; only positions change.** Each loot group (a POI, a room, a corridor stretch; level-designer) has a
   fixed `use` count per tier. The sum over groups equals `layout.lootUsedPerTier` (island 51 / 19 / 7, office 50 / 20 / 8, today's
   counts). The tier totals are exact on every seed. Two per-group exceptions are intended: the island beach ring alternates 2 / 1
   per gap, and the office spawn-loot top-up moves plain commons between groups (acceptance test 2). Epic points exist only in the
   epic groups. So the reason to land at a POI never changes, and `loot.md` expected counts hold.
2. **Candidates**: each group has at least `ceil(use x layout.lootCandidateFactorMin)` (1.5) candidates and at least `use + 1`, so there is
   always real variety. Exception: a group the level data marks `fixed` with a `fixedNote` (for example the office SW perch epic, 1 of 1,
   where a second spot would break the 30 m-from-spawn rule). Activated loot points are at least `layout.minLootSpacing` (2.0 m) apart
   (the island data uses a stricter 2.5 m; fine). Then each activated point rolls `loot.spawnChance` and its tier table as today, except
   **guaranteed-weapon points** (`guarantee: 'weapon'`; island 12, office 16), which always spawn one gun from `loot.guaranteedWeapon`
   at L1-L2 (`loot.md`), so every spawn has a gun within 25 m (island) or 35 m of floor path (office).
3. **Cover parity**: every arrangement of a POI or desk zone keeps at least `layout.minCoverFraction` (0.8) of the largest arrangement's
   blocking collider footprint. An arrangement can be different, not much barer or much safer.
4. **Routes and access**: spawns, carrier drop landing areas, doors, corridors and climb-route ends stay clear; every activated loot point
   is reachable on foot; the zone's possible final centres (`MapData.zoneCenters`) stay reachable (hard guarantees, tested over 200+
   seeds per map, brief item 1).
5. **Look presets are cosmetic and readable (confirmed).** No preset changes the sim: bot vision, hearing, spread, damage and the zone are
   identical in every preset, including `overcast` and `afterHours`. None may hide players: the level-designer's limits in
   `levels/variety.md` are adopted (island: a chibi fully visible to at least 120 m, sun elevation >= 15 deg, outlines always on; office
   after-hours: every corridor, aisle, room and alcove has a lit panel and every floor point is within 20 m of one). The preset pick weights
   (island noon 35 / morning 25 / golden hour 25 / overcast 15; office daytime 50 / evening 30 / after-hours 20) are presentation, not
   gameplay, so they **stay in the level data**, not in balance.json. Bots ignore presets.
6. **Everyone sees the same layout.** Colliding props are sim data from the seed; non-colliding decoration is client-only but also from
   the seed. No prop list goes over the wire.
7. **Reproducible**: the layout seed is shown in the Esc/settings panel ("Layout 4821", narrative text) and on the results screen so a
   player can report it; `LAYOUT_SEED=` pins it (dev/QA).

## States and transitions
Lobby -> vote lock (map resolved) -> `layoutSeed` derived from the match seed -> layout built on the server and every client (office nav
grid built here, target <= 250 ms) -> carrier -> match. The layout never changes during a match (broken glass is match state, not layout).

## Tunable values
`layout.lootUsedPerTier.{common, rare, epic}` (per-map override `maps.<id>.layout`), `layout.lootCandidateFactorMin`,
`layout.minLootSpacing`, `layout.minCoverFraction`. Assumptions for the level-designer (please confirm or push back):
- Loot candidates are grouped; each group has a tier and a `use` count in MapData; totals stay at today's 51 / 19 / 7 and 50 / 20 / 8.
- Existing loot points stay as candidates (so today's layout is one of the possible layouts), and new candidates are added nearby.
- Arrangement variants per POI: 2-4 on the island, 3+ per desk zone on the office.

## Edge cases
- A candidate inside a prop of the chosen arrangement: invalid data; the generator must skip it (and the test flags it). The group then
  needs another candidate; that is why there are at least `use + 1`.
- Two activated points closer than 2.0 m: the generator rerolls (deterministically) within the group.
- A seed whose layout breaks a hard guarantee: the generator must not ship it; deterministic fallback (e.g. the next arrangement index).
  QA's 200-seed sweep must find zero fallbacks needed for the shipped data; any fallback is logged.
- Bots: loot targets come from the activated points only; bot drop targets (`drop.md`) use them too.

## What the UI must show
Layout seed in the Esc panel and on results. Nothing else (no "new layout" banner).

## What audio and VFX feedback is needed
Ambient audio may follow the look preset (morning birds, evening crickets, office after-hours hum): audio-designer's call, cosmetic.

## Acceptance tests (QA; data and sim tests over >= 200 seeds per map)
1. Determinism: the same `(mapData, layoutSeed)` gives an identical MatchLayout on server and client builds (hash compare).
2. Loot counts, on every seed (202 per map). **Tier totals are exact**: activated loot per tier equals `layout.lootUsedPerTier`
   (island 51/19/7, office 50/20/8), and guaranteed-weapon points number 12 (island) / 16 (office). Per group, the generator
   guarantees only this:
   - Island POI groups and `inland`: exactly their `lootPick` per tier.
   - Island `beach` ring: 36 commons. With phase p from the seed, gap k activates 2 (one guaranteed weapon) when (k + p) is even,
     else 1, so the gaps alternate 2 / 1 around the ring (12 of each). Per gap the count varies by seed; that is intended.
   - Office epic and rare groups: exactly their `pick`. A short group may fill from an earlier same-tier group's unused candidate,
     still counted under its own id.
   - Office guaranteed-weapon regions: exactly 1 each.
   - Office plain common groups (all other commons): each starts at its `pick` (sum 34). The spawn-loot top-up (`levels/variety.md`
     §5.4b) may then move plain commons between groups, at most 4 moves per short spawn. A group loses only a point beyond 30 m of
     every fallback spawn and gains only one of its own candidates within 29 m of the short spawn. Per group the count is therefore
     between 0 and its candidate count (no tighter bound); the plain-common sum stays 34. Over 202 seeds QA saw `cc.ncorr` 2-3,
     `cc.aisle` 3-4, `cc.scorr` 2-3, `cc.rooms` 8-10. These are for information only, not pass thresholds.
3. Every group has >= ceil(use x 1.5) and >= use + 1 candidates (data test, no seed).
4. Activated loot points are >= 2.0 m apart and none lies inside a collider; all are reachable on foot from the map's main area (island
   flood fill, office nav grid).
5. Cover parity: for each POI and desk zone, min arrangement footprint >= 0.8 x max arrangement footprint (data test).
6. Over 200 seeds the island and office satisfy the brief's hard guarantees (spawns and landing areas clear, doors and climb ends clear,
   office stuck rate < 2%, final-circle centres reachable, render budgets).
7. `LAYOUT_SEED=4821` gives the same layout on two runs; the Esc panel and results show 4821.
8. Pacing: `matchReport.ts` over 30 matches with random layouts keeps the median match length within 300-480 s (balance v9) and bot zone deaths no
   higher than with the fixed layout + 0.5 per match.

## Affected agents
level-designer (groups, candidates, arrangements, scatter zones, data tests), tech-lead (MatchLayout contract, seed derivation),
game-developer (generator, loot activation, bots), graphics-designer and graphics-engineer (look presets, readability, budgets),
ui-ux-designer and narrative-designer (layout seed text), audio-designer (optional ambience), qa-tester.
