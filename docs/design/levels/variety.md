# Per-match layout variety (M2c item 1)

Status: **design (M2c phase A)**. Owner: level-designer. Applies to both maps: `island01` ([island.md](island.md)) and `office`
([office.md](office.md)).
Data: `src/game/levels/variety/island01.variety.json` and `src/game/levels/variety/office.variety.json`. Both are pure JSON that
nothing imports yet. Once the tech-lead types `MatchLayout` (section 8), the level generator reads them.
Decisions this follows: the M2c brief, "Fixed decisions §1". Those are not reopened here.

## 0. In one paragraph
Each match gets a `layoutSeed`. The pure function `buildMatchLayout(baseMap, layoutSeed)` runs on the server and on every client
and gives the same layout everywhere. On the island it picks one of 3 prop arrangements for each of the 7 POIs, scatters palms,
rocks, bushes, driftwood and umbrellas from scatter zones, places loot from a candidate pool about twice the size of what is
used, and picks a look preset. On the office it picks an arrangement for each of the 4 desk blocks (rows, gaps or pods), the
Fishbowl, Blue Room, pantry and lounge (including rotated and removed tables), and the 4 main-aisle cover clusters. It then
scatters wall and corner clutter, places loot from a candidate pool, and picks a lighting preset. The fixed parts never move:
terrain, walls, rooms, doors, glass, climb routes and landmarks. Loot counts per tier, the zone centres and the fallback spawns
are also fixed. Every layout passes the hard checks in section 6, which run over at least 200 seeds per map.

## 1. What varies and what is fixed

| | island01 | office |
|---|---|---|
| **Fixed** | heightmap (hills, coast noise), 24 spawn points, 8 zone-centre candidates, POI ids and centres, both docks, the boathouse and the fish shed, the dock torches, the wreck hull, the summit beacon (4 torches), the tiki-bar hut (position) | floor, walls (solid and glass), 16 doorways and the closed front door, rooms, floor zones, the 20 climb routes and all their pieces (stairs, ramps, CO-B, both perches), both bridges, the exec desk, the Yellow table, phone booths, pinboard, ping pong and foosball tables, Den / Gym / Paper Jam / Welcome Mat pieces, pantry counter and vanities, fire extinguishers, ceiling, 24 fallback spawns, 9 zone centres, POIs, `DELIBERATE_GAPS` |
| **Arrangement (pick 1 of N per zone)** | 7 POIs x 3 variants (section 4.2) | 4 desk blocks x 3, Fishbowl x 3, Blue x 3, pantry x 3, lounge x 3, 4 aisle clusters x 3 shapes plus a position jitter (section 5) |
| **Scatter (sim, has colliders)** | coastal palm clusters, beach clutter, Long Beach logs, inland jungle (section 4.1) | corridor wall bands, room corners, desk-top clutter, tunnel cover (section 5.4) |
| **Decor (client-only, no collider)** | shells, starfish, sandcastles, beach towels, fern and flower tufts, coconut piles, seaweed (new kinds) | floor and desk papers (new kind) |
| **Loot** | 77 used (51 / 19 / 7) from about 150 candidates; 12 guaranteed weapons | 78 used (50 / 20 / 8) from about 200 candidates; 16 guaranteed weapons |
| **Look** | `noon` (today), `morning`, `golden`, `overcast` | `day` (today), `evening`, `afterHours` |

Counts per tier are fixed per map. Only the positions vary, so the pacing and the loot economy stay where the M2a/M2b tuning put
them. The game-designer can change the counts (section 9).

Collider rule (brief): anything with a collider is **sim data**: island palm, rock, crate, hut, dock, umbrella pole, boat,
tikiTorch, driftwood; every office kit kind except the ceiling kinds. Bushes have no collider (`PROP_SHAPES.bush = []`), but they
stay in the sim list because they are gameplay concealment and cost nothing (section 8). Only the new decor kinds are client-only.

## 2. Seeds, streams and reproduction

### 2.1 Where the seed comes from
- `layoutSeed = mixSeed(worldSeed, LAYOUT_SALT)` with `LAYOUT_SALT = 0x4C41594F` ("LAYO"). `worldSeed` is the per-match seed the room
  already makes (`mixSeed(roomSeed, matchSerial)`). It is a uint32.
- It is decided **at the vote lock**, together with the map id, and the **look is revealed then too** (decided). The server then builds
  the layout and the office nav grid during the countdown (brief: 250 ms target). Clients get `layoutSeed` (and
  `LAYOUT_FORMAT_VERSION`) in the match/welcome state, so they build the scene during the countdown too. Late joiners and spectators
  get the same fields.
- **Repeat avoidance (decided):** if more than half of the zone picks repeat the previous match's picks in the same room on the same
  map, the server re-rolls with `LAYOUT_SALT + n` (n = 1..8, then the try with the fewest repeats). Only the final seed is sent. A
  pinned `LAYOUT_SEED` is never re-rolled. Details in section 9.
- No prop list goes over the wire.

### 2.2 Streams (stability and isolation)
Each part of the layout uses its own mulberry32 stream:
`streamSeed(layoutSeed, name) = mixSeed(layoutSeed, fnv1a32(name))`.

| Stream name | Used for | Layer |
|---|---|---|
| `arr:<zoneId>` | variant pick, frame turn/mirror, piece jitter, removed desks or columns | sim |
| `dress:<block>` | office monitor pattern, desk-top clutter, tunnel cover side | sim |
| `loot:<groupId>` | candidate shuffle, beach phase | sim |
| `scatter:<zoneId>` | sim scatter zones | sim |
| `decor:<zoneId>` | decor placements | client |
| `look` | look preset, after-hours lit panels | client |

Why per-zone streams:
- Adding a variant to one POI does not reshuffle every other POI.
- Decor and look can never change a sim placement. The server can skip them (`opts.decor = false`) and still produce
  byte-identical sim data.

A data change that alters any output for an existing seed bumps `LAYOUT_FORMAT_VERSION`. The golden hashes in check LV1 catch a
change nobody intended.

### 2.3 Pinning a layout (`LAYOUT_SEED`)
- Server env `LAYOUT_SEED=<uint32 | 0xHEX | baseline>`: every match in every room uses that layout seed, whichever map is picked.
  `MAP=office LAYOUT_SEED=0x3FA2C1D0 npm run dev` reproduces one office layout exactly. The server logs it once at startup and once
  per match: `match 12 map office layout 0x3FA2C1D0 v1 look afterHours picks TL=pods(3) TR=rows BL=gaps(N2,N3) ...`.
- `LAYOUT_SEED=baseline` (or `0`) gives the baseline: the M2b props and loot positions exactly, every zone's `baseline` pick and the
  baseline look. The only additions are the guaranteed-weapon flags on existing commons and seed-0 decor. Use it for A/B playtests and for tests that
  want "today's map".
- The dev overlay shows the line above, so the user can read it off a screen and report it. The client query `?layoutSeed=` is only
  for offline previews (title screen, harness); online, the server's seed always wins.
- Tooling (game-developer / qa-tester): `matchReport.ts` and a small `layoutReport` take `--layout-seed` and `--layout-seeds N`. They
  print the picks, counts, worst-case metrics and a top-down SVG for one seed.

### 2.4 Determinism rules for the generator
- Pure function of `(baseMap, variety data, layoutSeed, opts)`: no `Math.random`, no time, no balance (clearances are level data), no
  iteration over objects with numeric-like keys. Arrays are processed in data order.
- **Cross-engine safety:** server (Node/V8) and clients (Chromium, Firefox, Safari) must agree bit for bit on every accept/reject
  decision.
  - Decisions use only `+ - * /`, comparisons and `Math.sqrt`, which are correctly rounded IEEE operations.
  - No `Math.hypot`, `Math.sin`, `Math.cos` or `Math.atan2` in a decision. Engines may differ in the last bit for these.
  - Rotations are quantised to 1/1024 turn. Their sin/cos come from a table computed with a fixed polynomial (only `+` and `*`).
    The tech-lead decides where that table lives.
  - Outputs are rounded to mm (positions) and mrad (rotY) **before** any check reads them.
  - The current M2b generators use `Math.hypot`/`Math.sin` at module load. That is an existing small risk, and the new generator
    removes it.
- **Hash check:** the server sends `layoutHash`: FNV-1a 32 over the canonical sim part (`kind,x_mm,y_mm,z_mm,rot_mrad,scale_cm` per
  prop, then `x_mm,y_mm,z_mm,tier,guarantee` per loot spawn). The client compares it to its own result. **Decided:** a mismatch is
  a hard failure in dev and tests; in production the client logs it (seed, version, both hashes) and continues (section 9).

## 3. Generation order and data grammar

### 3.1 Order (one pass, deterministic)
1. **Fixed** placements (section 1).
2. **Arrangement structure:** for each zone in data order, pick a variant and place its structure pieces (everything without
   `fill: true`).
3. **Loot:** resolve the candidates into world positions, drop the dead ones (removed desk, inside a collider after a <= 3 m nudge),
   shuffle per group, then pick per tier while keeping the spacing rule against loot already picked. Guaranteed-weapon groups pick
   first.
4. **Fill and scatter (sim):** the arrangement pieces with `fill: true`, then the scatter zones in `order`. Each item must clear the
   loot by 0.75 m, so loot picked in step 3 never ends up inside a bush clump or crate pile.
5. **Desk dressing (office):** monitors, keyboards, laptops, clutter, tunnel cover.
6. **Decor** (client), then **look** (client).

### 3.2 Fallbacks (why every seed is valid)
- A structure piece gets `pieceTries` (24) jittered tries. If they all fail and the piece is not `optional`, the whole variant fails
  and the zone falls back to its `baseline` variant, placed at nominal positions with no jitter. The level test proves the baseline
  placement is valid.
- Scatter zones place up to their count and may come up short. The cap is the budget, the floor is the `count` minimum, and a
  shortfall below the minimum is reported as a test failure.
- A loot group with too few live candidates takes the rest from its `fallback`: the M2b spot for that group, nudged. Each fallback
  use is counted (`MatchLayout.fallbacks`, logged per match). A fallback layout still passes every check; the tests bound the
  count per seed (island 4, office 6) to catch data that keeps failing.

### 3.3 Grammar (both JSON files)
- **Frames.** A zone has an `anchor` (`{x, z}` or `{polar: [compassDeg, r]}`) and a `frame`:
  - `outward`: local +Z points out to sea (coastal POIs).
  - `quarter`: a random multiple of 90 degrees (summit).
  - `any`: a random angle (grove).
  - `world`: no rotation (office rooms).

  `mirror: true` lets the stream flip local X. Bearing `b` in a zone means the local point `(r sin b, r cos b)`, so 0 is "front".
- **Pieces.** `{kind, <placement>, rot, scale, fill?, optional?, jitter?}` where the placement is one of:
  - `at: [x, z]` or `place: [[x, z], ...]`;
  - `ring: {n, r | [min, max], start, stepDeg?, arc?, jitterDeg?, centre?}`;
  - `line: {from, to, n, jitter}`;
  - `grid: {x: [...], z: [...]}`;
  - `cluster: {centres: <ring>, n, spacing}`;
  - `scatter: {n | [min, max], disc | annulus | rect, centre?, minus?}`.

  `rot` is a number (degrees in the zone frame) or one of:
  - `any`;
  - `face` (local +Z toward the zone origin) or `away`;
  - `tangent` (along a ring) or `along` (along a line);
  - `outward` (fixed island pieces);
  - `faceHull` (the wreck camp hut faces the hull).
- **Loot entries.** `{tier, at | place | ring | polar, guarantee?}` (island) and `[x, z]`, `[x, z, level]`, `{desk, at}` or
  `{tunnel}` (office). A zone's `lootPick` says how many to take per tier from the zone-level list plus the active variant's list.
- **Scatter zones.** `{id, layer: sim | decor, order, area, minus, kinds: [{kind, count | weight, scale}]}`.
- **Rules / budgets / fairness** blocks hold the numbers the checks use (sections 6 and 7).

## 4. Island

### 4.1 Scatter zones
| Zone | Layer | Area | Kinds and counts | Spacing and exclusions | Intent |
|---|---|---|---|---|---|
| `coastPalms` | sim | 24 clusters centred on the gaps between spawns (+-4 deg), r 93-101, cluster radius 6 | palm, 2-5 per cluster (scale 0.85-1.3) | 2 m footprint gap; 4 m spawn pad | Shade on both sides of every spawn, open sand on the spawn |
| `beachClutter` | sim | annulus r 94-103, minus Long Beach and the POI discs | driftwood 8-16, umbrella 5-10, small rock (0.5-0.9) 5-10 | same | Low cover on the ring road, nothing tall |
| `longBeach` | sim | north sector 330-30 deg, r 88-105 | driftwood 0-3 only | same | Keeps the longest open sightline on the map |
| `jungle` | sim | annulus r 18-88, minus POI discs + 2 m, hut aprons, zone-centre discs (3 m) | palm 16-24, bush 38-52, rock 18-26 | same | Cover every 10-15 m between POIs |
| `beachDecor` | decor | r 92-106 | shellCluster 18-26, starfish 8-14, sandcastle 0-3, beachTowel 6-12 (within 3 m of an umbrella) | 0.6 m between decor, 0.2 m outside every footprint, 1 m from loot and spawns | Life on the sand |
| `jungleDecor` | decor | r 12-92 | fernTuft 70-110, flowerTuft 25-45, coconutPile 15-30 (within 2.5 m of a palm) | same | Fills the bare grass |
| `shallowsDecor` | decor | r 107-126 | seaweed 20-30 | same | Marks the wading ring, helps read the world edge |

General island rules (all already in island.md): every pair of collider footprints keeps a 2 m gap, every footprint stays inside the
105 m land limit (docks excepted), and loot keeps 0.75 m from footprints and 2.5 m from other loot.
- **New:** the spawn pad grows from 2.5 m to **4 m**, because players now land on it from the drop.
- **New:** **decor is never taller than 0.5 m**, so it never reads as cover it is not.
- **New:** the zone-centre candidates keep a 3 m clear disc.

### 4.2 POI arrangements
Each POI has 3 variants with weight 1, with `baseline` = today's dressing. The landmark of each POI is fixed (beacon, boathouse and
docks, wreck hull, bar hut), so players can still orient by it.

| POI | Variant | What changes | Cover and sightlines |
|---|---|---|---|
| summit | `beacon` (baseline) | 8 low rocks on a ring r 10-14, 4 crates r 6-8 | Even cover all round; the crown (r < 5) stays open |
| | `cairns` | 3 cairns of 3 small rocks on the shoulders, 3 crates r 7 | Three pockets with wide gaps; long lines through the gaps |
| | `supplyDrop` | a 6-crate L on one flank, 6 rocks on the opposite rim | One flank cover-rich, one a firing line; same total cover |
| grove | `dense` (baseline) | 28-32 palms everywhere | No line longer than about 15 m |
| | `clearing` | palms in a ring r 8-21, a log ring and 3 crates in an r 7 clearing | A small arena around the epics, jungle all round |
| | `trail` | a 5 m palm-free trail through the middle | One medium line across the grove, dense flanks |
| dock | `quay` (baseline) | 10 crates scattered on the quay | As today |
| | `stacks` | 3 x 3 crate grid | Two 6.5 m lanes toward the sea |
| | `unloading` | crate wall along the shore with a gap at the dock, a rowboat on the sand | Cover faces the sea; the dock path stays open |
| village | `ring` (baseline) | 6 huts around the plaza | Hut-to-hut from every side |
| | `crescent` | 5 huts open toward the sea, crate pairs barricade the gap | One open side, defended |
| | `street` | 2 facing rows of 3 huts, 11 m street | A corridor with doorways on both sides |
| wreck | `cove` (baseline) | crates, driftwood and rocks around the hull, rowboat | As today |
| | `spill` | 5 crates trailing from the hull inland | Leapfrog cover along a line |
| | `camp` | small hut facing the hull, log fire ring, torches, rowboat | Cosy close range |
| rocks | `field` (baseline) | 14 boulders at random | Broken lines everywhere |
| | `walls` | two broken walls of 4 boulders parallel to the shore, 2 giants behind (5 + 3 measured +32 % cover over `field` in test run 2) | Lanes, peek through the 3 m gaps |
| | `giants` | 7 big + 7 small boulders | Long hard pieces, short open runs |
| tikibar | `bar` (baseline) | 6 umbrellas, 6 torches, 3 crates | Mostly open sand |
| | `party` | 7 umbrellas in staggered rows, torch path, hut turned +-30 deg | Open and exposed |
| | `boarded` | 4-crate barricade in front of the bar | One defensible spot on an open beach |

**Fairness metrics (checked per variant, section 6 LV15):**
- **Cover score** = the sum of collider-footprint widths of hard cover inside the POI disc. Hard cover means a collider top >= 0.9 m:
  rock, crate, hut, palm trunk, and the wreck hull at scale 1.8. Each variant's mean over 200 seeds stays within **+-20 %** of its
  POI's baseline mean, and every single seed stays within +-50 % (random scatter such as the `field` boulders varies a lot from
  seed to seed; the first test run measured +44 %). The data was sized for this: for example, rocks `walls` is about
  -17 % and summit `cairns` is about -13 %.
- **Sightline median:** 32 rays at 1.1 m eye height from the POI centre against hard-cover colliders, capped at the POI radius +
  30 m. The median ray length stays within **+-25 %** of the baseline. The `trail` and `walls` variants deliberately sit near the top
  of that band.
- Risk and reward is kept: epics only at the summit and grove (the summit crown candidates are always exposed), no epic candidate on
  the beach, and rares at the coastal POIs.

### 4.3 Loot pools
| Group | Candidates | Picked | Notes |
|---|---|---|---|
| `beach` (24 gaps) | 4 per gap = 96 | 36 common | phase p from the stream: gaps with (k + p) even pick 2 (one **guaranteed weapon**), the others 1. Every spawn borders one 2-gap and one 1-gap: 3 loot within 25 m, a weapon about 13-16 m away |
| summit | 8 rare (r 17.5 ring), 2 common, 8-10 epic per variant | 4 E / 4 R / 1 C | epic on the crown and in the variant's pockets |
| grove | 4 rare, 2 common, 6 epic per variant | 3 E / 2 R / 1 C | |
| dock | 8 rare, 2 common | 4 R / 1 C | never on a dock deck |
| village | 6 rare, 4 common per variant | 3 R / 2 C | at hut door fronts |
| wreck | 4 rare, 4 common per variant | 2 R / 2 C | |
| rocks | 3 rare, 6 common | 1 R / 3 C | |
| tikibar | 3 rare per variant, 6 common | 1 R / 3 C | |
| `inland` | 6 rare, 6 common | 2 R / 2 C | outside every POI disc |
| **Total** | **about 150** | **77 = 51 C / 19 R / 7 E** | 12 guaranteed weapons (all beach commons) |

Minimum spacing: 2.5 m between loot points. Every candidate is nudged up to 3 m to clear 0.75 m from footprints. Candidates more
than 104 m from the centre are rejected.

### 4.4 Look presets (graphics picks the values)
| id | Weight | Intent |
|---|---|---|
| `noon` (baseline) | 35 | Today's look: high sun, crisp shadows, clear sea |
| `morning` | 25 | Cool, soft sun low in the east, pale sky, faint sea haze far out |
| `golden` | 25 | Warm sun low in the west, long shadows, orange-pink sky |
| `overcast` | 15 | Flat blue-grey light, weak or no hard shadows, darker sea, light fog |

Fairness limits, for every preset:
- A chibi is fully visible to at least **120 m**. That is past the rifle's 110 m `falloffEnd`, so fog never decides a long fight.
- Sun elevation >= 15 deg, and no glare or bloom.
- Outlines are always on.
- The tide wall stays distinct.

The look has **no sim effect**, so bot vision is unchanged (section 9 asks the game-designer to confirm).

## 5. Office

### 5.1 Desk blocks (TL, TR, BL, BR)
Hard limits:
- Routes land on fixed desks (office.md 4.3), and the bridges join TL S4 / TR S0 and BL N4 / BR N0 flush.
- The vertical aisle is exactly two desk widths.

So a block's **anchor desks** never move, and blocks are never rotated. Variety comes from removing desks:

```
rows (baseline)            gaps (1-2 desks of ONE row)     pods (one middle column out)
N: [N0][N1][N2][N3][N4]    N: [N0][  ][N2][  ][N4]          N: [N0][N1]  :  [N3][N4]
S: [S0][S1][S2][S3][S4]    S: [S0][S1][S2][S3][S4]          S: [S0][S1] b:  [S3][S4]
                           skylights, deck still one piece     12.64 x 13.58 atrium, b = atriumCover
```

| Block | Anchors (never removed) | `gaps` may remove | `pods` may remove column |
|---|---|---|---|
| TL | S0 (Kettle Corner, TL-A), N0 (TL-C), N4 (TL-B), S4 (bridge N) | N1-N3 or S1-S3 | 1 or 3 |
| TR | S0 (TR-A, bridge N), S4 (TR-B), N4 (TR-C, NE perch), N3 (perch route start) | N1-N2 or S1-S3 | 1 or 2 |
| BL | S0 (BL-A, BL-C), N0 (SW perch), N1 (perch route start), N4 (BL-B, bridge S) | N2-N3 or S1-S3 | 2 or 3 |
| BR | N0 (BR-A, bridge S), N5 (BR-B), S5 (BR-C) | N1-N4 or S1-S4 | 2 or 3 |

Weights: `rows` 2, `gaps` 2, `pods` 1. At most **2 blocks** are `pods` in one match. TL/BL and TR/BR never open a column at the same
x, so there is never a straight north-south lane from corridor to corridor.

How each keeps play fair:
- **gaps:** all removed desks are in one row, so the other row keeps the deck in one piece and every route still reaches all of it.
  - A removed desk takes its chair, dressing and clutter. Its tunnel stays, half covered, with its low cover.
  - The hole is a skylight (floor <-> deck shots, grenade drops). Nothing tall goes in it.
  - The gap to the next desk in that row is 12.64 m, inside the >= 6 m plateau-gap rule.
- **pods:** the block splits into two pods with at least one climb route each. The allowed columns guarantee this:
  - TL with column 3 out: the west pod keeps TL-A and TL-C, the east pod keeps TL-B and bridge N.
  - TR with column 2 out: the west pod keeps TR-A and the bridge, the east pod keeps TR-B, TR-C and the perch.
  - BL and BR work the same way.

  The atrium is 12.64 m wide, so it is never jumpable. It gets `atriumCover` (a box and a flush boxSmall, NE or SW of centre, 2 m
  off the leg panels). That stops the atrium from becoming a clean lane, and the zone centre at the block's k2 tunnel keeps its 3 m
  clear disc.
- **Dressing:** each block takes the `plan` monitor pattern or a shuffled one (same counts).
  - Desk-top clutter counts vary in narrow ranges, and every block deck keeps at least **3 full-height cover items** (box, plush,
    laptop), so a deck is never bare.
  - Tunnel cover (one boxSmall and one bookStack per tunnel) flips its diagonal per tunnel.

### 5.2 Rooms and the lounge
All coordinates are in `office.variety.json`. The proposals were checked by hand against walls (2 m or flush), door aprons, spawn
discs and the plateau-gap rule; the generator checks (section 6) are the real gate.

| Zone | Variants | Why it stays fair |
|---|---|---|
| Fishbowl | `boardroom` (baseline, 2 facing pairs) / `split` (two separate tables, 9.9 m walkway, north chairs only) / `rotated` (one table turned north-south, chairs east and west, box pile NW) | Both doors (D2, D3) keep a clear 8.0 x 3.5 m apron; spawn 3 keeps 2.5 m; every table is an unreachable plateau, as today |
| Blue | `pair` (baseline) / `rotated` (turned north-south and pushed east, one chair) / `lounge` (no table: 3 loose chairs, a box pile) | D5 / D7 aprons clear; spawn 7 keeps 2.5 m |
| Pantry | `table` (baseline) / `rotated` (east-west in the north half) / `cleared` (box piles and a stray chair) | D10 / D11 aprons clear; spawn 20 keeps 2.5 m; it stays a one-room grenade trap |
| Lounge | `open` (baseline) / `pod` (back-to-back desk pod with an east-west tunnel, unreachable top) / `storage` (3 box piles on the back wall) | TL-B start disc and approach box clear; spawn 5 keeps 2.5 m |

The Corner Office, Yellow Room, Den, Gym, Paper Jam and Welcome Mat keep their M2b pieces, because routes or epics depend on them.
They only get corner clutter.

### 5.3 Main-aisle cover clusters K1-K4
Each slot keeps its M2b centre plus a jitter of +-6 m in x and +-3 m in z, and picks a shape:
- `boxPair` (baseline, weight 2): a box, 2 flush boxSmalls and a stray chair.
- `wall` (weight 1): 3 boxes flush in a 13.5 m row.
- `loose` (weight 1): a box and 3 stray chairs.

There are always 4 clusters, so the 205 m aisle is always broken into segments of about 100 m or less.
- Clusters avoid the 6 route starts in the aisle (disc and approach box), spawns 9, 19 and 21-24 (2.5 m), the zone centres
  (7.84, 0), (-40, 0) and (56, 0) (3 m), and the chair bands (2 m).
- If all 24 tries fail, the slot uses its M2b position and shape.

### 5.4 Clutter scatter (sim) and decor
- **Wall bands:** clutter flush against the corridor walls (N, S, W and E corridors), one item per 12-20 m, at most 3.6 m deep so the
  corridor's walking lane (section 6, LV8) stays free.
  - Kinds: pottedPlant, box + flush boxSmall, paper stacks (1-2 `bookStack` side by side, never stacked: one stack is a harmless
    0.945 m hop) and `waterCooler` (kit kind; placed flush by its collider, not its drawn size).
  - No stray chairs in the bands: a chair sticks out 6 m or more and would block the lane.
  - Excluded:
    - door aprons and route start discs and approach boxes;
    - spawn discs, extinguisher spots and loot (0.75 m);
    - the open sides (Shush / lounge, Paper Jam, the lobby).
- **Room corners:** each corner of a themed room is filled with chance 0.5, flush to both walls. Corners on a doorway, a route, a spawn
  disc or a fixed prop are rejected. Never in the loos, the Shush alcove or the lounge.
- **Desk-top clutter and tunnel cover:** as M2b, now seeded per match (5.1).
- **Decor (client):** `paperSheets` (new visual-only kind). 40-70 on floors, 30-60 on desk tops, flat, blank or abstract scribbles,
  **no text, names or logos** (office privacy rule).
- Every variable prop's top stays at or below **12 m**, well under the 25 m drone and its jump path. The phone booths, door frames and
  walls are fixed.

### 5.4b Generator safeguards (added after test runs 1-2)
- Block chairs are checked like any variable prop: jittered spot, then the desk's own x, else no chair. For example, the NE
  perch desk's chair (x 80.5) sits in door D8's apron, so it is dropped.
- Laptops (dressing and the 5 extras) try both sides of the desk, else none. Desk clutter also clears every route probe (the
  perch approaches run over desk tops) and, for boxes (top 9.36 m), the 3-6 m plateau-gap ban.
- An aisle cluster that fails all 48 jittered tries falls back to its exact M2b placement, including the chair rotation that
  M2b's spawn nudges were made for.
- Every fallback spawn keeps >= 2 loot points within 30 m: if the random picks leave one short, a plain common that serves
  no spawn moves to the nearest free common candidate within reach (tier counts unchanged).
- Each block deck is topped up to 3 full-height cover items, counted from the placements on the deck area.
- Desk clutter keeps a 1.6 m walkway clear along each desk's front edge. Flush desks line these up into one path per row,
  so clutter can never cut a desk-top loot spot or a desk off its deck (run 3: Kettle Corner's loot was walled in).
- After the four aisle clusters are placed, an r 2 agent must still cross the main aisle (the LV8 rule). If it can't, all
  four go back to their M2b placements (run 4).
- The deck cover minimum is guaranteed, not probabilistic (run 5). Right after each block is built, before loot and clutter,
  laptops go beside the keyboards (every desk side tried) until the deck holds 3 full-height cover items. If even that
  fails, the block is rolled back and rebuilt as `rows`, counted as a fallback. The later clutter top-up still runs as a
  second net.
- The pantry `table` variant sits 1 m north of M2b's spot. M2b's south chair is 0.3 m inside door D1's apron; seed 0 keeps
  M2b as is (run 4).
- Lane E covers the E corridor proper (z >= 16.42). North of that is the main aisle's east end, where cluster K4 stands
  (run 3).
- The wreck's crate and rock scatter discs are centred inland. Most of the old discs lay past the coast, so placement counts
  (and cover) swung from seed to seed (run 3).

### 5.5 Loot pools (office)
| Tier | Groups (pick / candidates) | Used |
|---|---|---|
| Epic | exec desk 2/4, pong W 1/2, pong E 1/2, NE perch 1/2, SW perch 1/2 (both spots on cell p2: p1 would be 29.7 m from spawn 16; BUG-015), bridge N 1/2, bridge S 1/2 | 8 of 16 |
| Rare | deck tops 4/12 (desk-relative), Kettle Corner + Yellow table 2/3, Fishbowl 2 (room list + variant), Blue 2 (same), Shush/lounge 1/3, Yellow floor 1/3, pantry and loos 2/4, Paper Jam 1/3, Gym 2/4, Den 1/3, Corner floor 1/2, Welcome 1/2 | 20 of about 43 |
| Common | 16 guaranteed-weapon regions 1/3 each, tunnels 9/25, deck tops 3/10, N corridor 3/9, main aisle 3/9, S corridor 3/9, W corridor 1/3, E corridor 1/3, rooms 9/18, extinguisher spots 2/4 | 50 of about 140 |

- Epics stay on plateaus you must climb to and stay at least 30 m from every open-plan fallback spawn (every candidate was checked).
- A desk-relative candidate dies with its desk, and a tunnel candidate dies with its column.
- Spacing is 2.0 m between loot on the same level, with a nudge of up to 3 m (as M2b).
- **Guaranteed weapons:** 16 regions, each covering 1-2 fallback spawns. Every fallback spawn has one guaranteed weapon within
  **35 m of floor path** (octile distance on the 1 m nav grid, through doors).

### 5.6 Lighting presets (graphics picks the values)
| id | Weight | Intent |
|---|---|---|
| `day` (baseline) | 50 | Today's look: cool white panels, all lights on |
| `evening` | 30 | Warm late-day tone, ambient a little lower, monitors glow, same lights on |
| `afterHours` | 20 | 35-50 % of light panels lit (picked by the `look` stream), monitor and exit-pictogram glow; tense but readable |

`afterHours` limits:
- Every corridor, both aisles, every enterable room and every alcove has at least one lit panel.
- Every walkable floor point is within **20 m** of a lit panel.
- Outlines stay on.
- No sim effect.

The lit mask is client-only data (`lightsOn`). Exit signs are pictograms only (office.md section 10).

## 6. Hard guarantees as tests
**Seeds:** for each map, `layoutSeed = mixSeed(0x5EED0001, i)` for i = 0..199, plus `0` (baseline) and `0xFFFFFFFF`. That is
**202 seeds per map** on every CI run.

The checks run on the generated `MatchLayout` applied to the base map. They reuse `indoorGeometry.ts` (office) and the island
footprint rules. Fixed pieces are exempt from the variable-prop checks (LV7-LV9) but must pass LV10-LV12 like everything else.

| # | Check | Map | How |
|---|---|---|---|
| LV1 | Deterministic | both | Build twice and deep-equal; equal `layoutHash`; the decor-off build has an identical sim part. Golden hashes for 3 pinned seeds per map |
| LV2 | Picks are valid | both | Each zone's variant id exists; pods <= 2; TL/BL and TR/BR pods at distinct x; anchor desks present; total fallback uses within the 3.2 limit |
| LV3 | Spawns clear | both | Island: no collider footprint within **4 m** of any of the 24 spawns. Office: `spawnIssue(...) === null` at every fallback spawn's exact M2b point (2.5 m, no nudge) |
| LV4 | Landing areas clear | both | Zone-centre candidates: 3 m disc free of colliders (office: of obstacles taller than 1 m; the tunnel's low cover sits next to the block-centre candidates by design, office.md §3.4). Office: every variable prop top <= 12 m. Island: every loot spot (bot drop targets) passes LV5 |
| LV5 | Loot valid and reachable | both | Exact tier counts (77 / 78); clearance (island 0.75 m and on land <= 104 m; office `lootSpotIssue === null`); spacing (2.5 m island, 2.0 m same level office); **every loot point reachable on foot** (island: flood over land cells with colliders inflated by the player radius, from the summit; office: floor flood plus plateau floods through the climb routes, the office.test.ts method) |
| LV6 | Guaranteed weapons | both | Island: every spawn has >= 1 `guarantee: 'weapon'` point within 25 m and >= 3 loot points within 25 m. Office: every fallback spawn has one within 35 m of floor path and >= 2 loot points within 30 m. The baseline (seed 0) is exempt from the office path rule: it keeps M2b's loot positions, and spawn 7 (Blue Room) has no M2b common within 35 m of path |
| LV7 | Doors never blocked | office | No variable collider part with bottom < 1.3 m inside any door apron (8.0 m wide x 3.5 m deep from the wall face, both sides; 8.0 rather than the 8.1 m opening because M2b's Fishbowl chairs sit 2 cm inside an 8.1 m apron). A wide agent (r 1.5) passes every doorway from both sides |
| LV8 | Corridors never blocked | both | Office: no variable collider in lanes N/S/W/E (JSON `lanes`). A wide agent (r 1.5) connects all corridor ends and door aprons, and an r 2.0 agent crosses the main aisle from (-84, 0) to (114, 0). Island: an r 1.0 agent on land connects all 24 spawns along the beach and each POI anchor to the summit; dock landward aprons are clear |
| LV9 | Climb routes never blocked | office | For all 20 routes (counting only parts that rise more than a step, 0.35 m, above the probe's level; a keyboard is walked over): no variable collider within 2 m of the start or in its 3 x 4 m approach box, none within 1.5 m of the end on its level, none within 0.6 m of any waypoint at that waypoint's height. Every deck piece (after gaps/pods) is reached by >= 1 route |
| LV10 | No overlaps | both | Island: every footprint pair has a gap >= 2 m. Office: every floor collider pair has a gap >= 2 m or is flush (<= 0.05 m), except the pairs a template places flush. Office plateau gaps between walkable tops (>= 2 m high, within 1.35 m of each other in height) are never inside 3-6 m. Touching tops at one height count as one plateau (run 2: the outer boxes of one flush `wall` row), and pairs with a full-height wall or glass between them are exempt (run 3: the lounge box vs the Corner Office plant behind glass W12; nobody jumps through a wall) |
| LV11 | Zone centres usable | both | Every candidate keeps its 3 m clear disc and is reached by the floor / land flood |
| LV12 | Stance gaps | office | `raisedGaps(solids)` equals `DELIBERATE_GAPS` (no new gap from rotated tables or new kinds) |
| LV13 | Render budget (static) | both | Per seed: placements per kind and triangles from the asset tables; the worst seed must stay under section 7. The worst seed id is printed for LV13b |
| LV13b | Render budget (measured) | both | graphics-engineer runs the RENDERING.md harness on the worst LV13 seed: office <= 150 calls (medium), island busiest view within the current budget (<= 250 calls, <= 600k tris; props layer <= 31 calls with decor). Every loot spot is populated with a **mix of all item levels 1-4**. Per-level weapon looks (the user asked for a different appearance, or even a different model, per level) add distinct loot parts, so `LootLayer`'s about 30 calls can grow; measure it here |
| LV14 | Nav (office) | office | Per seed: nav build time recorded (server p95 <= 250 ms, reported); every spawn, loot and zone centre reachable in the nav graph. **Stuck rate:** under **2 %** of bot time pooled and <= 5 % in any single seed, measured with the shared nav-walk metric (`navStuckForLayoutSeeds`, `src/shared/sim/tools/navStuck.ts`: 12 bots per layout). Every CI run: 30 layout seeds × 60 s (`layout.test.ts`, about 40 s). Nightly: `npx tsx src/shared/sim/tools/matchReport.ts --map office --nav-walk 180 --layout-seeds 200` (first measurement: 0.42 % pooled, worst seed 2.50 %, no seed over 5 %) |
| LV15 | Cover fairness | both | Section 4.2 metrics for island POIs. Office: deck full-cover >= 3 per block (the generator tops up with plush or a box; the seed-0 baseline keeps M2b's dressing, where TR has 2); atrium and aisle cluster present |
| LV16 | Privacy | office | The name blocklist (office.test.ts) also scans `variety.md`, `office.variety.json` and 202 generated office layouts |
| LV17 | Pacing | both | `matchReport --matches 30 --variant both --layout-seeds 30` per map: median match 330-480 s; no weapon above 35 % of weapon kills (same targets as M2b) |

QA spot checks (manual, with `LAYOUT_SEED`):
- For each office block, walk a `pods` atrium and a `gaps` skylight. Jump from the deck edge toward the hole; you should fall, not
  catch an edge.
- Rotated Fishbowl and Blue tables: try to wedge yourself between the table and the chairs.
- Island `walls` and `street` variants: try to wedge yourself between the boulders and between hut rows.
- `afterHours`: run the whole floor and report any area where you cannot read an enemy at 30 m.
- Report any layout that feels unfair with its `LAYOUT_SEED` line.

## 7. Render and performance budgets (worst seed)
| Map | Budget | Today (M2b) |
|---|---|---|
| island sim props | <= 400 placements; palm <= 140, bush <= 90, rock <= 75, crate <= 60, driftwood <= 32, umbrella <= 18, tikiTorch <= 20, hut <= 10, boat <= 3, dock 2; prop triangles <= 300k | about 350; about 256k |
| island decor | <= 600 instances, <= 150 per kind, <= 0.5 m tall, about 60-120 tris each with no outline hull and no shadow, <= 30k tris; +1 draw call per decor kind (8 kinds) | 0 |
| island draw calls | props layer <= 31 (21 + 8 decor + margin), busiest view <= 250 | 136-147 busiest |
| office | non-ceiling placements <= 680, kit triangles <= 125k (body + hull), <= 150 draw calls medium (props are merged per 40 m chunk, so the call count barely moves with the layout) | about 615; 111k |
| office decor | <= 160 paper placements, merged with their chunk | 0 |
| office nav | per-match build at the vote lock, target <= 250 ms on the server, measured and reported | built once per map |

Instancing: every variant uses the existing repeated kinds (no unique meshes). The new kinds are tiny repeated decor.

## 8. Proposed `MatchLayout` shape (for the tech-lead to type)
```ts
export const LAYOUT_FORMAT_VERSION = 1;

/** One zone's choice, in generation order (logs, dev overlay, minimap legend, tests). */
export interface LayoutPick {
  zone: string;                 // 'summit', 'TL', 'fishbowl', 'K3', ...
  variant: string;              // 'cairns', 'pods', 'rotated', 'wall', ...
  params?: Record<string, number | string>; // e.g. { column: 3 } / { removed: 'N.1,N.2' } / { mirror: 1, turn: 2 }
}

/** A loot spawn of this match. */
export interface LayoutLootSpawn extends LootSpawn {       // { x, z, tier, y? }
  group: string;                // 'beach.g07', 'gw.nw', 'rr.deck', ...
  guarantee?: 'weapon';         // roll from the guaranteed-weapon table, spawnChance 1 (section 9)
}

/** A client-only, no-collider placement (new decor kinds). */
export interface DecorPlacement { kind: string; x: number; y: number; z: number; rotY: number; scale: number }

export interface MatchLayout {
  version: number;              // LAYOUT_FORMAT_VERSION
  mapId: string;
  seed: number;                 // layoutSeed (uint32)
  picks: LayoutPick[];
  look: string;                 // look / lighting preset id
  // Sim part: identical on server and clients; replaces the base map's props and lootSpawns.
  props: PropPlacement[] | IndoorPropPlacement[];  // fixed + arrangements + scatter, colliders and bushes
  lootSpawns: LayoutLootSpawn[];
  hash: number;                 // FNV-1a 32 of the canonical sim part (section 2.4)
  // Client part (own streams; the server may skip it with { decor: false }).
  decor: DecorPlacement[];
  lightsOn?: number[];          // indoor: sorted indices into props of lit lightPanel placements
}

// buildMatchLayout(base: AnyMapData, seed: number, opts?: { decor?: boolean }): MatchLayout
// applyLayout(base: AnyMapData, layout: MatchLayout): AnyMapData   // same type, props + lootSpawns replaced
```
Why this shape:
- `applyLayout` returns an ordinary `AnyMapData`, so colliders, nav, `prepareMap`, the renderer, the minimap and the bots keep their
  signatures. They only have to receive the per-match map instead of `MAPS[id]`.
- `prepareMap` caches per `(mapId, layoutSeed)` instead of per map id.
- The exported `ISLAND` / `OFFICE` stay as the M2b baseline for existing tests and tools until callers move to
  `applyLayout(base, buildMatchLayout(base, seed))`.
- The fixed set does not need its own field. The generator takes the fixed pieces from the variety data and the base map (JSON
  `fixed` / `fixedNote`).

## 9. Requests and numbers needed

### From the game-designer (gameplay numbers)
1. **Guaranteed-weapon roll:** a `loot.guaranteedWeapon` weight table and its level rule. Proposal: pistol 40 / revolver 15 / smg 25
   / shotgun 20, level from the common level table (L1-L2 only), `spawnChance` 1 for these points, extra ammo as normal.
2. **Weapon economy:** with today's weights the guarantees add about **+8 weapons per island match** (12 points) and about **+10 per
   office match** (16 points). Accept it, or lower the plain common weapon weights (for example pistol 20 -> 12) to offset. Your
   call. The point counts are level data, and I can cut regions if you want fewer.
3. Confirm that **loot counts per tier stay fixed per map** (77: 51/19/7 and 78: 50/20/8) and that only positions vary.
4. Confirm that **look presets have no sim effect** (bot vision, hearing and spread unchanged in `afterHours` and `overcast`). The
   preset weights are level data in the JSON; move them to `balance.json` if you prefer.
5. RPG, smoke and the new melee items need no special loot spots: epics already sit only on climbable or exposed plateaus.

### To others (the director relays)
- **tech-lead:**
  - the `MatchLayout` types (section 8);
  - `layoutSeed` + `LAYOUT_FORMAT_VERSION` + `layoutHash` in the match/welcome state (with PROTOCOL_VERSION 4);
  - `LootSpawn.guarantee`;
  - decor kinds as a `DecorKind` union (or `string` + a decor kit);
  - the deterministic trig table (2.4);
  - where `buildMatchLayout` lives. I propose `src/game/levels/layout/`, which I would write after the contract, together with the
    LV level tests.
- **network-engineer:**
  - the `LAYOUT_SEED` env in `server/config.ts` (uint32, hex or `baseline`; invalid values warn once);
  - send the seed at the vote lock;
  - build the layout and the nav during the countdown;
  - per-match log line (2.3).
- **game-developer:**
  - `prepareMap` per `(mapId, layoutSeed)`;
  - the nav build at the lock with its timing reported;
  - `World` takes the per-match map;
  - bots' drop targets come from the layout's loot (already true: drop.md uses `lootSpawns`);
  - `matchReport --layout-seed / --layout-seeds`.
- **graphics-designer:**
  - island decor kinds: `shellCluster`, `starfish`, `sandcastle`, `beachTowel`, `fernTuft`, `flowerTuft`, `coconutPile`,
    `seaweed`. Each <= 0.5 m tall, about 60-120 tris, no hull;
  - office kit `waterCooler` (floor, with a collider, <= 3.6 m deep, top not 0.6-1.35 m above anything walkable, or list the gap for
    `DELIBERATE_GAPS`);
  - visual-only `paperSheets` (blank or abstract, no text).
- **graphics-engineer:**
  - values for the 4 island looks and 3 office presets within the fairness limits;
  - the `lightsOn` mask;
  - decor instancing;
  - LV13b on the worst seed.
- **ui-ux-designer:**
  - the office minimap draws desks from the per-match map (removed desks and pods must show);
  - the dev overlay line (2.3), with a copy-to-clipboard button if cheap.
- **narrative-designer (optional):** if the look should show on the countdown map card ("Island, golden hour"), strings
  `look.<id>.name`.
- **qa-tester:** LV1-LV17 and the spot checks in section 6.

### Decisions (director, M2c phase A)
1. **Repeat avoidance: yes.** At the vote lock the server builds the picks for `layoutSeed`. If more than half of the zone picks
   (same zone, same variant) equal the previous match's picks in the same room, the server re-rolls with
   `layoutSeed = mixSeed(worldSeed, LAYOUT_SALT + n)` for n = 1, 2, ... up to **8 tries**, then keeps the try with the fewest
   repeats (ties: the lowest n). The comparison only applies when the map is the same as the previous match. Only the final seed is
   sent, so clients need no history. `LAYOUT_SEED` pins skip the re-roll.
2. **The look is revealed at the vote lock**, with the map id and the layout seed (not on the vote card).
3. **Hash mismatch:** a hard failure in dev and tests (the client throws and tests fail); in production the client logs it (with
   seed, version and both hashes) and continues.
4. **Office pods cap stays at 2** blocks per match.

### Still open
- Bushes stay in the shared sim list (no collider, but concealment). Moving them to decor saves a little server work and costs
  nothing visible. Proposed: keep them shared for M2c.
