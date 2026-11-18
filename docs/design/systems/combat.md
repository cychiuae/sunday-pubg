# System: Combat, Inventory and Heals (M1 MVP + M2a "Arsenal & Stance")

Numbers: `balance.json` sections `weapons`, `combat`, `items`, `armor`, `player`, `movement.stances`. Server-authoritative: everything here.
Related specs: `armor.md` (vests, helmets), `stance.md` (stand/crouch/prone, hitboxes), `grenades.md` (frag grenades).
Scope tags: **MVP** = M1, **M2a** = this milestone, **Later**, **Maybe**.

## Purpose
Short, readable gunfights where aim and positioning win, and loot choices (2 slots, armor tiers, heals, grenades) matter.
M2a adds a choice of *how* to fight each range: hip fire on the move vs aiming down sights (slower, accurate), standing vs
crouched or prone (smaller, steadier, slower), and close guns vs long guns.

## Player-facing rules
See GDD section 7 for the summary. The precise algorithms follow.

### Weapon roster (M2a)
| Weapon | Fire | Ammo | Sight | Role | Main weakness |
|---|---|---|---|---|---|
| Fists | auto melee | - | none | Desperation | 2 m reach |
| Pistol | semi | light | iron | Early sidearm | Low damage |
| SMG | auto | light | iron | Close range, run and gun | Falls off past 12 m, wide cone |
| Shotgun | pump | shell | iron | Point blank burst (99 max) | Useless past ~15 m, 0.9 s pump |
| Rifle | auto | heavy | red_dot | All-rounder at 10-45 m | Needs ADS beyond ~20 m (hip 1.6 deg), terrible on the move (x2.5) |
| LMG (M2a) | auto | heavy | red_dot | Planted suppression, 60 round mag | 5 s reload, wide hip cone, x0.55 move speed while firing, slow ADS |
| DMR (M2a) | semi | heavy | scope_4x | Long-range picks, 3 body / 2 head | Poor hip fire (3 deg), 400 ms per shot |
| Sniper (M2a) | bolt | sniper | scope_8x | One-shot headshot through helmet_1/2 | 1.4 s bolt, 5 rounds, 6 deg hip fire, 0.4 move speed scoped |

### Shot resolution (per fire event, server)
1. **Can fire**: alive, not dropping, not reloading, not swapping, **not in a stance transition** (M2a, `stance.md`), not holding the
   grenade slot (`grenades.md` handles LMB there), mag > 0 (fists are always able), and `now - lastShot >= fireIntervalMs`.
   For semi-auto and bolt weapons LMB must have been released since the last shot (fire-pressed edge). A press that arrives while
   firing is blocked (transition, swap, reload) is dropped; the player must click again. Holding LMB on an automatic weapon fires as
   soon as the block ends.
2. **Origin** = feet + (0, `eyeHeight(stance)`, 0), where `eyeHeight(stance)` is `movement.stances.<stance>.eyeHeight` (stand =
   `player.eyeHeight`). Direction = aim yaw/pitch. ADS does not move the origin; the scope view is drawn from the same eye point.
3. **Cone half-angle** = `effectiveSpreadDeg` (see "Spread" below).
4. For each of `pellets`: pick a direction uniformly inside the cone, then raycast up to `range` against terrain, prop colliders and
   every other alive, non-dropping player's **stance hitbox** (`stance.md` "Hitboxes"). The first hit wins. The shooter is excluded.
5. **Zone of the hit**: head or body, per the stance hitbox rule (stand: hitY >= feetY + height x (1 - `player.headZoneFraction`);
   crouch: `combat.hitbox.crouchHeadZoneFraction`; prone: the front `combat.hitbox.proneHeadLength` m of the box).
   `dmg = damage x (head ? headshotMultiplier : 1) x falloff(dist)`, falloff = 1 at or below `falloffStart`, lerps to
   `minDamageFactor` at `falloffEnd`, clamped beyond. If `falloffStart >= falloffEnd` the factor is 1 up to `falloffStart` and
   `minDamageFactor` beyond (the sniper uses 300/300/1.0 = no falloff anywhere in range).
6. **Armor** (`armor.md`): body damage goes through the vest, head damage through the helmet:
   `a = min(durability, dmg x absorbFraction)`, `durability -= a`, `hp -= dmg - a`. A piece that reaches 0 durability is destroyed.
   HP and durability are floats; the HUD shows `ceil`.
7. **Pellets** (shotgun): per target per shot, sum the head pellets' damage and the body pellets' damage separately, apply the
   helmet to the head sum and the vest to the body sum (head first; the pools are independent so order does not matter), then
   emit **one** damage event (headshot = true if any pellet hit the head). One hit marker, one kill credit.
8. Mag decreases by 1 per shot (not per pellet). If the mag is now 0 and reserve > 0, an auto-reload starts (this ends ADS).

### Spread (M2a, replaces the M1 step 3 formula)
```
cone = spreadDeg x A x S x M x J
A = 1 + (adsSpreadMultiplier - 1) x adsProgress          (adsProgress in [0, 1], see ADS)
S = combat.stanceSpreadMultiplier[stance]  if the stance is settled, else 1   (stand 1.0, crouch 0.8, prone 0.6)
M = moveSpreadMultiplier  if horizontal speed > combat.moveSpreadSpeedThreshold, else 1
J = combat.airSpreadMultiplier  if airborne, else 1
```
All four factors always multiply; there is no floor or cap. Crawling (1.25 m/s) and crouch-walking (2.75 m/s) are above the 1.0 m/s
threshold, so they count as moving. ADS walking slows you but stays above the threshold, except prone + ADS with a weapon whose
`adsMoveMultiplier` <= 0.8 (crawl 1.25 x 0.8 = 1.0, which is not above 1.0). An ADS crawl (0.5-1.0 m/s) is steady by design.

Resulting cones (degrees), `adsProgress` = 1 where ADS:

| Weapon | Hip still | Hip moving | ADS still | ADS moving | ADS crouch still | ADS prone still |
|---|---|---|---|---|---|---|
| Pistol | 1.5 | 3.0 | 0.9 | 1.8 | 0.72 | 0.54 |
| SMG | 3.0 | 4.2 | 1.95 | 2.73 | 1.56 | 1.17 |
| Shotgun | 7.0 | 8.4 | 5.95 | 7.14 | 4.76 | 3.57 |
| Rifle | 1.6 | 4.0 | 0.8 | 2.0 | 0.64 | 0.48 |
| LMG | 2.6 | 7.8 | 1.17 | 3.51 | 0.936 | 0.702 |
| DMR | 3.0 | 7.5 | 0.3 | 0.75 | 0.24 | 0.18 |
| Sniper | 6.0 | 18.0 | 0.12 | 0.36 | 0.096 | 0.072 |

Rule of thumb for players: a 0.45 m body at distance d is fully covered by the cone when tan(cone) x d <= 0.45, i.e. about
d <= 26 / cone_deg metres. Rifle ADS still: ~32 m; DMR ADS: ~86 m; sniper ADS: ~215 m; rifle hip moving: ~6.5 m.

### Aim down sights (ADS, M2a)
- **Input**: `PlayerInput.ads` (held). RMB, hold by default; Settings offers Hold/Toggle (the client turns toggle into the held flag,
  see UI). ADS is part of client prediction because it changes movement speed.
- **Engaged** on a tick iff `ads` is held AND the active weapon's `sight != "none"` (fists and the grenade slot have none) AND the
  player is alive, not dropping, not reloading, not healing, not swapping, and not in a stance transition. Airborne is allowed (air
  spread still applies).
- **Sprint**: while `ads` is held, sprint is suppressed (ADS wins, even if ADS is blocked by a reload). Pressing RMB while sprinting
  ends the sprint on that tick.
- **Progress**: per tick, before the fire check: if engaged, `adsMs = min(adsTimeMs, adsMs + dt x 1000)`, else `adsMs = 0`.
  `adsProgress = adsMs / adsTimeMs` (1 when `adsTimeMs` = 0 and engaged). Leaving ADS is instant in the sim; the client may blend the
  camera out over `clientFeel.adsExitBlendMs` (cosmetic).
- **Movement**: while engaged, ground speed x `adsMoveMultiplier` (full value from the first engaged tick; see `stance.md` speed formula).
- **Firing does not end ADS.** A swap, reload start (manual or auto), heal start, stance-change start, or death sets `adsMs = 0`. If RMB
  is still held when the block ends, ADS re-engages from 0.
- **Camera** (client, M2b first person; full rules in `camera.md` "ADS in first person"): the camera is at the eye, so the screen centre
  is the shot ray. Zoom is true magnification from the default FOV: `vFovAds = 2 atan(tan(vFovDefault / 2) / adsZoom)` (rifle at the
  default 80 deg: 32.8 deg vertical), blended by `cameraBlend`. Iron and red_dot: the viewmodel's sight anchor moves onto the screen
  centre and the hip crosshair fades out. scope_4x / scope_8x: at `adsProgress = 1` the full-screen scope overlay appears and the
  viewmodel is hidden. (Replaces the M2a over-shoulder ADS camera and its linear `fov / adsZoom` formula.)
- **Sensitivity** (client): look speed = base x `lerp(1, adsSensitivity, cameraBlend) / zoom`, where `adsSensitivity` is the Settings
  "ADS sensitivity" multiplier (default 1.0), `cameraBlend` in [0, 1] is the client's camera ADS blend (follows `adsProgress` in, eases
  out over `clientFeel.adsExitBlendMs`), and `zoom = tan(vFovPlayer / 2) / tan(vFovCurrent / 2)` is the current magnification. Blending
  both terms means the look speed never jumps when aiming starts or ends. Hip fire: cameraBlend 0, so the factor is 1. Full ADS with the
  sniper at the default FOV and setting: about 1 / 8.
- **Recoil** is visual only (`camera.md`): viewmodel kick, camera roll and FOV punch, never an aim offset. The spread formula above is the
  only accuracy rule.
- Per-weapon ADS numbers: see `weapons.<id>.adsZoom / adsSpreadMultiplier / adsMoveMultiplier / adsTimeMs`.

### LMG fire penalty (M2a)
For `combat.fireMoveWindowMs` (300) after each shot, ground speed x the weapon's `fireMoveMultiplier` (LMG 0.55, every other weapon 1).
Holding the trigger keeps the window open. Hip-firing LMG: 5 x 0.55 = 2.75 m/s; ADS + firing: 5 x 0.5 x 0.55 = 1.375 m/s.

### Sniper rules (M2a)
- Bolt action: `fireIntervalMs` (1400) is the bolt cycle. The scope stays up between shots. No separate key.
- No falloff, so every rule below holds at any distance up to `range` (300 m).
- **Body shot never kills a full-HP player**, with or without armor: no armor 80 -> 20 HP left; vest_2: a = min(55, 80 x 0.4 = 32) = 32,
  hp loss 48 -> 52 left; vest_3: a = min(75, 40) = 40, hp loss 40 -> 60 left.
- **Headshot (160 raw) kills a full-HP player through helmet_1 and helmet_2**: helmet_1 a = min(30, 48) = 30, loss 130; helmet_2
  a = min(45, 64) = 45, loss 115.
- **Headshot does not kill through a helmet_3 above 60 durability**: a = min(75, 80) = 75, loss 85 -> 15 HP left. In general the loss is
  160 - min(D, 80), which reaches 100 when D <= 60. So a helmet_3 saves you from exactly one sniper headshot (it then has 0 durability
  and is destroyed).
- Tuning constraint (keep it when changing numbers): with H = damage x headshotMultiplier,
  `H - min(helmet_2.durability, H x helmet_2.absorbFraction) >= 100` and
  `H - min(helmet_3.durability, H x helmet_3.absorbFraction) < 100` and `damage x 1 < 100`.

### Shots to kill (M2a)
**Method.** Every armor piece obeys the invariant `durability < 100 x f / (1 - f)` (`armor.md`). Over a series of hits on one piece
with total raw damage X, the piece absorbs `min(D, f x X)` in total, so HP loss = `X - min(D, f x X)`. While the piece holds
(f X <= D) the loss is (1 - f) X <= (1 - f) D / f < 100, so nobody dies before their armor breaks. Death therefore needs
**X >= 100 + D**: a fresh piece adds exactly its durability as effective HP against the hits it covers.

Raw damage thresholds (full HP): no armor 100 · vest_2 100 + 55 = **155** · helmet_2 100 + 45 = **145** · vest_3 100 + 75 = **175** ·
helmet_3 100 + 75 = **175**. Shots = ceil(threshold / raw per hit). Time = (shots - 1) x fireIntervalMs (ideal; the 30 Hz tick can add
up to 33 ms per shot). All values at or below `falloffStart`; shotgun = all 9 pellets on the same zone.

Raw per hit (body / head): fists 15/15 · pistol 20/35 · SMG 14/21 · shotgun 99/148.5 · rifle 19/34.2 · LMG 17/25.5 · DMR 42/73.5 ·
sniper 80/160.

| Weapon | No armor body | No armor head | vest_2 body (155) | helmet_2 head (145) | vest_3 body (175) | helmet_3 head (175) |
|---|---|---|---|---|---|---|
| Fists | 100/15 -> 7 (2.70 s) | 7 (2.70 s) | 155/15 = 10.3 -> 11 (4.50 s) | 145/15 = 9.7 -> 10 (4.05 s) | 175/15 = 11.7 -> 12 (4.95 s) | 12 (4.95 s) |
| Pistol | 100/20 = 5 (1.00 s) | 100/35 = 2.9 -> 3 (0.50 s) | 155/20 = 7.75 -> 8 (1.75 s) | 145/35 = 4.1 -> 5 (1.00 s) | 175/20 = 8.75 -> 9 (2.00 s) | 175/35 = 5 exactly (1.00 s) |
| SMG | 100/14 = 7.1 -> 8 (0.56 s) | 100/21 = 4.8 -> 5 (0.32 s) | 155/14 = 11.1 -> 12 (0.88 s) | 145/21 = 6.9 -> 7 (0.48 s) | 175/14 = 12.5 -> 13 (0.96 s) | 175/21 = 8.3 -> 9 (0.64 s) |
| Shotgun | 100/99 -> 2 (0.90 s) | 1 (0 s) | 155/99 -> 2 (0.90 s) | 145/148.5 -> 1 (0 s) | 175/99 -> 2 (0.90 s) | 175/148.5 -> 2 (0.90 s) |
| Rifle | 100/19 = 5.3 -> 6 (0.75 s) | 100/34.2 = 2.9 -> 3 (0.30 s) | 155/19 = 8.2 -> 9 (1.20 s) | 145/34.2 = 4.2 -> 5 (0.60 s) | 175/19 = 9.2 -> 10 (1.35 s) | 175/34.2 = 5.1 -> 6 (0.75 s) |
| LMG | 100/17 = 5.9 -> 6 (0.60 s) | 100/25.5 = 3.9 -> 4 (0.36 s) | 155/17 = 9.1 -> 10 (1.08 s) | 145/25.5 = 5.7 -> 6 (0.60 s) | 175/17 = 10.3 -> 11 (1.20 s) | 175/25.5 = 6.9 -> 7 (0.72 s) |
| DMR | 100/42 = 2.4 -> 3 (0.80 s) | 100/73.5 = 1.4 -> 2 (0.40 s) | 155/42 = 3.7 -> 4 (1.20 s) | 145/73.5 = 1.97 -> 2 (0.40 s) | 175/42 = 4.2 -> 5 (1.60 s) | 175/73.5 = 2.4 -> 3 (0.80 s) |
| Sniper | 100/80 = 1.25 -> 2 (1.40 s) | 1 (0 s) | 155/80 = 1.9 -> 2 (1.40 s) | 145/160 -> 1 (0 s) | 175/80 = 2.2 -> 3 (2.80 s) | 175/160 -> 2 (1.40 s) |

Reading the table: armor roughly doubles body TTK at tier 3 (rifle 0.75 s -> 1.35 s), so a fight against an epic-armored player is
long enough to react, reposition or throw a grenade, but never longer than ~1.6 s for any gun with a full mag (every mag covers its
worst case: rifle 25 >= 10, SMG 30 >= 13, LMG 60 >= 11, DMR 10 >= 5, pistol 12 >= 9).
The pistol vs helmet_3 entry is an exact boundary (5 x 35 = 175; all values are exact binary fractions, so it kills: hp = 0).

### Why the rifle no longer dominates (M1 finding: rifle took most kills)
1. **Damage 22 -> 19.** Unarmored body kill 5 -> 6 hits (0.60 -> 0.75 s). Headshot multiplier 1.75 -> 1.8 keeps 3 headshots lethal
   (3 x 34.2 = 102.6; 3 x 19 x 1.75 = 99.75 would leave 0.25 HP, which reads as a bug).
2. **Hip spread 1.0 -> 1.6 deg, falloff 40/110/0.7 -> 30/90/0.65.** Past ~20 m the rifle needs ADS, which costs 230 ms and 35% move
   speed. At 90 m it does 12.35 per hit (M1: 15.4 at 110 m).
3. **Competition at every range.** SMG still wins under ~12 m (0.56 s), the LMG out-DPSes it when planted (0.60 s), the DMR kills in
   3 shots at 40-180 m with a 0.3 deg cone, and the sniper owns 100 m+.
4. **Loot**: about 2.7 rifles per match (M1: 4.7), see `loot.md`.
5. **Bots** pick guns by range band (`bots.weaponPrefs`), so long-range bot kills move to the DMR and sniper.
Target (to confirm with `matchReport.ts` once the sim has the items): no single gun above 35% of weapon kills; rifle 15-30%.

### Inventory state
`slots: [WeaponInstance|null, WeaponInstance|null]`, fists implicit (slot 2), grenade slot (slot 3, M2a), `active: 0|1|2|3`,
`ammo: {light, heavy, shell, sniper}`, `heals: {bandage, medkit}`, `grenades: number` (M2a), `hp`,
`vest: {tier, durability} | null`, `helmet: {tier, durability} | null` (M2a, replaces `armor`), `stance`, stance transition timer,
`adsMs` (M2a). `WeaponInstance = {id, mag}`.
- Keys 1 / 2 / 3 / 4 select slot 0 / 1 / 2 / 3. **G** also selects slot 3. Selecting slot 3 with 0 grenades is refused
  (`actionFailed { action: 'swap', reason: 'noGrenades' }`). The mouse wheel cycles 0 -> 1 -> 2 -> 3 -> 0, skipping empty gun slots and slot 3 when
  `grenades` = 0.
- When the last grenade is thrown, the player auto-switches to the last gun slot used (or fists), paying `combat.swapMs`.

### Healing
Q runs the selection in GDD 7.4. Channel `useMs`. On completion: `hp = max(hp, min(hpCap, hp + heal))` with hpCap = item `healCap`,
then the item count decreases by 1. Cancelled by fire input, swap, reload, Q, death or match end, with no item consumed.
M2a: healing is allowed in every stance. Starting a heal ends ADS. Q while cooking a grenade is ignored (`grenades.md`).

## States and transitions (per player weapon state)
`Ready` -> fire -> `Cooldown (fireIntervalMs)` -> `Ready`
`Ready` -> R or empty-fire with reserve -> `Reloading (reloadMs)` -> `Ready` (swap or Q cancels)
any -> slot key -> `Swapping (combat.swapMs)` -> `Ready` (cancels reload and heal)
`Ready` or `Reloading` -> Q -> `Healing (useMs)` -> `Ready` (fire, swap, reload or Q cancels). Heal and reload are mutually exclusive
and the latest input wins.
M2a, orthogonal to the above: `ADS: Off <-> Engaged(adsMs)` per the ADS rules; `Stance: Settled(s) <-> Transition(from, to, ms)`
(`stance.md`); grenade slot states in `grenades.md`.

## Tunable values
`weapons.<id>.*` (including `sight`, `adsZoom`, `adsSpreadMultiplier`, `adsMoveMultiplier`, `adsTimeMs`, `fireMoveMultiplier`),
`combat.swapMs`, `combat.airSpreadMultiplier`, `combat.moveSpreadSpeedThreshold`, `combat.stanceSpreadMultiplier.*`,
`combat.fireMoveWindowMs`, `combat.hitbox.*`, `combat.deathDropScatter`, `items.<ammo>.*`, `items.vest_N/helmet_N.*`, `player.*`.
Nothing in this spec may be hard-coded.

**Expected to need playtest tuning**: rifle `damage` (19) and `spreadDeg` (1.6); LMG `fireIntervalMs` (120) and `fireMoveMultiplier`;
DMR `damage` (42) and `fireIntervalMs` (400); sniper `fireIntervalMs` (1400) and `adsMoveMultiplier`; all `adsTimeMs`;
`stanceSpreadMultiplier.prone` (0.6); armor durabilities (keep the invariant and the sniper constraint).

## Edge cases
- Reload with a full mag or 0 reserve: no-op. Reload partially fills when reserve < missing rounds.
- Picking up a weapon while reloading or healing: allowed, and it cancels both if the active slot changes.
- A dropped weapon keeps its `mag`, and a picked-up weapon keeps it too. Two of the same weapon is allowed.
- Picking up a gun while holding the grenade slot with both gun slots full replaces slot 0 (same as holding fists) and equips it.
- Damage to a dead or dropping player is ignored. Dropping players cannot be hit.
- Shots fired on the same tick as the shooter's own death still resolve (inputs are processed in order).
- Fists hit only players. Fists have no ADS; RMB with fists does nothing (no error prompt).
- ADS with an empty mag is allowed. An empty-fire auto-reload ends ADS.
- ADS held while swapping to a scoped gun: ADS starts from 0 when the swap ends.
- Sniper hip fire is allowed (6 deg cone). It is a gamble, not a bug.
- Shots against a prone player whose box pokes into a wall or rock: the ray hits the collider first, so the hidden part is safe.
- Overkill: damage events report the full amount; HP is clamped at 0 for display only.

## UI must show
Ammo `mag / reserve` (sniper ammo has its own reserve), slot icons 1-4 (slot 4 shows the grenade count), a screen-centre crosshair sized to the current
cone (hip) that fades out during ADS (the iron post or red dot is then the reticle; `camera.md`), a full-screen scope overlay for scope_4x/8x (4x and 8x reticles differ),
hit markers (body/head/kill, plus an "armor hit" and "helmet hit" variant, `armor.md`), damage-direction arc, HP bar, vest and helmet
icons with tier and durability (`armor.md`), stance icon (`stance.md`), heal channel bar, reload progress, pickup prompt, and the
prompts "Armor full", "Better armor equipped", "Inventory full", "Can't heal", "No grenades", "No room to stand", "Too deep".
Settings: ADS Hold/Toggle (default Hold) and ADS sensitivity (default 1.0); FOV, head bob and reduce motion are in `camera.md`.

## Audio and VFX
Per weapon: shot sound (positional for others), dry-fire click, reload start and end, swap. New: LMG (heavy rolling chatter), DMR (sharp
crack), sniper (very loud crack plus a bolt cycle sound that plays `fireIntervalMs` after the shot so enemies can count the gap).
ADS in/out cloth rustle (local only), scope-in lens sound for scopes. Hits: body thud, head ping, vest-hit clink, helmet-hit "tonk",
armor-break shatter (separate vest and helmet variants). Heal: channel loop plus finish chime.
VFX: muzzle flash, tracer, sand puff on terrain hits, cartoon hit spark. **Scope glint (M2a, counterplay)**: a remote player who is
ADS with a scope_4x or scope_8x weapon shows a bright glint sprite at the scope, visible at any range. Needs `anim.ads` and the weapon
in `PlayerState`.

## Bots (M2a additions; numbers in `bots.weaponPrefs`, `bots.ads`, `bots.ai`)
- Weapon choice at distance d: hold a usable gun whose `[minRange, maxRange]` contains d; ties go to the higher `lootValue`; if no
  gun's band contains d, use the best `expectedBodyDps(d)` (M1 rule). `expectedBodyDps` should use the ADS cone when the bot will ADS
  at that distance.
- Loot upgrade: replace the carried gun with the lower `lootValue` when the new gun's `lootValue` > old x `bots.ai.gunUpgradeFactor`.
- ADS: per `bots.ads._note`. While ADS, aim error x `bots.ads.aimErrorMultiplier`. A bot carrying a usable scoped gun uses
  `bots.ads.scopedVisionRange` (70 m) instead of `visionRange` for sight and for the engage-range cap.
- Bots aim at the chest of the target's current stance: feet + `stances.<stance>.height x bots.ai.aimHeightFraction`.
- **Build-round measurement (M2a, `matchReport.ts`)**: median match 365 s (idle human) / 357 s (looter); kill share SMG 27-33%, rifle 25%,
  DMR 14-19%, shotgun 10%, sniper 7-8%, LMG 6%. All inside the targets, and the rifle no longer dominates. Keep `bots.ads.scopedVisionRange`
  at 70: lowering it to 55 pushed the SMG to 34.6%. `bots.grenade.throwChancePerDecision` raised 0.08 -> 0.2 after measuring only
  1.3-1.8 bot throws per match. Next lever if the LMG stays under 8%: `weapons.lmg.fireMoveMultiplier` 0.55 -> 0.65.

## Acceptance tests (QA, mostly Vitest on src/shared/sim)
1. Rifle body hit at 10 m on 100 HP / no armor deals 19. At 60 m it deals 15.675. At 90 m and at 120 m it deals 12.35. At 151 m it misses.
2. Standing rifle target (feet y = 0): a hit at y = 1.0 is a headshot and deals 34.2; at y = 0.7 it is a body hit and deals 19.
3. Three rifle headshots (no armor, <= 30 m) kill a 100 HP target; two leave it at 31.6.
4. Shotgun point-blank, all pellets on the body, 0 spread (forced): a 100 HP target ends at 1 HP. A second shot kills.
5. Shotgun with 5 head pellets and 4 body pellets on a target with helmet_2 and vest_2: helmet absorbs min(45, 82.5 x 0.4) = 33,
   vest absorbs min(55, 44 x 0.4) = 17.6, HP loss = 126.5 - 50.6 = 75.9; exactly one damage event with headshot = true.
6. Semi-auto pistol: holding LMB fires exactly one shot. Sniper: holding LMB fires one shot; a second click 1000 ms later does nothing;
   a click at >= 1400 ms fires.
7. Reload with mag 3/12 and reserve 5 ends at 8/12 and reserve 0.
8. Swapping during a reload: after the swap the mag is unchanged and no ammo is consumed.
9. Bandage at 70 HP ends at 75 HP. Bandage at 75 HP is refused. Medkit at 30 HP ends at 100 HP.
10. Firing during a heal cancels it and the item count is unchanged. Q during a reload starts the heal and keeps mag/reserve.
11. A full inventory (both slots) picking up a weapon while holding slot 2 drops the slot-2 weapon at your feet with its mag intact.
12. Picking up 30 light ammo with 170 carried takes 10 and leaves 20 on the ground. Picking up 5 sniper ammo with 18 carried takes 2.
13. **ADS spread**: standing still with the rifle, hold `ads` for 7 inputs (233 ms >= 230): `effectiveSpreadDeg` = 0.8. After 3 inputs
    (100 ms): 1.6 x (1 - 0.5 x 100/230) = 1.2522 (+-0.001). Releasing `ads` returns it to 1.6 on the next tick.
14. **ADS blocks**: with `ads` held, a reload start sets adsProgress to 0 and spread to hip; when the reload ends with `ads` still held,
    ADS ramps again from 0. Same for swap and heal. `ads` with fists or the grenade slot: adsProgress stays 0, speed unchanged.
15. **ADS vs sprint**: holding `sprint` + forward + `ads`: speed settles at walkSpeed x adsMoveMultiplier (rifle 3.25 m/s), never
    sprintSpeed. Releasing `ads` (still holding sprint) resumes sprint.
16. **Spread combination**: sniper, prone settled, ADS full, still, grounded: 6 x 0.02 x 0.6 = 0.072. Same while crawling
    (5 x 0.25 x 0.4 = 0.5 m/s < 1.0): still 0.072. LMG crouched, ADS full, walking: 2.6 x 0.45 x 0.8 x 3.0 = 2.808.
17. **LMG fire slow**: LMG holding fire and forward (no ADS), speed settles at 2.75 m/s; 300 ms after the last shot it returns to 5.0.
18. **Sniper rules** (no falloff, test at 10 m and 250 m): body vs 100 HP no armor -> 20 HP; body vs vest_2 (55) -> 52 HP, vest 23;
    head vs helmet_1 (30) -> dead; head vs helmet_2 (45) -> dead; head vs helmet_3 (75) -> 15 HP and the helmet is destroyed
    (helmetTier 0); head vs helmet_3 at 60 durability -> dead; head vs helmet_3 at 61 durability -> 1 HP.
19. **Shots-to-kill table** (forced 0 spread, at 5 m): for every row and column of the table above, the target dies on exactly the
    listed shot and not one shot earlier (parametrised test).
20. **DMR**: semi-auto, at 40 m a body hit deals 42 and a head hit 73.5; at 180 m+ a body hit deals 33.6.
21. Stance hitbox and transition firing rules: see `stance.md` tests. Armor rules: `armor.md`. Grenades: `grenades.md`.
22. Pacing and weapon mix (headless, `matchReport.ts --matches 30 --variant both`): median match 330-480 s; no weapon above 35% of
    weapon kills; the rifle between 15% and 30%. Tuning target, not a unit test.

## Affected agents when this spec changes
game-developer (sim combat, ADS, bots), tech-lead (types, validation), network-engineer (`ads` input, snapshot fields),
ui-ux-designer (crosshair, scope overlay, slot 4, settings), graphics-designer and graphics-engineer (new gun models, scope glint,
scope overlay art), audio-designer (new gun sounds, ADS sounds, armor hit variants), narrative-designer (weapon names, prompts),
qa-tester (tests above).
