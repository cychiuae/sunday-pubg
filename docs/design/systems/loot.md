# System: Loot (MVP, updated for M2a and M2c)

M2c changes (new items, weapon levels, scopes, activated points per layout) are in the section "M2c" below. They are live since balance
v6 and replace the M2a tables further down (kept for history).

Numbers: `balance.json` sections `loot`, `items`, `weapons`. Spawn points: `MapData.lootSpawns` (level-designer). Server-authoritative.

## Purpose
Give every landing spot a fair chance at a fighting kit within about 30 s, while rare and epic POIs tempt players into contested drops.
M2a: epic POIs are now the only source of tier-3 armor and almost the only source of snipers, so the contested drop has a visible payoff.

## Rules
- At match start, each loot spawn rolls `spawnChance`. On success it picks one item id from `loot.tiers[spawn.tier]` by weight.
- Quantities: weapon = 1 (mag full if `weaponSpawnsWithFullMag`), ammo = `items.<ammo>.pickupQty`, heals = `items.<heal>.spawnQty`,
  grenade = `items.grenade.spawnQty` (M2a), vest_N / helmet_N = 1 at full `items.<id>.durability` (M2a).
- Each weapon (other than fists) also spawns `extraAmmoWithWeapon` stacks of its ammo type within `extraAmmoScatter` m of it
  (sniper: 2 x 5 `ammo_sniper`, so a sniper spawn carries 5 + 10 = 15 rounds).
- Pickups float `pickupBobHeight` above the terrain and spin (client-side only). Each pickup is an entity with
  `{id, itemId, qty, mag?, durability?, x, z}` (`durability` for armor, M2a).
- Death drops, weapon swap drops and armor swap drops create the same pickup entities (`combat.md`, `armor.md`). M2a death drops add the
  grenade stack and the worn vest and helmet (`armor.dropOnDeath`).
- There are no respawns of loot during a match.
- Unknown item ids in `loot.tiers` are a data bug: validation should reject them (a typo would otherwise silently spawn nothing).

## M2a tier tables (weights; each tier sums to about 100)
| Item | Common | Rare | Epic |
|---|---|---|---|
| pistol | 20 | 3 | - |
| smg | 12 | 14 | 6 |
| shotgun | 10 | 12 | 9 |
| rifle | 2 (M1: 3) | 9 (M1: 14) | 14 (M1: 30) |
| lmg | - | 7 | 4 |
| dmr | - | 5 | 10 |
| sniper | - | 1 | 9 |
| bandage | 20 | 9 | 4 |
| medkit | 2 | 8 | 14 |
| vest_1 | 6 | 3 | - |
| vest_2 | - | 8 | 5 |
| vest_3 | - | - | 9 |
| helmet_1 | 5 | 2 | - |
| helmet_2 | - | 7 | 4 |
| helmet_3 | - | - | 8 |
| grenade | 5 | 6 | 5 |
| ammo_light | 11 | 2 | - |
| ammo_heavy | 4 | 4 | - |
| ammo_shell | 5 | 2 | - |
| ammo_sniper | - | - | 2 |
| **Total** | 102 | 102 | 103 |

Brief guidance applied: snipers mostly epic (9 of 10 sniper weight is epic, and epic spawns are rare), DMR rare and epic, LMG rare,
level-3 armor epic only, grenades in every tier.

### Expected items per match (for level-designer and balance checks)
At 70 spawns (65% common, 25% rare, 10% epic) and `spawnChance` 0.8: about 36.4 common, 14 rare and 5.6 epic items.
Expected count of item X = 36.4 x w_common / 102 + 14 x w_rare / 102 + 5.6 x w_epic / 103.

| Item | Arithmetic | Per match |
|---|---|---|
| rifle | 36.4 x 2/102 + 14 x 9/102 + 5.6 x 14/103 = 0.71 + 1.24 + 0.76 | 2.7 (M1: 4.7) |
| lmg | 14 x 7/102 + 5.6 x 4/103 = 0.96 + 0.22 | 1.2 |
| dmr | 14 x 5/102 + 5.6 x 10/103 = 0.69 + 0.54 | 1.2 |
| sniper | 14 x 1/102 + 5.6 x 9/103 = 0.14 + 0.49 | 0.6 (in roughly half of matches) |
| vest_1 / vest_2 / vest_3 | 2.14 + 0.41 / 1.10 + 0.27 / 0.49 | 2.6 / 1.4 / 0.5 |
| helmet_1 / helmet_2 / helmet_3 | 1.78 + 0.27 / 0.96 + 0.22 / 0.43 | 2.1 / 1.2 / 0.4 |
| grenade stacks | 1.78 + 0.82 + 0.27 | 2.9 stacks = 5.8 grenades |

Long guns in total (rifle + lmg + dmr + sniper) rise from 4.7 to about 5.75 per match, but no single type exceeds 2.7. Vests in total
(4.4) are close to M1 (4.9); helmets (3.7) are new.

## Expected density (for level-designer)
With 12 players, aim for **60-80 loot spawns**: about 65% common, 25% rare, 10% epic. Epic spawns go only at 1-2 contested POIs. Each
POI needs at least 4 spawns, and at least 3 weapon chances should be reachable within 25 m of any player spawn. At 70 spawns this gives
about 56 items, about 22 of them weapons (about 2 per player). M2a asks: epic POIs should have at least one long sightline (60 m+) out of
them, so a sniper found there has a use, and some low cover (logs, rocks) where crouch and prone matter.

## M2c: new items, levels, scopes and layout (live; tuning round 1 applied)
### Rule changes
- **Activated points** (`layout.md`): each match activates a fixed number of loot points per group and tier from a larger candidate pool
  (island 51 common / 19 rare / 7 epic, office 50 / 20 / 8). Each activated point then rolls `spawnChance` (0.8) and its tier table as
  before. Positions vary per match; counts per POI do not.
- **Weapon level**: a rolled weapon (gun, melee or RPG) also rolls its level from `levels.lootTiers[spot tier]` (`levels.md`): common
  70/25/5/0, rare 32/45/21/2, epic 8/32/45/15 for L1/L2/L3/L4 (tuning round 1). Armor, scopes, ammo, heals and throwables have no level.
- **Quantities**: melee weapon 1 (no ammo extras, `ammo` null); RPG 1 with mag 1 plus `extraAmmoWithWeapon` (2) stacks of `ammo_rocket`
  x `pickupQty` 1 = 3 rockets; smoke `items.smoke.spawnQty` (2); scope 1; vest_4 / helmet_4 1 at full durability; dbshotgun mag 2 plus 2 x
  10 shells; revolver mag 6 plus 2 x 25 heavy.
- **Ground glow** shows the item's **level** colour with its numeral/pips (`levels.md`), replacing the M2a spot-tier colours. Items with
  no level (ammo, heals, throwables, scopes) glow neutral white. Gun pickups also show their mounted scope (`scopes.md`).
- Every M2b id keeps a weight; the new ids are revolver, dbshotgun, rpg, knife, machete, paddle, smoke, vest_4, helmet_4, ammo_rocket,
  scope_red_dot, scope_2x, scope_4x, scope_8x.

### M2c tier tables (island = base; weights)
| Item | Common | Rare | Epic | | Item | Common | Rare | Epic |
|---|---|---|---|---|---|---|---|---|
| pistol | 6 | 1 | - | | bandage | 17 | 6 | 1 |
| revolver (new) | 4 | 3 | - | | medkit | 2 | 6 | 11 |
| smg | 5 | 12 | 4 | | vest_1 | 6 | 2 | - |
| shotgun | 3 | 9 | 7 | | vest_2 | - | 8 | 3 |
| dbshotgun (new) | - | 4 | 5 | | vest_3 | - | - | 8 |
| rifle | 2 | 9 | 12 | | vest_4 (new) | - | - | 2 |
| lmg | - | 7 | 4 | | helmet_1 | 5 | 1 | - |
| dmr | - | 5 | 9 | | helmet_2 | - | 7 | 2 |
| sniper | - | 1 | 8 | | helmet_3 | - | - | 7 |
| rpg (new) | - | - | 4 | | helmet_4 (new) | - | - | 2 |
| knife (new) | 6 | - | - | | grenade | 4 | 5 | 3 |
| machete (new) | 1 | 3 | - | | smoke (new) | 4 | 4 | 3 |
| paddle (new) | - | 2 | 2 | | ammo_light | 6 | 1 | - |
| scope_red_dot (new) | 5 | 2 | - | | ammo_heavy | 4 | 1 | - |
| scope_2x (new) | - | 6 | - | | ammo_shell | 3 | 2 | - |
| scope_4x (new) | - | 3 | 4 | | ammo_sniper | - | - | 2 |
| scope_8x (new) | - | - | 3 | | ammo_rocket (new) | - | - | 1 |

Totals: common 83, rare 110, epic 107. Office overrides (`maps.office.loot.tiers`, replacing the M2b office values): common pistol 4,
revolver 3, smg 3, shotgun 2, knife 9, grenade 6; rare grenade 7; epic sniper 5, shotgun 10, scope_8x 2 (totals 82 / 112 / 106). Reasons:
more frags and shotguns indoors, fewer long-range tools for the 234 m aisle, fewer plain guns than the island because the office has 16
guaranteed weapons, and more knives so unarmed office bots fight with a blade rather than fists.

### Guaranteed weapons (M2c, with `levels/variety.md`)
- Loot points the level data flags `guarantee: 'weapon'` (island 12, all beach commons; office 16 regions) **always** spawn (spawnChance 1)
  one gun from `loot.guaranteedWeapon.weights`: island pistol 40 / revolver 15 / smg 25 / shotgun 20; office (override) pistol 45 /
  revolver 20 / smg 15 / shotgun 20 (less SMG; the office SMG share was 33.7% in M2b). Level from `loot.guaranteedWeapon.levels`
  80 / 20 / 0 / 0 (L1-L2 only). Normal extra ammo (2 stacks).
- They count as common points (island 51 = 12 guaranteed + 39 plain; office 50 = 16 + 34).
- **Offset, revised in tuning round 1:** the first design cut plain common gun weights from 39 to 15 to offset the guarantees. Pacing run
  1 showed that this left too few guns: unarmed bots crowded the same guns in the loot phase (island first kill 37 s vs 146 s with more
  guns, median 338 s). Plain common guns are now 20 (island) and 14 (office). Island: 39 plain points x 0.8 = 31.2 items over 83 = 0.376
  per weight point (non-gun commons about 6% below the M2b-sized table); all guns 29.3 per match (M2b: 28.0). Office: 27.2 over 82 = 0.332
  per point; all guns 31.1, accepted because indoor fights start close and every fallback spawn has a gun within 35 m of path. Weights
  cut to make room: some bandages and medkits, pistol (into the revolver), frags (into smoke), loose ammo (guns already spawn with 2
  stacks), a little SMG and shotgun (into the double barrel and melee).

### M2c expected items per match
Items: guaranteed points give 12 guns (island) / 16 (office); plain points x 0.8: island 31.2 common, 15.2 rare, 5.6 epic; office 27.2,
16, 6.4. Expected count of X = guaranteed x share(X) + items_tier x w_tier(X) / total_tier, summed over tiers. Factors per weight point:
island 0.37590 / 0.13818 / 0.05234; office 0.33171 / 0.14286 / 0.06038 (tuning round 1 tables).

| Item | Island arithmetic (guaranteed + common + rare + epic) | Island | Office |
|---|---|---|---|
| pistol | 4.8 + 2.255 + 0.138 | 7.19 | 8.67 |
| revolver | 1.8 + 1.504 + 0.415 | 3.72 | 4.62 |
| smg | 3.0 + 1.880 + 1.658 + 0.209 | 6.75 | 5.35 |
| shotgun | 2.4 + 1.128 + 1.244 + 0.366 | 5.14 | 5.75 |
| dbshotgun | 0.553 + 0.262 | 0.81 | 0.87 |
| rifle | 0.752 + 1.244 + 0.628 | 2.62 | 2.67 |
| lmg | 0.967 + 0.209 | 1.18 | 1.24 |
| dmr | 0.691 + 0.471 | 1.16 | 1.26 |
| sniper | 0.138 + 0.419 | 0.56 | 0.44 |
| rpg | 4 x 0.0523 | 0.21 (1 match in 5) | 0.24 |
| **guns** | 12 + 7.52 + 7.05 + 2.77 | **29.3** (about 2.4 per player) | **31.1** |
| knife / machete / paddle | 2.26 / 0.376 + 0.415 / 0.276 + 0.105 | 2.26 / 0.79 / 0.38 (3.4) | 2.99 / 0.76 / 0.41 (4.2) |
| vest_1 / 2 / 3 / 4 | 2.255 + 0.276 / 1.105 + 0.157 / 0.419 / 0.105 | 2.53 / 1.26 / 0.42 / 0.10 | 2.28 / 1.32 / 0.48 / 0.12 |
| helmet_1 / 2 / 3 / 4 | 1.880 + 0.138 / 0.967 + 0.105 / 0.366 / 0.105 | 2.02 / 1.07 / 0.37 / 0.10 | 1.80 / 1.12 / 0.42 / 0.12 |
| grenade stacks (x2) | 1.504 + 0.691 + 0.157 | 2.35 = 4.7 frags | 3.17 = 6.3 frags |
| smoke stacks (x2) | 1.504 + 0.553 + 0.157 | 2.21 = 4.4 smokes | 2.08 = 4.2 smokes |
| bandage stacks / medkits | 6.39 + 0.829 + 0.052 / 0.752 + 0.829 + 0.576 | 7.27 / 2.16 | 6.56 / 2.18 |
| scope red dot / 2x / 4x / 8x | 1.880 + 0.276 / 0.829 / 0.415 + 0.209 / 0.157 | 2.16 / 0.83 / 0.62 / 0.16 (3.8) | 1.61 / 0.86 / 0.67 / 0.12 (3.3) |
| rockets | 0.21 x 3 + 0.05 loose | 0.68 | 0.79 |

Compared with M2b on the same 77 points: guns 28.0 -> 29.3 (12 now placed so every spawn has one within 25 m), plus 3.4 melee weapons;
SMGs 7.2 -> 6.8 and pumps 6.3 -> 5.1 (their share moves to the revolver, double barrel and melee); pistols 8.4 -> 7.2 (the revolver
takes 3.7); rifles about the same (2.9 -> 2.6); vests and helmets slightly fewer, plus about 0.2 tier-4 pieces; frags 6.3 -> 4.7 plus 4.4
smokes; heals about 24% fewer (bandage stacks 9.6 -> 7.3, medkits 2.75 -> 2.2), because smoke is now a second way to survive a lost fight.
If matchReport shows the median below 330 s, give the bandage weight back first. Gun levels per island match: about 17.3 L1, 8.3 L2, 3.1
L3, 0.56 L4 (`levels.md`).

## Edge cases
- Two players pressing E on the same pickup in the same tick: the first input processed wins. The other gets nothing (no error prompt needed).
- A partial pickup leaves the remainder as the same entity with reduced qty (ammo, heals, grenades).
- Armor pickups are all-or-nothing (qty 1) and keep their `durability` when dropped and re-picked.
- Loot spawning inside a prop collider is a level-data bug. The server should log it, and QA should test it.

## UI / audio / VFX
Pickup prompt: "[E] Rifle" / "[E] Light Ammo x30" / "[E] Vest (Lv 2) 55/55" / "[E] Grenade x2". Rarity colour on the floating item glow
(common white, rare blue, epic gold). The colour comes from the spawn tier, and drops inherit it per item using a fixed table (M2a):
- **epic (gold)**: dmr, sniper, medkit, vest_3, helmet_3, ammo_sniper
- **rare (blue)**: rifle (was epic in M1), lmg, smg, shotgun, vest_2, helmet_2
- **common (white)**: pistol, bandage, vest_1, helmet_1, grenade, ammo_light, ammo_heavy, ammo_shell
Pickup sound, and a different sound for "full/refused".

## Acceptance tests
1. With `spawnChance` 1 and a seed, every loot spawn has exactly one item plus the ammo extras for weapons.
2. Over 10,000 rolls of each tier table, the observed frequencies match the weights within 2%.
3. A rifle spawn has 2 `ammo_heavy` stacks of 25 within 0.8 m, and the rifle mag is 25. A sniper spawn has 2 `ammo_sniper` stacks of 5
   and a mag of 5. An LMG spawn has a mag of 60.
4. The epic table never yields pistol, ammo_light, ammo_heavy, ammo_shell, vest_1 or helmet_1.
5. vest_3 and helmet_3 never come from the common or rare tables (10,000 rolls each).
6. A spawned vest_2 has durability 55; a spawned helmet_3 has durability 75; a grenade spawn has qty 2.
7. No table contains the M1 id `vest`, and validation rejects an unknown id in any table.

M2c:
8. Over 10,000 rolls per tier (island and office merged balances) the frequencies match the M2c weights within 2 points.
9. The epic table never yields pistol, revolver, knife, machete, scope_red_dot, scope_2x, vest_1 or helmet_1; rpg, vest_4, helmet_4,
   scope_8x and ammo_rocket come only from epic (10,000 rolls of common and rare).
10. An RPG spawn has mag 1 and 2 `ammo_rocket` stacks of 1 within 0.8 m; a melee spawn has no ammo extras; a smoke spawn has qty 2; a
    scope spawn has qty 1 and no level.
11. Weapon levels: over 10,000 rolls, weapons from common spots are never L4, and level frequencies per spot tier match
    `levels.lootTiers` within 2 points.
12. Per match (any layout seed), activated points per tier equal `layout.lootUsedPerTier` for the map (`layout.md`).
13. `matchReport.ts` (30 matches per map): the mean per-match counts of guns, melee, smokes and scopes are within 15% of the table above.
14. Guaranteed weapons: with `spawnChance` forced to 0, every `guarantee: 'weapon'` point still spawns exactly one gun (plus 2 ammo
    stacks) and nothing else spawns. Over 10,000 rolls the island guaranteed guns are pistol 40% / revolver 15% / smg 25% / shotgun 20%
    (office 45 / 20 / 15 / 20) within 2 points, and their levels are L1 80% / L2 20%, never L3 or L4.
