# System: Melee Weapons (knife, machete, paddle) (M2c)

Numbers: `balance.json` `weapons.knife|machete|paddle` (live), level multipliers `levels.melee`, bot keys
`bots.melee`. Server-authoritative. Related: `combat.md` (inventory, damage, armor), `levels.md`, `maps.md` (glass).
Scope tags: **M2c**, **Later**, **Maybe**.

## Purpose
A close-range option that every landing can find, so the first 30 seconds are never "no gun, punch for 3 s". Melee is the knife fight in
the hut, the paddle swat off a desk edge, the last-ditch swing when your mag is empty. It must be readable (a visible wind-up) and
beatable (step back out of reach, or shoot).
Decisions it creates: keep the knife (fast) or swap for the paddle (reach, knockback)? Push into melee range or keep the gun up? Reload
or pull the machete when someone is on top of you?

## Player-facing rules
### The weapons
| Weapon | Role | Damage body / head | Swing cycle | Hit frame | Reach | Sweep radius | Knockback | Loot |
|---|---|---|---|---|---|---|---|---|
| Knife | Fast, short | 34 / 51 | 350 ms | 100 ms | 2.0 m | 0.30 m | - | common |
| Machete | Balanced | 52 / 78 | 650 ms | 200 ms | 2.3 m | 0.45 m | - | rare (and a few common) |
| Paddle (beach oar) | Slow, heavy, long, pushes | 78 / 117 | 1000 ms | 350 ms | 2.8 m | 0.55 m | 7 m/s + 2.5 m/s lift | rare, epic |
| Fists (unchanged) | Desperation | 15 / 15 | 450 ms | instant | 2.0 m (ray only) | - | - | always |

**Balance v9 (paddle):** `weapons.paddle.damage` is back to 78. The damage pass 2026-11 had raised it to 94, which made an L4 body hit
(117.5) a one-shot on an unarmored player and let an L1 headshot (141) kill through a fresh helmet_1. At 78: L4 body 97.5 never one-shots,
and an L1 headshot through helmet_1 is 117 - 30 = 87 HP loss (survives on 13). The paddle numbers in this spec are current. The knife and
machete rows predate the damage pass (balance now has knife 41, machete 62); their current TTK is in `combat.md` "Time to kill at L1 and L4".

(`fireIntervalMs` = the swing cycle = the swing duration the art poses use, `range` = the reach, `hitFrameMs` = the hit frame; the
art's hit-frame fraction is `hitFrameMs / fireIntervalMs`: knife 0.29, machete 0.31, paddle 0.35. `levels.md` scales the cycle and the
hit frame by the same factor, so the fraction never changes with level.)
**No right-click action** for melee (decided: RMB does nothing, no prompt; a block or shove is Maybe).
The paddle slows you to x0.7 for `combat.fireMoveWindowMs` after each hit frame (`fireMoveMultiplier` 0.7).
The office uses the same paddle model for now (a reskin is Later).

### Slot
- Melee weapons live in **slot 2 (key 3)**, the fists slot. Carrying one replaces fists. They never take a gun slot, and guns never take
  the melee slot.
- **Pickup**: E on a melee pickup takes it into the melee slot. If you already carry one, yours drops at your feet (with its level) and the
  new one takes its place, whatever the levels (it is always your choice). If you were holding the melee slot you now hold the new weapon.
- Fists come back when you no longer carry a melee weapon (it is only lost on death; there is no drop key yet, Later).
- Picking up a gun with both gun slots full while holding the melee slot replaces slot 0 and equips it (same as holding fists today).
- No ammo, no reload (R does nothing), no ADS (RMB does nothing, no prompt). Melee drops on death with its level.

### Swing (per swing, server)
1. **Can swing**: alive, not dropping, not swapping, not in a stance transition, not in a swing already, and `now - lastSwing >=
   effective fireIntervalMs`. Holding LMB swings again as soon as allowed (automatic). Starting a swing cancels a heal (fire input rule)
   and sprint (LMB held).
2. **Wind-up**: the swing starts at the click. For `hitFrameMs` nothing happens (the telegraph: the arm and weapon draw back; remote
   players see it).
3. **Hit check, once, at the hit frame**, using the attacker's eye and aim **on that tick** (so you can track a strafing target during the
   wind-up). Eye = feet + current stance eye height. A = the aim segment from the eye, length `range`.
   1. **Centre ray**: raycast A against terrain, prop colliders, glass panes and the stance hitboxes of every other alive, non-dropping
      player. If the first hit is a **player**: that player is hit; zone by the hit point (head or body, same zone rules as guns). If it is
      a **glass pane**: the pane breaks (below), nobody is hit. If it is terrain or a prop: nothing is hit (thud).
   2. **Sweep** (only if the centre ray hit nothing within `range`): candidates = alive, non-dropping players whose stance hitbox
      intersects the capsule of radius `sweepRadius` around A, and for whom the segment from the eye to the hitbox point nearest A is not
      blocked by terrain, props or glass. Pick the candidate whose nearest point is closest to the eye (tie: lower entity id). Zone =
      **body** (only centre-ray hits can be headshots).
   3. At most **one** target per swing.
4. **Damage**: `damage x (head ? headshotMultiplier : 1)` x the level multiplier, no falloff, through the vest (body) or helmet (head) with
   the normal armor rule (`armor.md`). Damage event cause `melee`, weapon = the melee id, with level. Kill credit = the attacker.
5. **Knockback (paddle)**: on a hit, add to the target's velocity: horizontal `knockbackSpeed` along the attacker's yaw, and set the
   vertical velocity to at least `knockbackLift` unless the target is prone (prone: horizontal only). Normal movement physics then apply
   (friction, gravity, air control, fall damage, walls). Knockback does not cancel the target's reload, heal, ADS or cook.
6. **Recovery**: the rest of the cycle (`fireIntervalMs - hitFrameMs`) before the next swing.
7. **Cancel**: a swap, death, match end or the attacker becoming a dropping player before the hit frame cancels the swing (no hit check).
   A stance-change request during a swing is queued until the hit frame passes.

### Glass (office)
- A melee centre-ray hit on a glass pane **breaks the whole pane**: its collider is removed for the rest of the match (players, bullets,
  grenades, blast line of sight and bot sight pass through the opening). Rockets also break the pane they hit (`rpg.md`).
- Bullets and grenades still never break glass (M2b rule kept): "glass stops bullets, but a blade or a rocket opens it".
- Sim state: per pane `intact | broken`. Event `glassBroken {paneId, pos, byId}`. Late joiners and spectators receive the broken list.
- Bot nav (built at vote lock) keeps treating a broken pane as a wall for the rest of the match (Later: open it). Bot sight uses the
  current state.
- Level-designer request: each glass wall section is its own pane with an id, and no pane wider than about 8 m, so breaking one opens a
  door-sized gap, not a whole room wall.

### Time to kill (from the first hit; add `hitFrameMs` for click-to-first-hit)
Thresholds: no armor 100, vest_2 155 (body), helmet_2 145 (head). Hits = ceil(threshold / damage); time = (hits - 1) x cycle.

| Weapon | Level | Body / head dmg | Cycle | No armor (body) | vest_2 (body) | helmet_2 (head) |
|---|---|---|---|---|---|---|
| Knife | L1 | 34 / 51 | 350 | 3 hits, 0.70 s | 155/34 = 4.6 -> 5, 1.40 s | 145/51 = 2.8 -> 3, 0.70 s |
| Knife | L4 | 42.5 / 63.75 | 280 | 3, 0.56 s (x1.25) | 3.6 -> 4, 0.84 s (x1.67) | 2.3 -> 3, 0.56 s (x1.25) |
| Machete | L1 | 52 / 78 | 650 | 2, 0.65 s | 2.98 -> 3, 1.30 s | 1.9 -> 2, 0.65 s |
| Machete | L4 | 65 / 97.5 | 520 | 2, 0.52 s (x1.25) | 2.4 -> 3, 1.04 s (x1.25) | 1.5 -> 2, 0.52 s (x1.25) |
| Paddle | L1 | 78 / 117 | 1000 | 2, 1.00 s | 1.99 -> 2, 1.00 s | 1.2 -> 2, 1.00 s |
| Paddle | L4 | 97.5 / 146.25 | 800 | 2, 0.80 s (x1.25) | 1.6 -> 2, 0.80 s (x1.25) | 0.99 -> **1**, 0 s |
| Fists | - | 15 | 450 | 7, 2.70 s | 11, 4.50 s | 10, 4.05 s |

Click-to-kill, unarmored body, L1: knife 0.80 s, machete 0.85 s, paddle 1.35 s (the paddle's 350 ms wind-up is its telegraph). A paddle
headshot one-shots an unarmored player (117) at L1 but not one in helmet_1 (87 HP loss), and an L4 paddle headshot kills through a fresh
helmet_2 (146.25 - 45 = 101.25). No paddle body hit one-shots at any level (L4 97.5).
Reading the table: the machete is the best melee against unarmored players, the paddle against armor (2 hits through vest_2 vs 3), and
the knife lands first. Against guns at 2 m: the SMG still wins (0.56 s), the pump is slower than the machete (0.9 s), and any gun wins
beyond 3 m. Melee is a close-quarters option, not a replacement for a gun.
Paddle knockback: about 7 m/s pushes the target roughly 1.5-2.5 m (friction-dependent) and pops them up for about 0.25 s, so they are
airborne (x2 spread on their return fire) and usually out of reach; the paddle user must step in for the second hit within the 650 ms
recovery. On the office it can push a player off a desk edge (safe height 8.1 m, `maps.md`), and on the island into the tide.

## States and transitions (melee slot)
`Ready` -> LMB -> `WindUp (hitFrameMs)` -> hit check -> `Recovery (fireIntervalMs - hitFrameMs)` -> `Ready`.
`WindUp` -> swap / death / drop / match end -> cancelled (no hit). Slot contents: `Fists` <-> `Melee(id, level)` by pickup; death -> `Fists`
+ drop.

## Tunable values
`weapons.<melee>.damage, headshotMultiplier, fireIntervalMs, range, hitFrameMs, sweepRadius, knockbackSpeed, knockbackLift,
fireMoveMultiplier`; `levels.melee.*`; `bots.melee.*`. Validation (tech-lead): `0 < hitFrameMs < fireIntervalMs`, `range > 0`,
`sweepRadius >= 0`, `ammo` null, `magSize` 0, `sight` none (allowed for fists and MeleeIds only).
**Expected to need playtest tuning**: knife damage (34) and cycle; paddle `knockbackSpeed` (7) and `hitFrameMs` (350); `sweepRadius`
(forgiveness vs "I got hit from the side").

## Edge cases
- Target dies to someone else during your wind-up: the hit check finds whoever is there (or nothing).
- Two attackers swing at each other on the same tick: both hit checks resolve in input order; both can land (the second attacker is alive
  until damage applies, M1 same-tick rule).
- Target prone at your feet: the centre ray pitched down hits the prone box; the sweep catches it if within the capsule.
- Melee from prone: allowed, from the prone eye (0.35 m).
- Melee through a doorway edge: the sweep's line-of-sight check stops hits through the wall corner.
- Hitting a player standing behind glass: the centre ray breaks the glass; that swing deals no damage. The next one can.
- Melee vs dropping players: never hits. Melee does not damage loot, grenades, rockets or smoke canisters.
- Knockback into a wall: velocity is clipped by collision as normal; no wall-impact damage.
- Knockback while the target is in a stance transition: allowed; lift is skipped only when settled prone.
- Picking up a melee weapon during your own swing **cancels** the swing (it is a slot change); the new weapon is ready after
  `combat.swapMs` if you hold the melee slot.

## What the UI must show (ui-ux-designer)
Swing readout (agreed with G-client and the director): `HudLocalView.meleeRecovery` is 0 during the wind-up (click to hit frame), then
runs 0 -> 1 over the recovery (`fireIntervalMs - hitFrameMs`, both level-scaled), reaching 1 when the next swing is allowed.
Slot 3 shows the melee weapon icon with level band (or fists). Hip crosshair: a short arc showing the sweep (melee only). Hit markers:
same body/head/kill markers; a "glass broken" crack flash. Pickup prompt "[E] Machete Lv2" / "[E] Swap Knife -> Paddle". Kill feed
icon per melee weapon.

## What audio and VFX feedback is needed
- Viewmodel: wind-up pose that reaches the hit frame exactly at `hitFrameMs` (scaled by level), then follow-through. Third person: the
  same wind-up readable at 15 m (big chibi arm draw-back; the paddle's is the biggest).
- Audio: whoosh on swing (pitch per weapon, louder for the paddle), flesh/"bonk" hit (paddle: a cartoon wooden bonk), armor-hit variants,
  thud on props, glass shatter (positional, ~60 m). Remote swings are positional (~15 m) so a player hears someone closing in.
- VFX: hit spark, small cartoon swoosh trail along the swing, knockback dust puff and a short squash-stretch on the knocked-back chibi,
  glass shards and a broken-pane frame.

## Network (for tech-lead and network-engineer)
`MeleeId` subset of `WeaponId`. Swing start must reach other clients for the wind-up animation (an `anim.swing` start time in
`PlayerState`, or a `meleeSwing {id, weapon, t}` event). Damage event cause `melee`. `glassBroken` event plus broken pane ids for late
joiners (snapshot or welcome). Knockback is server velocity; the victim's client prediction must accept the correction (big impulse:
snap under `clientFeel.correctionSnapDistance` rules is fine).

## Bots (numbers in `bots.melee`)
- Melee value = `bots.melee.lootValue[id] x levels.botValueMultiplier[level - 1]` (fists 0.5). Pick up a melee weapon (score
  `lootScoreMelee`) when its value > current x `bots.ai.gunUpgradeFactor`.
- Fight with melee when the bot has no loaded gun (replaces the M1 fists fallback), or when the target is within `closeSwitchRange` (2.5 m)
  and the held gun's mag is empty (instead of reloading in their face).
- Swing when the target's chest is within `range x swingRangeFraction`; aim at the chest (no deliberate headshots).
- Chase with melee only within `chaseRange` (12 m), and only an enemy who also has no loaded gun, or when no wanted gun is in reach (the
  M1 fists rule).
- Bots never break glass on purpose.

## Acceptance tests (QA, Vitest on src/shared/sim)
1. Knife, target standing 1.5 m ahead, aim at the chest, no armor: a click at t = 0 deals 34 at t = 100 ms (+-1 tick), not before.
   Holding LMB: hits at 100, 450, 800 ms; the third kills (102).
2. Machete L1 vs vest_2 (55): 3 hits kill; after 2 hits hp = 100 - (104 - 41.6) = 37.6, vest 13.4.
3. Paddle centre ray on the head of an unarmored standing target: 117 damage, dead. Same with helmet_1 (30): a = min(30, 35.1) = 30, hp 13.
4. Paddle knockback: an unarmored target 2 m ahead at rest is hit; on the next tick its horizontal speed is about 7 m/s along the
   attacker's yaw and its vertical speed >= 2.5; a prone target gets no vertical speed.
5. Sweep (level aim, standing target 1.6 m ahead): target axis 0.7 m to the side of the aim line (hitbox edge 0.25 m from it, the centre
   ray misses): the knife (sweep 0.3) hits for 34 body. Axis 0.8 m off (edge 0.35 m): the knife misses, the machete (sweep 0.45) hits for
   52 body. A sweep hit is never a headshot, even when the capsule overlaps the head zone.
6. Reach: a target whose hitbox starts 2.1 m from the eye is out of knife reach (2.0) and inside machete reach (2.3).
7. Cover: a crate between the attacker's eye and the target: no hit, even if the capsule overlaps the target.
8. One target only: two targets in the capsule, the nearer one is hit.
9. Swap during the wind-up: no damage. Death during the wind-up: no damage.
10. Pickup: carrying an L2 knife, E on an L1 paddle: the slot holds the paddle; an L2 knife pickup is at the feet. Both gun slots
    unchanged. Death drops the melee weapon with its level.
11. Glass (office test map): a knife centre ray on a pane emits `glassBroken`; then a rifle shot through that opening hits a player behind
    it; a pistol shot at an intact pane still stops at the glass. A rocket hit on a pane breaks it (`rpg.md`).
12. Level: knife L4 cycle 280 ms and hit frame 80 ms; a click at 0 lands at 80 ms (+-1 tick) for 42.5.
13. Bots (seeded): an unarmed bot with a machete and an enemy within 2 m swings and lands a hit within 1 s; a bot with an empty SMG mag and
    an enemy at 2 m switches to its knife instead of reloading.
14. Kill feed for a melee kill names the weapon id and level.

## Affected agents
tech-lead (MeleeId, melee balance fields and validation, glass pane state), game-developer (swing state, hit check, knockback, glass,
bots), network-engineer (swing anim start, glass events and late-join state, knockback correction), level-designer (pane ids and widths),
ui-ux-designer (slot 3, sweep crosshair, prompts), graphics-designer and graphics-engineer (three models, viewmodel swings, glass shatter),
audio-designer (whooshes, bonk, shatter), narrative-designer (names, prompts), qa-tester.
