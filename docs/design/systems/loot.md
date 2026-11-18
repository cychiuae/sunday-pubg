# System: Loot (MVP, updated for M2a)

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
