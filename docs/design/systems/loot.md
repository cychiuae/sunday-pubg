# System: Loot (MVP)

Numbers: `balance.json` sections `loot`, `items`, `weapons`. Spawn points: `MapData.lootSpawns` (level-designer). Server-authoritative.

## Purpose
Give every landing spot a fair chance at a fighting kit within about 30 s, while rare and epic POIs tempt players into contested drops.

## Rules
- At match start, each loot spawn rolls `spawnChance`. On success it picks one item id from `loot.tiers[spawn.tier]` by weight.
- Quantities: weapon = 1 (mag full if `weaponSpawnsWithFullMag`), ammo = `items.<ammo>.pickupQty`, heals = `items.<heal>.spawnQty`, vest = 1.
- Each weapon (other than fists) also spawns `extraAmmoWithWeapon` stacks of its ammo type within `extraAmmoScatter` m of it.
- Pickups float `pickupBobHeight` above the terrain and spin (client-side only). Each pickup is an entity with `{id, itemId, qty, mag?, x, z}`.
- Death drops and swap drops create the same pickup entities (see `combat.md`).
- There are no respawns of loot during a match.

## Expected density (for level-designer)
With 12 players, aim for **60-80 loot spawns**: about 65% common, 25% rare, 10% epic. Epic spawns go only at 1-2 contested POIs. Each POI needs at least 4 spawns, and
at least 3 weapon chances should be reachable within 25 m of any player spawn. At 70 spawns this gives about 56 items, about 22 of them weapons (about 2 per player).

## Edge cases
- Two players pressing E on the same pickup in the same tick: the first input processed wins. The other gets nothing (no error prompt needed).
- A partial pickup leaves the remainder as the same entity with reduced qty.
- Loot spawning inside a prop collider is a level-data bug. The server should log it, and QA should test it.

## UI / audio / VFX
Pickup prompt: "[E] Rifle" / "[E] Light Ammo x30". Rarity colour on the floating item glow (common white, rare blue, epic gold). The colour comes from the spawn tier,
and drops inherit it per item using a fixed table: rifle and medkit are epic-coloured, smg, shotgun and vest are rare, everything else is common. Pickup sound, and a different
sound for "full/refused".

## Acceptance tests
1. With `spawnChance` 1 and a seed, every loot spawn has exactly one item plus the ammo extras for weapons.
2. Over 10,000 rolls of the common table, the observed frequencies match the weights within 2%.
3. A rifle spawn has 2 `ammo_heavy` stacks of 25 within 0.8 m, and the rifle mag is 25.
4. The epic table never yields pistol or ammo.
