# System: Item Levels (weapons and armor, L1-L4) (M2c)

Numbers: `balance.json` `levels.*` (staged in `_m2cPending.levels` until the M2c types land), armor in `items.vest_N` / `items.helmet_N`.
Server-authoritative: the level of every weapon instance, pickup and worn piece. Related: `combat.md` (TTK tables at L1 and L4),
`loot.md` (level rolls), `armor.md` (vest_4, helmet_4), `melee.md`, `rpg.md`.
Scope tags: **M2c** = this milestone, **Later**, **Maybe**.

## Purpose
One power curve the player learns once. A gold-banded rifle is the same rifle with a little more punch, so a player who knows the rifle
knows what an L3 rifle does. Levels make every pickup a small decision ("L2 SMG or L1 rifle?"), give a reason to keep looting after you
have a kit, and give contested epic spots a visible payoff. They must never make an L1 player helpless: the guide is about 25-35% faster
time to kill (TTK) from L1 to L4 on the same gun, never a different weapon.

## Player-facing rules
### What has a level
- **Every weapon except fists**: guns, melee weapons (`melee.md`) and the RPG. `ItemLevel = 1 | 2 | 3 | 4`.
- **Armor**: `vest_1..4`, `helmet_1..4`. The armor level is the id suffix (a vest_3 is level 3). Same colours, numerals and names as weapons.
- **No level**: fists, ammo, heals, frag grenades, smoke grenades.
- The level is part of the item. It travels with drops (death, swap, upgrade) and pickups. A weapon created without a roll (dev spawn,
  test world) is L1.

### What a level changes
Effective stat = base stat (`weapons.<id>.<field>`) x multiplier[level - 1]. Per field, the multiplier comes from
`levels.overrides.<id>.<field>` if present, else the class default (`levels.gun` or `levels.melee`), else 1. **L1 = today's numbers
exactly** (every array starts with 1).

| Class / weapon | damage L1..L4 | reloadMs | fireIntervalMs | spreadDeg |
|---|---|---|---|---|
| Guns (default) | 1 / 1.08 / 1.16 / 1.25 | 1 / 0.95 / 0.90 / 0.85 | 1 | 1 |
| Melee (default) | 1 / 1.08 / 1.16 / 1.25 | - | 1 / 0.93 / 0.86 / 0.80 (also scales `hitFrameMs`) | - |
| Shotgun (pump) | 1 / 1 / 1 / 1 | gun default | 1 / 0.95 / 0.90 / 0.85 | 1 / 0.92 / 0.85 / 0.78 |
| DMR | 1 / 1.05 / 1.10 / 1.15 | gun default | 1 / 0.93 / 0.86 / 0.80 | 1 |
| Sniper | 1 / 1.06 / 1.12 / 1.20 | gun default | 1 / 0.93 / 0.86 / 0.80 | 1 |
| RPG | 1 / 1.05 / 1.10 / 1.15 (impact and blast) | 1 / 0.93 / 0.86 / 0.80 | 1 | 1 |

Why the overrides:
- **Shotgun**: 9 pellets x 11 = 99. Any damage scaling above 1.0101 would make a full-pellet body shot a one-shot kill at L2 already. The
  pump's identity is "never a one-shot body kill" (the dbshotgun owns one-shots), so its levels tighten the cone and speed up the pump.
  An L4 pump lands about 1.6 times more pellets at 8 m, so it reaches further rather than hitting harder.
- **DMR**: x1.25 would make two body shots (105) a kill at up to ~100 m. Capped at x1.15 (96.6 for two), with a faster trigger instead.
- **Sniper**: x1.25 would make an L4 body shot exactly 100 (a kill). At x1.2: body 96 never kills, the head (192) kills through a helmet_3
  but not through a fresh helmet_4 (`armor.md`).
- **RPG**: x1.15 keeps a fresh vest_3 alive after an L4 direct hit (172.5 < 175, `rpg.md`).

Mag size, range, falloff, ADS values, pellets and melee reach never change with level.

### Rolling levels (loot)
A weapon rolled at a loot spot gets a level from `levels.lootTiers[spotTier]` (relative weights for L1..L4, seeded match RNG):

| Spot tier | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| common | 70 | 25 | 5 | 0 |
| rare | 30 | 45 | 22 | 3 |
| epic | 5 | 30 | 45 | 20 |

Expected weapon levels per island match (26.2 guns: 15.6 common-spot, 7.6 rare-spot, 2.94 epic-spot; `loot.md`): L1 13.4 (51%), L2 8.2
(31%), L3 3.8 (14%), L4 0.82 (3%, 72% of them from epic spots). Most guns are L1-L2, and an L4 gun turns up in about 55% of matches.
Melee weapons use the same tables. Armor is not rolled (its level is its id; vest_4 and helmet_4 are epic-only, `loot.md`).

### Picking up
- **Upgrade swap (new rule)**: if one of your gun slots holds the **same weapon id at a lower level**, E on the higher-level pickup replaces
  **that** slot (even if the other slot is empty, and whichever slot you hold). The old weapon drops at your feet with its mag and level.
  The new one keeps its own mag. If you were holding the replaced slot you keep holding it (no swap time); otherwise the active slot does
  not change. Prompt: "[E] Swap Rifle Lv1 -> Lv3" (narrative text).
- Same id at the same or a lower level: the normal pickup rules (`combat.md`: first empty slot, else the held slot).
- Melee: E on any melee pickup takes it into the melee slot and drops your current melee weapon, whatever the levels (`melee.md`).
- Armor: unchanged rule (`armor.md`): the pickup is worn only if its level is higher than the worn piece's level.

### One level scale for the player
- **Level colours, numerals and pips** are shared by the HUD slots, the ground loot glow, the pickup prompt, the kill feed weapon icon,
  the inventory, the armor icons and a tint band on the world and view model. Colour is never the only cue: every level shows its numeral
  (1-4) or 1-4 pips.
- The ground glow now shows the **item's level** (replacing the M2a spot-tier colour). Items without a level glow neutral white with no
  pips.
- **Palette proposal** (graphics-designer and ui-ux-designer finalise the hex values; must pass a deuteranopia/protanopia/tritanopia check
  with the numerals hidden, and rise in brightness or saturation with level): L1 driftwood (pale warm grey), L2 seafoam (teal),
  L3 coral (orange), L4 orchid-sunset (magenta-violet with a soft sparkle). This is an original beach palette, not a copy of any game's
  white/green/blue/purple/orange set.
- **Names**: narrative-designer names the four levels in `en.json` (`level.1.name` .. `level.4.name`, proposal keys). Avoid "common/rare/
  epic/legendary" so the level names do not clash with the loot spot tiers.

## States and transitions
A level never changes on an item. `WeaponInstance = {id, mag, level}`; ground loot `{..., level?}`; worn armor `{tier (= level), durability}`.
Upgrade swap: `Slot(id, L_old, mag_old)` -> E on `(id, L_new > L_old)` -> `Slot(id, L_new, mag_new)` + ground `(id, L_old, mag_old)`.

## Tunable values
`levels.gun.*`, `levels.melee.*`, `levels.overrides.<id>.*`, `levels.lootTiers.*`, `levels.botValueMultiplier`. Validation (tech-lead):
each array has exactly 4 numbers, index 0 is exactly 1, every entry in [0.5, 2]; overrides keys are WeaponIds other than fists; fields
are only damage / reloadMs / fireIntervalMs / spreadDeg; lootTiers weights >= 0 with a positive sum.
**Design invariants (balance.test should assert them at L4):** sniper `damage x m4 < maxHp`; sniper head at L4 minus a fresh helmet_4's
absorb `< maxHp`; DMR `2 x damage x m4 < maxHp`; pump `pellets x damage x m4 < maxHp`; RPG L4 `impact + blast.maxDamage` minus a fresh
vest_3's absorb `< maxHp`.
**Expected to need playtest tuning**: `levels.gun.damage[3]` (1.25), `levels.lootTiers.rare/epic`, `botValueMultiplier`.

## Edge cases
- Two copies of the same id at different levels, both carried (e.g. picked up before the rule applied, or L3 + L3): allowed. The upgrade
  swap replaces the lower one; on a tie of lower levels, slot 0.
- Upgrade swap while reloading the replaced slot: the reload is cancelled, no ammo is moved. While healing: the heal continues unless the
  active slot changes (it does not).
- Upgrade swap of the gun you are aiming with: ADS resets to 0 (`combat.md` ADS blocks, same as a swap).
- Ammo is per type, not per level: an L4 rifle and an L1 rifle share `ammo_heavy`.
- Kill feed and death screen show the killer's weapon **with its level** at the moment of the kill.
- Bots: the same rules. A dropped L4 weapon is a magnet for bots (value x1.6).

## What the UI must show (ui-ux-designer)
Weapon slots: level colour band plus numeral or pips. Pickup prompt: name, level, and for weapons "Swap Lv1 -> Lv3" when the upgrade
swap applies. Ground glow by level. Kill feed: weapon icon tinted by level plus numeral. Armor icons: level 1-4 (adds 4). Remote players:
the held weapon's level band on the world model (needs the held level in `PlayerState`). Optional (Later): a stat-compare tooltip.

## What audio and VFX feedback is needed
- Graphics: a tint band or glow strip on each weapon model (view and world) in the level colour; L4 adds a subtle sparkle. Ground glow
  colour = level. Armor tier 4 visuals for vest and helmet, readable at 30 m by shape as well as colour.
- Audio: pickup sound pitched or layered by level (L3-L4 get a brighter chime); no change to gun sounds (level does not change how a gun
  sounds, so players judge the threat by sight).

## Network (for tech-lead and network-engineer)
`ItemLevel` on: inventory weapon slots and the melee slot (local), ground loot entities (weapons; armor already has the id), and the held
weapon's level in `PlayerState` (2 bits). Kill and damage events carry the weapon level for the feed. Server-authoritative; clients never
compute damage from levels except for UI previews.

## Bots
Gun and melee loot value = `lootValue x levels.botValueMultiplier[level - 1]` (1 / 1.2 / 1.4 / 1.6). The existing upgrade rule (replace when
new > old x `bots.ai.gunUpgradeFactor` 1.15) then prefers higher levels: L1 -> L2 of the same gun is an upgrade (1.2 > 1.15). Armor
already scores by tier (`lootScoreArmorPerTier` x 1-4).

## Acceptance tests (QA, Vitest on src/shared/sim)
1. Base equality: for every weapon, the effective L1 stats equal `weapons.<id>` exactly.
2. Rifle body hit at 10 m: L1 19, L2 20.52, L3 22.04, L4 23.75 (+-0.001). Reload: L1 2400, L4 2040 ms.
3. Pistol L4 (25 per hit): 4 body hits kill a 100 HP unarmored target (hp exactly 0 -> dead); 3 leave 25.
4. Shotgun L4: damage per pellet stays 11; hip spread 5.46 deg standing still; pump 765 ms; point-blank 9-pellet body hit leaves 1 HP.
5. Sniper L4: body 96 (100 HP target -> 4 HP); head 192 vs fresh helmet_3 -> dead; vs fresh helmet_4 -> 8 HP, helmet destroyed. Bolt 1120 ms.
6. DMR L4: body 48.3; two body hits leave 3.4 HP; trigger interval 320 ms.
7. Knife L4: damage 42.5, swing 280 ms, hit frame 80 ms.
8. Loot rolls: 10,000 weapon rolls per spot tier match `levels.lootTiers` within 2 percentage points; common spots never give L4.
9. A weapon dropped on death, by a swap, or by an upgrade swap keeps its level and mag; picking it up again restores both.
10. Upgrade swap: carrying an L1 rifle in slot 1 and an SMG in slot 0 (holding slot 0), E on an L3 rifle: slot 1 = L3 rifle with the
    pickup's mag, an L1 rifle pickup with the old mag lies at the feet, the active slot is still 0, no swap time. E on an L1 rifle while
    carrying an L3 rifle and an empty slot: it goes into the empty slot (normal rule).
11. Validation: a `levels` array of length 3, an L1 entry of 1.1, or an override for `fists` fails `validateBalance`.
12. Snapshot: a remote player's held weapon level is visible to other clients; a ground weapon pickup carries its level.
13. Bots (seeded): a bot carrying an L1 rifle walks to and takes an L2 rifle within `lootSearchRadius` when no enemy is visible.
14. balance.test design invariants listed under "Tunable values" hold.

## Affected agents
tech-lead (ItemLevel type, levels validation, WeaponInstance/LootState/PlayerState fields), game-developer (stat resolution, loot level
roll, upgrade swap, bots), network-engineer (level fields, PROTOCOL_VERSION 4), ui-ux-designer (bands, numerals, prompts, kill feed),
graphics-designer and graphics-engineer (palette, tint bands, ground glow, tier-4 armor), narrative-designer (level names, swap prompt),
audio-designer (pickup chime by level), qa-tester.
