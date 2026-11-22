# System: Maps, Map Vote and the Office Map Rules (M2b, design)

Status: Phase A design. Numbers below are **proposals**. They go into `balance.json` only after the tech-lead defines the MapData union
and override validation (Phase B). Layout, coordinates, climb routes and POIs: `docs/design/levels/office.md` (level-designer).
Server-authoritative: map choice, zone, physics, damage. Scope tags: **M2b**, **Later**, **Maybe**.

## Purpose
Two maps, one rule set. The island is open sightlines and a tide. The office is the same battle royale at toy scale (x9): walls, glass
rooms, desk plateaus 6.7 m up and a crawlspace under every desk. Players choose by vote, so a group can stick to a favourite or mix it up.
Every per-map difference must create a decision (high ground vs cover, room vs open plan) or it is cut.

## 1. Map selection
Map ids: `island01`, `office` (narrative-designer contract; "island" in prose means `island01`). Vote options: `island01`, `office`, `random`.

### Rules
1. **Who votes**: every connected human queued for the next match (lobby, countdown, or waiting during a running match or the results
   screen). One vote each; bots never vote. A vote **persists** across matches until the player changes it or disconnects; a disconnect
   removes the vote at once.
2. **URL pre-select**: `?map=island01|office|random` sets your vote when you join. Any other value is ignored (no vote).
3. **Vote lock**: voting closes `match.mapVoteLockSeconds` (proposed 3) before the countdown ends. The map is resolved at the lock and
   put in the match state at once, so clients build it during the last 3 s. (Refinement of "at countdown end": a 3 s lock gives
   clients time to load before the drop.) Votes changed after the lock count for the next match.
4. **Resolution at the lock**, in priority order:
   1. **Server pin**: if the env `MAP` is a valid map id, that map wins and votes are ignored. The lobby shows the vote panel disabled
      with "Map locked: <name>". An invalid `MAP` value logs one warning at startup and is ignored.
   2. **Votes**: tally island01, office and random. The option with the most votes wins. A tie between the top options is broken
      uniformly at random among the tied options.
   3. If the winning option is `random`, pick uniformly among all map ids (the previous map can repeat).
   4. **No votes at all** (no connected human has a vote): **rotate**: the map after the previous match's map in the order
      [island01, office]. The first match after server start is `island01`.
   - All randomness uses the server's seeded match RNG (logged with the match seed), never `Math.random`.
5. **Late joiners**:
   - Join during the countdown before the lock: can vote; the vote counts.
   - Join after the lock but before the drop: added to the match on the locked map (they see the map name, the vote panel is closed).
   - Join during a running match: they wait in the lobby (M1 rule). The welcome message carries the **current** match's map id (so they
     can spectate on the right map) and the vote panel for the next match is open.
   - Join during results: same as lobby; vote for the next match.
6. **What everyone sees**: live tallies per option, your own choice highlighted, the countdown, and at the lock "Next map: Office"
   (plus "(random)" if random picked it). Text from `en.json`.

## 2. Office rules
Same weapons, armor, grenades, stances, heals, zone mechanics, bots and pacing targets as the island (median 6-7 min). Only the overrides
in section 3 differ.

### 2.1 Zone: "Sprinkler Flood" (fiction choice)
**Pick: Sprinkler Flood, theme id `sprinklers`** (per-map key `maps.office.zoneTheme`; the island's is `tide`). Narrative has full
string sets for both `lightsOut` and `sprinklers` (`hud.<theme>.*`, `announcer.<theme>.*`, `hint.<theme>`, `feed.<theme>.*`), so the theme
can be switched in data alone. Outside the safe circle the ceiling sprinklers rain; standing in it costs HP at the phase `dps`.
- It fits the game's title ("Last One Dry"): on both maps, getting soaked is what kills you.
- It is **symmetric for readability**: a rain curtain at the edge and wet, grey-blue air outside are visible from both sides. "Lights Out"
  would make the outside dark, so players outside could hide in the dark, which breaks the "readable fights" pillar and needs costly
  dynamic lighting.
- It reuses the tide's look and sound family (water wall becomes a rain curtain, splash ticks), so audio and VFX work is small.
- **Cosmetic water only**: there is no water depth indoors. Sprinkler rain never slows you, never forces a stance change and never
  affects grenades. Puddles are decals.
- The rain curtain is drawn only inside the floor rectangle and is clipped by walls (it rains inside rooms too).

### 2.2 Zone geometry for a 234 x 144 m floor
- Centre of the first circle = the floor centre (0, 0). `startRadius` 140 covers the whole floor (half-diagonal sqrt(117^2 + 72^2) = 137.4 m),
  so nobody takes damage at match start.
- Schedule (waits, shrinks, dps, final collapse) is **identical to the island**, so the pacing model and bot eagerness ramp still line up.
  Phases end at 2:00 / 3:45 / 5:20 / 6:30 / 7:20 / 8:00; the collapse closes at 8:40. (M2c v8: 2:00 / 3:55 / 5:40 / 6:55 / 7:45 / 8:25,
  collapse closed at 9:05. Balance v9, current, both maps: 1:45 / 3:20 / 4:45 / 6:00 / 6:50 / 7:30, collapse closed at 8:10; `zone.md`.)
- Radii are slightly larger than the island's in the middle phases, because walls and desks lengthen rotations and shorten sightlines:

| Phase | Radius after | radiusFraction (of 140) | Island radius | Note |
|---|---|---|---|---|
| 1 | 95 m | 0.6786 | 87.5 | Cuts the far ends of the floor (side wall rooms); keeps the full 144 m depth |
| 2 | 70 m | 0.5 | 65 | About 2 desk blocks plus a room row |
| 3 | 50 m | 0.3571 | 47.5 | |
| 4 | 30 m | 0.2143 | 27.5 | About one desk block |
| 5 | 15 m | 0.1071 | 13.75 | |
| 6 | 5 m | 0.0357 | 5 | |

- **Centre selection (indoor replacement for the island land check)**: sample as on the island (uniform within `R_prev - r_i` of the
  previous centre), and accept only points inside the floor rectangle inset by `zone.indoorCenterInset` (proposed 15 m). Up to
  `landCheckMaxTries`; fallback = 50% of the way from the previous centre to (0, 0). Last phase: try `MapData.zoneCenters` first (island rule).
- Worst-case phase 1 rotation: a far corner is 137 m from the centre; the new centre can be up to 45 m away, so the walk to the new edge
  is at most about 87 m, about 25 s with wall detours (x1.4), inside the 60 s phase 1 wait (75 s before balance v9).

### 2.3 Drop
- **Superseded by the carrier drop (`drop.md`)**: everyone starts aboard a toy delivery drone flying a random straight route under the
  ceiling at **y = 25** (`maps.office.drop.carrierAltitude`; replaces the earlier `match.dropHeight` 25 proposal), 15 m/s (12 until the Phase C tuning, drop.md "Pacing check"), jumps with
  Space/F, then freefalls at 15 m/s with a short parachute from 10 m (8 m/s). Jump to landing is about 2.25 s with about 21 m of reach.
- Walls are taller than the drone, so **you pick your room when you jump**; you cannot steer over a wall. `playerSpawns` are no longer used
  for the start.
- Landing on any walkable top (floor, desk plateau, cabinet) ends the drop with no fall damage (M1 rule). Both fall speeds are also below
  the office `fallDamageMinSpeed` 18, so a 25 m drop can never hurt.
- There is no ceiling collider players can reach; nothing renders above the ceiling.

### 2.4 Verticality
- **Fall damage check (current numbers)**: landing speed from height h is `sqrt(2 x gravity x h)` = `sqrt(40 h)`.
  Damage = `(speed - fallDamageMinSpeed) x fallDamagePerMs` (6 HP per m/s over the threshold).
  - Desk top walk-off (6.7 m): speed 16.37 m/s. With the island threshold 13 that is **20.2 HP**, which would punish the core
    movement of the map. So the office overrides **`movement.fallDamageMinSpeed` = 18** (safe height 18^2 / 40 = 8.1 m).
  - Desk walk-off: 0 HP. Jump off a desk (6.7 + 1.06 apex = 7.76 m, 17.6 m/s): 0 HP.
  - 9 m fall: 18.97 m/s, 5.8 HP. A 2 m-real cabinet top (18 m): 26.8 m/s, 53 HP. Anything walkable above 8.1 m is an intentional risk.
  - Ceiling drop: the drop phase never deals fall damage, so it is always safe.
  - The island keeps 13 (unchanged).
- **Desk tops are plateaus** at about 6.7 m (6.66 in `office.md`). Facing desks in a block form one continuous plateau.
  **Monitors are canopies, not cover** (director ruling): the screen sits 1.4-4.37 m above the desk top on a thin stand, so a standing chibi
  (1.3 m) walks under it and is visible from the side; only the stand blocks. Monitors give shade, not protection. **Plateau cover comes
  from plush toys, boxes and laptops** (level-designer places them; crouch or prone behind the low ones).
- **Ping pong net (office.md T12): intended as a wall.** It divides the table into two halves with their own routes (DEN-W, DEN-E). At
  1.35 m it is above the 0.95 m jump cap but below the physical hop limit (jump apex 1.06 m + step-up 0.35 m = about 1.41 m), which would
  be a near-miss hop. Decision: keep the net **model** at 1.35 m and make its **collider** 1.6 m tall (invisible top extension), so it can
  never be hopped. Request to level-designer / graphics-engineer. QA: 50 sprint-jumps at the net from either half never cross it.
- **Climb routes** (level-designer places them in MapData as explicit routes): every step rise is **<= `movement.stepHeight` (0.35 m)**
  (walk up) or **<= 0.95 m** (jump up). **Decision (build round): the graphics-designer's 0.945 m jump steps (bookStack, boxSmall,
  bookStairs; 0.105 m real x 9) are accepted; 0.95 m is the hard cap.** Arithmetic: jump apex = 6.5^2 / 40 = 1.056 m, so the margin is
  0.11 m. Feet are above 0.945 m from t = 0.22 s to 0.43 s of the jump (solve 6.5 t - 10 t^2 = 0.945), a 0.21 s window covering 6 sim
  ticks, and a walking player covers about 1 m in it, so a forward jump at the step face lands. (At 0.9 m the window would be 0.25 s.)
  Fallback: if acceptance test 17b fails for humans or bots, the steps drop to 0.9 m (graphics change). Ramps (tilted keyboard, fallen
  whiteboard) are built as stairs of thin flat prisms with rises <= 0.35 m, because colliders are vertical prisms with flat tops.
  - Every desk block has **at least 2 climb routes, at opposite ends**, so a plateau is never a one-door trap.
  - **Cable ladders: Later** (no climb movement mode in M2b).
- **Gaps between plateaus** are either <= 3 m (an intentional sprint-jump: 0.65 s air time x 7.2 m/s = 4.7 m max) or >= 6 m (never
  jumpable). Nothing in between (no near-misses).
- **High ground trade-off**: from the plateau you see the aisles, and a floor player cannot see a prone player on the desk top. A floor
  player under a desk is covered from above. Counterplay to plateau campers: grenades (max apex from the floor about 8.6 m, so lobs land
  on desks), the second climb route, and other plateaus at the same height.
- **Under-desk crawlspace**: clearance about 6 m, so you can stand. Stance matters because of **low cover** under desks (drawer pedestals,
  bins, cable trays, footrests, boxes at 0.6-1.2 m world height): crouched (0.95 m) or prone (0.6 m since BUG-008) you are hidden behind them, standing
  (1.3 m) you are not. Level-designer request: low cover in every desk block.
- Stance water rules never trigger indoors (depth is always 0).

### 2.5 Walls and glass
- **Glass walls are solid in the sim, transparent only in rendering**: they block movement, bullets, grenades, grenade blast line of sight,
  and bot sight. This is the simplest rule and it stops bots firing at targets they cannot hit. Humans can see through glass, which is a
  small and readable information edge.
- A bullet hitting glass stops there: impact surface `glass` (crack spark and decal, cosmetic, no state). **Shattering glass: Later.**
- Room walls (~27 m) are taller than any grenade arc (max apex from a desk top about 15.3 m), so grenades never cross a wall; they pass
  through doorways only.
- **Grenades bounce off walls and glass** with the normal grenade rules (`grenades.md`: box face normal, `restitution`, `friction`). No
  special case. A grenade can be banked through a doorway.
- If the indoor map defines a ceiling height, grenades and shots also stop at it (bounce normal -Y for grenades). With current numbers
  no grenade can reach it.

### 2.6 Loot tweaks (office)
Same item set. Rooms and desk mazes favour close fights and grenades; the long main aisle would otherwise make the sniper too strong.
Overrides (only these weights change): common grenade 5 -> 7, rare grenade 6 -> 8, epic sniper 9 -> 6, epic shotgun 9 -> 12.
Fire extinguisher spots and room interiors are good loot spawns (level-designer).
**M2c** (`loot.md` "M2c", live): the base tables changed, so the office overrides become common pistol 4, revolver 3, smg 3, shotgun 2,
knife 9, grenade 6; rare grenade 7; epic sniper 5, shotgun 10, scope_8x 2; guaranteed weapons pistol 45 / revolver 20 / smg 15 / shotgun 20.
M2c tuning round 2 (office-only bot overrides against landing brawls; reasons in `combat.md`): `bots.drop.maxBotsPerTarget` 1,
`bots.dropSpreadRange` 20, `bots.lootPhaseEngageRange` 3. Office layout: 50 / 20 / 8 activated loot points per match from candidate
pools (`layout.md`). Glass panes break to melee and rockets (`melee.md`).

## 3. Per-map overrides in balance.json (proposal for Phase B)
- New top-level block `maps.<mapId>`. Each contains **only keys that differ** from the base sections.
- **Effective balance** for a match = `deepMerge(base, maps[mapId])`: objects merge key by key, scalars and **arrays replace wholesale**
  (so `zone.phases` must be a full array). Computed once at match start on the server, and on the client when it receives the map id.
  The movement step (prediction) must use the merged values.
- Validation: every override path must already exist in the base (a typo fails at startup); the merged result must pass the normal
  `validateBalance`. Underscore keys are ignored.
- **Exception, `zoneTheme`**: a required per-map key (not an override path), one of `tide | sprinklers | lightsOut`. It selects the zone
  strings (`hud.<theme>.*` etc.), visuals and audio. It never changes sim rules. Every map in `maps` must have one: `island01` = `tide`,
  `office` = `sprinklers`.
- The base `drop` block (`drop.md`) is already in balance.json (the current validator ignores unknown sections), so `maps.office.drop`
  overrides existing paths.
- New base keys this needs (proposed): `match.mapVoteLockSeconds` 3, `zone.indoorCenterInset` 15 (ignored by island maps), `bots.nav.*`
  (section 4).

```json
"maps": {
  "_note": "Per-map overrides, deep-merged over the base sections at match start. Arrays replace wholesale. Only keys that differ. zoneTheme is a required per-map key, not an override.",
  "island01": { "zoneTheme": "tide" },
  "office": {
    "zoneTheme": "sprinklers",
    "drop": {
      "carrierAltitude": 25,
      "carrierSpeed": 12,
      "noJumpMs": 1500,
      "routeEntryMargin": 0,
      "ejectInset": 15,
      "minJumpWindowMetres": 90,
      "freefallSpeed": 15,
      "freefallSteerSpeed": 10,
      "chuteDeployHeight": 10
    },
    "movement": { "fallDamageMinSpeed": 18 },
    "zone": {
      "startRadius": 140,
      "indoorCenterInset": 15,
      "phases": [
        { "waitSeconds": 75, "shrinkSeconds": 45, "radiusFraction": 0.6786, "dps": 1 },
        { "waitSeconds": 60, "shrinkSeconds": 45, "radiusFraction": 0.5, "dps": 2 },
        { "waitSeconds": 55, "shrinkSeconds": 40, "radiusFraction": 0.3571, "dps": 4 },
        { "waitSeconds": 40, "shrinkSeconds": 30, "radiusFraction": 0.2143, "dps": 6 },
        { "waitSeconds": 25, "shrinkSeconds": 25, "radiusFraction": 0.1071, "dps": 10 },
        { "waitSeconds": 20, "shrinkSeconds": 20, "radiusFraction": 0.0357, "dps": 15 }
      ]
    },
    "bots": {
      "visionRange": 40,
      "hearingRange": 35,
      "avoidRange": 15,
      "ads": { "scopedVisionRange": 60 }
    },
    "loot": {
      "tiers": {
        "common": { "grenade": 7 },
        "rare": { "grenade": 8 },
        "epic": { "sniper": 6, "shotgun": 12 }
      }
    }
  }
}
```
**Delivered (Phase C, balance.json):** as above with three differences: `office.drop.carrierSpeed` is 15 (landing-time tuning,
drop.md "Pacing check"); `zone.indoorCenterInset` is a base key only (15, the office would
repeat it), and `office.clientFeel.carrierCameraDistance` 10 is added (base 26; the 3P orbit around the small drone under the ceiling).
The office `zone.phases` waits above are the M2b values; since then they follow the island schedule (balance v9: 60 / 50 / 45 / 45 / 25 /
20 s). `balance.json` is authoritative.

Bot overrides: shorter vision and scoped vision so bots do not snipe down the 234 m main aisle; shorter hearing as an approximation of
walls muffling sound; shorter `avoidRange` because rooms are small and bots must still loot them.

## 4. Bots indoors
### Navigation needs (for game-developer and tech-lead)
- **Indoor maps use a nav graph; the island keeps M1 steering** (open terrain does not need it).
- Built once at map load from the colliders, **deterministic** (same map -> identical graph; no RNG) and **cached** per map id.
- Grid of `bots.nav.cellSize` (proposed 1.0 m) cells on the floor (y = 0) and on every walkable top (desk plateaus, cabinets). A cell is
  blocked when a collider footprint, inflated by `player.radius`, overlaps it and the collider spans standing height (bottom < 1.3 m above
  the cell, top > cell + `stepHeight`). Under-desk floor is walkable (the desk top's bottom is about 6 m up); desk legs and low cover block.
- **Links between layers**: climb routes come from MapData (explicit waypoint lists, one per route; the bot jumps when the next rise is
  > `stepHeight`). **Drop-down links**: any plateau edge cell next to free floor is a one-way link down.
- A*: costs in metres; climb links cost route length x `bots.nav.climbCostMultiplier` (2.0); drop links cost `bots.nav.dropCost` (4).
  Ties broken by node id. Path cache keyed by (start cell, goal cell), size `bots.nav.pathCacheSize` (256). At most
  `bots.nav.maxPathsPerTick` (2) new searches per tick across all bots; others wait a tick. Replan when the goal changes, when stuck
  (existing detour logic triggers a replan instead of a random detour), or every `bots.nav.replanMs` (1000).
- **Zone urgency uses path length**, not straight-line distance, to decide when to leave for the circle.
- Wander and hold points, loot targets and zone entry points must be reachable cells (snap to the nearest reachable cell).
- Doorways: level rule, at least 3 m wide in world space (real doors are about 8 m at x9, so this is easy).

### Should bots climb? Yes, but only for a purpose
- Bots climb to **loot** on a plateau (the path cost includes the climb penalty) and as **hold positions**: cautious bots prefer a plateau
  hold point inside the next circle with probability `bots.nav.plateauHoldChance` (proposed 0.4).
- Bots **do not chase** a target up a climb route mid-fight; they fight from where they are, use grenades on targets they lost behind cover
  (M2a rule), or reposition on their own layer.
- Bots drop down (walk off) freely when their path says so; the office override makes that safe.
- **Falls off perches while fighting (Phase C decision: acceptable for M2b).** matchReport shows about 1-2 bot fall deaths per 30 office
  matches, when an engaged bot strafes off a perch. That is under 0.07 per match, it only kills a bot that is already low on HP (a 10.46 m
  perch fall is about 15 HP at `fallDamageMinSpeed` 18), and humans face the same risk, so it reads as a mistake rather than a bug.
  No fix in M2b. Later (cheap guard, game-developer): while engaged, a bot does not strafe or step off an edge whose predicted fall damage
  is >= its current HP. Act sooner if the rate goes above 1 per 10 matches.
- Bot stance use (M2a) carries over; low under-desk cover makes crouch and prone useful for cautious bots.

Proposed base keys: `"bots": { "nav": { "cellSize": 1.0, "climbCostMultiplier": 2.0, "dropCost": 4, "pathCacheSize": 256,
"maxPathsPerTick": 2, "replanMs": 1000, "plateauHoldChance": 0.4 } }`.

## 5. What the UI, audio and VFX must show (summary; owners write the details)
- Lobby: the map vote panel (three options with tallies, your choice, "Map locked" state), the resolved map name at the lock, a loading
  state if your client is still building the map when the drop starts.
- Office HUD: the zone label uses the sprinkler fiction ("Sprinklers on in 0:23" / "Sprinklers spreading 0:12"; narrative-designer).
  Minimap draws rooms, desks and walls instead of the coastline.
- Audio: sprinkler rain loop outside the circle (replaces the tide loop), the same warning sting family, indoor reverb, glass impact sound.
- VFX: rain curtain at the circle edge clipped to walls, wet-floor tint outside, glass crack sparks. Camera: walls near the camera fade or
  cut away (graphics-engineer).

## 6. Acceptance criteria (QA)
Map selection (server unit tests on the lobby/room logic):
1. Votes office, office, island01 -> office.
2. Votes island01, office (tie): over 1000 seeds each map wins 50% +- 5%; the same seed always gives the same result.
3. Votes random, random, island01 -> random wins, then the map is uniform over both ids (1000 seeds, 50% +- 5%).
4. No votes for three matches in a row: island01, office, island01. The first match after server start is island01.
5. `MAP=office`: office regardless of votes, and the lobby state reports the vote as locked. `MAP=bogus`: one warning, votes decide.
6. Joining with `?map=office` sets the vote to office; `?map=xyz` leaves no vote.
7. A vote changed after the lock (`countdownSeconds - mapVoteLockSeconds`) does not change this match's map; the map id is in the match
   state from the lock onward.
8. A voter who disconnects before the lock is removed from the tally.
9. A player who joins mid-match gets the running match's map id in the welcome and can vote for the next match; their vote persists.

Office rules (sim tests on the merged balance and a test indoor map):
10. Office drop (`drop.md` tests 2 and 10): the drone flies at y = 25; a jumper lands about 2.25 s later with 0 fall damage, also on a desk top.
11. Walking off a 6.7 m plateau: 0 damage. Jumping off it: 0 damage. Falling 9 m: 5.8 HP (+- 0.3). On the island, falling 6.7 m still deals
    20.2 HP (+- 0.5).
12. At t = 0 every floor corner is inside the circle (radius 140 >= 137.4). Phase end radii are 95 / 70 / 50 / 30 / 15 / 5 (+- 0.1) and the
    phase end times match the island (balance v9: 105 / 200 / 285 / 360 / 410 / 450 s, closed at 490 s; v8 was 120 / 235 / 340 / 415 /
    465 / 505, 545; before that 120 / 225 / 320 / 390 / 440 / 480, 520).
13. Over 1000 seeds every office zone centre lies inside the floor rectangle inset 15 m, and every circle lies inside the previous one.
14. Outside the circle on the office: HP loss per phase dps, no speed change, and prone is allowed (no water depth).
15. Glass: a shot at a player behind glass stops at the glass (impact surface `glass`, no damage); players cannot walk through it; a grenade
    bounces off it; a grenade blast behind glass deals no damage; a bot cannot see a player behind glass.
16. A grenade thrown straight at a wall bounces back with the normal velocity reversed and scaled by `restitution` (+- 5%).
17. Level data test: every desk block has >= 2 climb routes; every route step rise is <= 0.35 m or <= 0.95 m; every plateau gap is <= 3 m or >= 6 m.
17b. Jump-step test (sim, 30 Hz): a standing player touching the face of a 0.945 m step, holding forward and pressing jump, ends on top of
    it in 100% of 50 trials with yaw offsets of -30..+30 deg; a bot following a climb route of 0.945 m steps reaches the plateau without
    stalling (no stuck detection).
18. Overrides: the effective office balance equals base deep-merged with `maps.office`; the island balance is unchanged; an override key that
    does not exist in the base fails validation; office loot weights read common grenade 7, rare grenade 8, epic sniper 6, epic shotgun 12.
18b. `zoneTheme`: office resolves to `sprinklers`, island01 to `tide`; a map without `zoneTheme`, or with an unknown theme, fails validation;
    every `hud.<theme>.*` key the HUD uses exists in `en.json` for both themes.

Bots (headless, `matchReport.ts` with the office map, 30 matches):
19. Nav graph build is deterministic (same hash across runs) and every player spawn, loot spawn and zone centre is reachable from every
    other, including plateau loot via climb routes.
20. Bots are stuck (no progress toward their goal for > 3 s) less than 2% of bot-alive time; bots climb to plateau loot in at least half of
    the matches; bot zone deaths per match are no higher than on the island + 0.5.
21. Pacing: median match 300-480 s on the office too (target 320-400 s, balance v9); no weapon above 35% of weapon kills.

## Expected to need playtest tuning
Office phase radii (95/70/50), `fallDamageMinSpeed` 18, bot `visionRange` 40 / `scopedVisionRange` 60, the office loot tweaks,
`climbCostMultiplier`, `plateauHoldChance`, `mapVoteLockSeconds`.

**Office SMG share (Phase C decision: wait for the director's playtest).** matchReport shows the SMG at 33.7% of weapon kills on the
looter variant, under the 35% cap (AT21). Close-range guns are meant to be strong indoors, and bot-only numbers overstate hip-fire guns.
No change now. Trigger: SMG >= 35% in any matchReport variant, or playtest feedback that the office is "SMG only". First lever:
`maps.office.loot.tiers.common.smg` 12 -> 9 (an office-only override, so the island is unaffected); second: `rare.smg` 14 -> 11.

## Affected agents
tech-lead (MapData union, `maps` validation, deep-merge, new base keys), network-engineer (vote messages, map id in welcome and match
state, `MAP` env, lock timing), game-developer (vote resolution, indoor zone centre rule, nav graph, bot climbing), level-designer (climb
routes in MapData, low cover, plateau gaps, spawns mostly in the open plan, doorway width), ui-ux-designer (vote panel, sprinkler HUD text,
indoor minimap), narrative-designer (map names, sprinkler zone strings, vote text), audio-designer and graphics (sprinkler rain, glass
impacts, indoor reverb), qa-tester (tests above).
