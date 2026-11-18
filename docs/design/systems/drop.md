# System: Carrier Drop (plane and drone) (M2b)

Numbers: `balance.json` `drop` (base = island), `movement.dropFallSpeed` / `dropSteerSpeed` (parachute phase), `bots.drop`,
`bots.personalities.*.{jumpTimingBiasMs, dropEpicWeightMultiplier}`; per-map overrides in `maps.<id>.drop` (`maps.md`).
Server-authoritative. Replaces the M1 "spawn in the air above `playerSpawns`" start on both maps.

## Purpose
The first decision of every match: **where and when to jump**. A random straight route each match means no two openings are the same.
Jumping early or late, and opening the parachute early (glide far, land late) or late (land first, short reach), are real trade-offs:
contest the hot POI under the route, or glide to a quiet edge.

## Player-facing rules
### Route generation (server, at the map lock)
- Generated when the map is resolved (`maps.md`: the vote lock, `match.mapVoteLockSeconds` before the countdown ends; at countdown start if
  `MAP` pins the map) from the **match's seeded RNG** (the match seed is drawn at that moment). Sent in the match state so the minimap shows
  the dashed route and a carrier icon during the rest of the countdown. Players who join after the lock receive it too.
- **Play area** per map kind: island = circle of radius `MapData.islandRadius` (110 m) around (0, 0); office = the floor rectangle
  (half extents 117 x 72 m). `support(n)` = the play area's half-width along unit normal n: circle -> R; rectangle -> `hx |n.x| + hz |n.z|`.
- Draw:
  1. heading `theta` uniform in [0, 360) deg; direction d = (sin theta, 0, cos theta) in the XZ plane, normal n = (cos theta, 0, -sin theta);
  2. lateral offset `o` uniform in [-f, f] x support(n), with f = `drop.routeLateralFraction`; the route line is `P(s) = o n + s d`.
- **Entry and exit**: where the line crosses the play area **expanded** by `drop.routeEntryMargin` (island 50 m: over the sea, outside the
  135 m world edge; office 0: at the floor edge, the drone comes out of a wall vent). The carrier starts at the entry point at the first tick
  of `playing` and flies to the exit point.
- **Eject point**: where the line leaves the play area **inset** by `drop.ejectInset` (island: circle radius 100 m, over land; office:
  rectangle inset 15 m).
- **Jump window** = from `drop.noJumpMs` after the start to the eject point. Its length on the ground track,
  `window = s_eject - (s_entry + carrierSpeed x noJumpMs / 1000)`, must be >= `drop.minJumpWindowMetres` (island 150, office 90). If not,
  redraw (heading and offset) up to `drop.routeMaxTries` (20) times; if all fail, use the last heading with o = 0. This is the guarantee that
  every route crosses a good part of the map.

Island examples (speed 15 m/s, no-jump 3 s = 45 m): o = 0 -> entry at s = -160, jumps from s = -115, eject at s = +100: window 215 m
(14.3 s). Worst case o = 55 -> entry at -150.3, jumps from -105.3, eject at +83.5: window 188.8 m (12.6 s), and the route still crosses
2 x sqrt(110^2 - 55^2) = 190 m of island.

### Carrier
| | Island (base) | Office (override) |
|---|---|---|
| Carrier | seaplane | toy delivery drone, under the ceiling |
| `carrierAltitude` (absolute y) | 120 m | 25 m |
| `carrierSpeed` | 15 m/s | 15 m/s (was 12; Phase C tuning, see "Pacing check") |
| `noJumpMs` | 3000 (about the time to reach the coast) | 1500 |
| `routeEntryMargin` / `ejectInset` | 50 / 10 m | 0 / 15 m |
| `minJumpWindowMetres` | 150 | 90 |

The carrier is cosmetic and has no collider. Indoors it passes through room walls (graphics fades or hides the clipping); players cannot.
It keeps flying to the exit point after the eject, then despawns.

### Aboard
- Every participant (humans and bots, including humans who join after the lock and before the start) begins aboard. Position = the
  carrier's position, for every tick.
- Aboard players are **invulnerable and not targetable**: excluded from hitscan, grenade blasts and zone damage. They **cannot act**: fire,
  ADS, reload, heal, pickup, slot select, stance and movement inputs are ignored. Mouse look works (orbit camera around the carrier).
- **Jump**: the `jump` edge (Space, or **F**, which the client maps to the same edge) after `noJumpMs` and before the eject point. The player
  leaves the carrier on that tick at the carrier's position with zero horizontal velocity (the carrier's velocity is not inherited) and
  enters freefall.
- **Auto-eject**: on the tick the carrier reaches the eject point, everyone still aboard jumps (same rules, all at once).
- Disconnect aboard: eliminated as "left" (M1 rule); nothing drops (they carry nothing).

### Freefall and parachute (extends the `dropping` movement state)
`MovementState.dropping` stays true from the jump until landing; add `dropPhase: 'freefall' | 'chute'` and `dropMs` (ms since the jump).
Everything M1 says about dropping players still holds: they cannot fire, pick up or heal, and **cannot be hit** (no spawn-sniping).
They do take zone damage (they are always over the play area at the start, so this only matters if they steer far outside).

| Phase | Vertical speed | Horizontal steer | Ends |
|---|---|---|---|
| Freefall | `drop.freefallSpeed` (island 30, office 15) | `drop.freefallSteerSpeed` (island 14, office 10) | auto-deploy, manual deploy, or touching ground |
| Parachute | `movement.dropFallSpeed` (8) | `movement.dropSteerSpeed` (9) | touching ground |

- Speeds are constant (no acceleration, as in M1): `vel = (steerDir x steer, -fallSpeed, ...)`, steering camera-relative from WASD.
- **Auto-deploy** when height above the ground below (terrain height on the island, floor y = 0 indoors; props are ignored) <=
  `drop.chuteDeployHeight` (island 40 m, office 10 m).
- **Manual early deploy (kept, `drop.manualDeploy` true)**: the `jump` edge (Space/F) during freefall opens the parachute at once, if
  `dropMs >= drop.minFreefallMs` (500, so the jump press cannot double as a deploy). It is a real decision because the parachute glides
  further per metre of height (9 / 8 = 1.1 m per m) than freefall (14 / 30 = 0.47 m per m): deploy early to reach far, stay in freefall to
  land first.
- **Landing**: the first ground contact (terrain, floor or any walkable collider top such as a desk or crate) ends the drop: `dropping`
  false, `dropPhase` cleared, **never any fall damage** (M1 rule). On the office the freefall (15 m/s) and parachute (8 m/s) are also below
  `fallDamageMinSpeed` 18, so a 25 m drop could not hurt even without that rule.
- Freefall into a wall or prop: normal collision (slides along it). Landing in shallow water: normal.

Reach and time (flat ground, island ground height ~2 m, office floor 0):

| | Island, auto-deploy | Island, deploy at 0.5 s | Office, auto-deploy | Office, deploy at 0.5 s |
|---|---|---|---|---|
| Freefall | 78 m / 30 = 2.6 s, steer 36.4 m | 0.5 s, 7 m | 15 m / 15 = 1.0 s, 10 m | 0.5 s, 5 m |
| Parachute | 40 / 8 = 5.0 s, steer 45 m | (118 - 15) / 8 = 12.9 s, 116 m | 10 / 8 = 1.25 s, 11.25 m | 17.5 / 8 = 2.2 s, 19.7 m |
| Total | **7.6 s, 81 m reach** | **13.4 s, 123 m** | **2.25 s, 21 m** | **2.7 s, 25 m** |

Indoors there is a short "napkin parachute" (same states and controls as the island, so there is one system to learn); it barely changes
reach, but it slows the last 10 m so landings on desks (6.7 m) read clearly.

## States and transitions (per player)
`Aboard` -> jump edge (after `noJumpMs`) or auto-eject -> `Freefall` -> auto-deploy height or manual deploy (after `minFreefallMs`) ->
`Parachute` -> ground contact -> `Landed` (normal play). `Freefall` -> ground contact -> `Landed` directly (e.g. landing on a tall prop
above the deploy height). Disconnect in any of these -> eliminated.

## Pacing check (zone timing)
- M1 start: a 30 m drop at 8 m/s, about 3.75 s from match start to landing.
- New island start: the mean jump is mid-window, about 3 + 6.5 = 9.5 s, plus a 7.6 s fall, so **landing is about 17 s on average**. The
  latest auto-ejected player lands by about 25 s (31 s if they deploy at once). That is about +13 s average before looting starts.
- The zone's phase 1 timer still starts at match start (the target circle is visible during the flight). Bot loot phase and eagerness are
  measured from each bot's landing, so the bots' ramp shifts about 13 s later relative to the zone. Effect: slightly calmer early game,
  slightly longer matches.
- Expected median: measured M2a 357-365 s, plus at most about 13 s, about **370-380 s**, inside 330-480. Phase 1 still leaves at least
  50 s between the latest landing and the first shrink. **Decision: no zone change.** Lever if `matchReport` shows a median above 450 s:
  phase 1 `waitSeconds` 75 -> 65. If it shows bots fighting during the flight window: impossible by rule; if early fights cluster at the
  route's hot POI, raise `bots.drop.maxBotsPerTarget` spread first.
- Office: about +6 s (mean jump about 5 s, 2.25 s fall). No change.
- **Office tuning (Phase C, matchReport):** the median landing was 10.9-11.6 s against the AT13 target of <= 10 s. Decision: keep the
  target and raise `maps.office.drop.carrierSpeed` 12 -> 15 (the island's speed). The ride shrinks by 20% (about 1.5-2 s at the measured
  medians), the route is unchanged, and the 90 m window still lasts 6 s, enough to pick a room. Next lever if the median is still
  above 10 s: `maps.office.drop.noJumpMs` 1500 -> 1000. Only if both fail, relax the indoor target to <= 12 s.

## Bots: jump choice
At the route reveal each bot picks a **drop target** and a **jump time** (seeded RNG, decided in id order so the spread rule is deterministic):
1. Candidates: loot spawns whose horizontal distance to the in-window route segment is <= auto-deploy reach x `bots.drop.reachSafetyFraction`
   (0.8: island 65 m, office 17 m). Weight = `bots.drop.tierWeights[tier]` (common 1, rare 2, epic 3), times the personality's
   `dropEpicWeightMultiplier` for epic spawns (aggressive 1.5, balanced 1, cautious 0.5).
2. Skip a candidate once `bots.drop.maxBotsPerTarget` (2) earlier picks lie within `bots.dropSpreadRange` (15 m, existing key) of it.
   An earlier pick of the same spawn counts (distance 0). So at most 2 bots aim at any 15 m area; the third looks elsewhere. Weighted
   random pick among the rest. (Phase C clarification: the earlier wording read as two separate rules, which made the per-target cap
   unreachable.)
3. Jump time = the moment the carrier passes the route point closest to the target, plus the personality's `jumpTimingBiasMs` (aggressive
   -1000, balanced 0, cautious +1500), plus uniform jitter of +-`bots.drop.jumpJitterMs` (1500), clamped to the jump window.
4. No candidate in reach: jump at a uniform random time in the window and target the nearest loot spawn to the landing point.
5. During the fall the bot steers straight at its target. It deploys manually right after `minFreefallMs` when the horizontal distance to
   the target is greater than its auto-deploy reach x 0.8 (island 65 m), otherwise it waits for the auto-deploy.
6. Humans never influence bot picks (no peeking at human jump choices). The existing "drop" bot state now covers aboard + freefall + chute.

## Tunable values
`drop.*`, `movement.dropFallSpeed`, `movement.dropSteerSpeed`, `bots.drop.*`, personality `jumpTimingBiasMs`, `dropEpicWeightMultiplier`,
`maps.<id>.drop.*`. `match.dropHeight` and `match.spawnJitter` are **no longer used for the match start** (kept only if the tech-lead keeps
`playerSpawns` as a fallback; otherwise remove them from the required keys).
**Expected to need playtest tuning**: `carrierSpeed` (15), `noJumpMs`, `freefallSpeed` / `freefallSteerSpeed`, `chuteDeployHeight` (40),
`routeLateralFraction` (0.5), bot `tierWeights`.

## Edge cases
- Route redraw exhausts its tries: last heading with o = 0 (a centre line always passes the window check on both maps).
- A player presses jump on the exact eject tick: they jump; the eject handles nobody else differently.
- Jump pressed during `noJumpMs`: ignored (no prompt; the HUD already shows the countdown).
- Holding Space through the jump does nothing extra (edges only); a second press after 500 ms deploys.
- Freefall onto a hut roof or palm top above the deploy height: lands there (drop ends, no damage).
- Steering out past the island world edge: the world-edge wall applies to dropping players as in M1.
- The office drone's route crosses glass rooms: aboard players are unaffected; jumpers fall into whichever room is below them.
- Match end while players are aboard (all humans left and bots resolve): aboard players are ranked like other alive players.

## What the UI must show
- Countdown: minimap and full-screen map show the dashed route, the carrier icon moving along it after the start, the eject point marker,
  and the first zone target circle when known.
- Aboard: orbit camera around the carrier; "Press Space/F to jump" (dimmed with a countdown during `noJumpMs`), players still aboard,
  time until auto-eject.
- Freefall: altitude above ground, "Space/F: open parachute", and the auto-deploy height marked on the altitude bar.
- Remote players: freefall pose and open parachute visible (for reading where people land).
- Strings in `en.json` (narrative-designer).

## Audio and VFX
Engine drone loop for the carrier (seaplane prop vs drone buzz), cabin muffled ambience aboard, door/hatch whoosh on jump, wind loop during
freefall scaled by speed, parachute pop and canopy flutter, soft landing thud. VFX: speed lines in freefall, parachute model (original;
a napkin or cocktail-umbrella style parachute indoors fits the toy scale), the carrier models (seaplane, toy delivery drone).

## Network (for tech-lead and network-engineer)
- Match state: `route { mapId, entry: Vec2, exit: Vec2, eject: Vec2, altitude, speed, startsAt (server ms), noJumpUntil }` from the lock.
  Clients compute the carrier position from it (no per-tick carrier sync needed).
- `PlayerState`: `aboard: boolean`, `dropPhase` for the pose. `MovementState`: `dropPhase`, `dropMs` (predicted after the jump; aboard
  position is derived from the route, not predicted by the movement step).
- Events: `jumped { playerId, pos, auto: boolean }`, `chuteOpened { playerId, manual: boolean }`, `landed` (existing landing data).
- Input: no new field; F maps to the `jump` edge on the client.

## Acceptance criteria (QA)
1. Same seed -> identical route (heading, offset, entry, exit, eject) across runs; different seeds give headings spread over 0-360
   (10,000 seeds: each 30-degree bucket holds 8.3% +- 1%).
2. Over 10,000 seeds per map, every route's jump window is >= `minJumpWindowMetres` (island 150, office 90); island entry and exit are
   >= 135 m from the centre (outside the world edge); office entry and exit lie on the floor rectangle edge; the island eject point is within
   100 m of the centre, the office eject point inside the 15 m-inset rectangle.
3. The route is in the match state from the vote lock (or from the countdown start when `MAP` is set) and a player joining after the lock
   receives it.
4. At the first tick of `playing`, every participant is aboard at the carrier position; a bullet ray through an aboard player's position hits
   nothing; a grenade blast and zone damage do not change aboard HP.
5. Fire, reload, heal, pickup, slot and stance inputs do nothing aboard; position follows the carrier exactly.
6. A jump edge at 2900 ms (island) is ignored; at 3000 ms+ the player is in freefall at the carrier position with zero horizontal velocity.
7. Nobody jumps: everyone is ejected on the tick the carrier reaches the eject point.
8. Freefall on the island from 120 m over ground at 2 m: vertical speed 30; auto-deploy at height <= 40 (y <= 42); parachute speed 8; landing
   about 7.6 s after the jump (+- 1 tick); HP unchanged at landing.
9. Manual deploy: a jump edge at `dropMs` 400 does nothing; at 600 it opens the parachute. Max horizontal travel with full-forward steering:
   island auto about 81 m, early deploy about 123 m (+- 3 m).
10. Office: drone at y = 25; freefall 15 m/s, deploy at y <= 10, landing about 2.25 s after the jump, no damage, also when landing on a 6.7 m desk.
11. Dropping players (freefall and parachute) cannot be hit and cannot fire, pick up or heal (M1 rules still pass).
12. Bots: over 30 seeded matches, no two bots share a target within 15 m beyond `maxBotsPerTarget`; > 80% of bots land within 10 m of their
    chosen target; cautious bots jump on average later than aggressive bots.
13. Pacing (`matchReport.ts --matches 30 --variant both`, island and office): median match 330-480 s; median landing time <= 20 s (island),
    <= 10 s (office); no weapon above 35% of kills.
