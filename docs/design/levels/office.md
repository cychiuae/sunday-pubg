# Map 2: office

Status: **built** (M2b Phase C). Data: `src/game/levels/office.ts` (`OFFICE: IndoorMapData`, generated from the tables and formulas
below; sizes from the kit `src/shared/kits/office.ts`). Level tests: `src/game/levels/office.test.ts`. Where the build differs from
the Phase A text, the text below is updated and the change is listed in section 14. Rules this follows: `docs/design/systems/maps.md` (game-designer). Prop kinds and sizes:
`src/render/procedural/office.ts` and `docs/art/ASSET_LIST.md` "Office props" (graphics-designer). Names: map id `office`, `poi.<id>`
and `poi.<id>.short` in `en.json` (narrative-designer). References: `seat-plan.png` (layout, authoritative) and `IMG_0555.jpeg`
(look) in the repo root. They stay there and are not copied anywhere.

## At a glance
| | |
|---|---|
| Scale | real x 9. Chibi 1.3 m tall, so desks are 6.66 m plateaus and you can stand under them |
| Floor | 234 x 144 m, x in [-117, 117], z in [-72, 72], flat at y = 0. Half-diagonal 137.4 m (zone start radius 140) |
| Ceiling / walls | 27 m. Every wall is full height, so nothing goes over a wall. No walk-on ceiling |
| Drop | from y = 25 (`maps.office.match.dropHeight`), about 3.1 s, about 28 m of steer reach |
| Rooms | 12 areas: 7 glass or solid rooms you can enter, 3 open alcoves, 2 closed loo cubicle blocks |
| Desk blocks | 4 blocks (5x2, 5x2, 5x2, 6x2 = 42 desks) + 2 bridge desks across the vertical aisle = 2 big plateaus |
| Climb routes | 21: 5 ramps (walk), 12 book stairs (jump), 1 book tower, 2 perch towers, plus 2 flush bridges |
| Player spawns | 24 drop targets (19 open plan, 5 above rooms), split into sets A and B of 12 |
| Loot | 78: 50 common / 20 rare / 8 epic |
| Zone centres | 9 candidates, all inside the floor inset by 15 m |
| Props | about 510 placements of 27 kit kinds (+ about 115 ceiling visuals), about 1,250-1,400 collider parts |

## Conventions
- Metres, Y up. North = -Z (top of the plan), east = +X. Origin = floor centre.
- `rotY` = Three.js `rotation.y`: local +Z points toward world (sin rotY, cos rotY), local +X toward (cos rotY, -sin rotY).
- Kit rule: **fronts face local -Z.** A desk's chair side is -Z. A chair's seat front is -Z (its back is +Z).
  Stairs and ramps climb toward -Z, so their -Z end goes against the plateau.
  - Desk with its chair to the north: rotY 0. Chair to the south: rotY pi.
  - Chair facing a desk: chair rotY = desk rotY + pi.
  - Climb piece with its plateau to the north: rotY 0. South: pi. East: -pi/2. West: +pi/2.
- Kit origins: `floor` = footprint centre on the floor. `surface` = bottom centre (put it on a top, so it needs a base y).
  `wall` = back on local z = 0. Desk top = 6.66 m (`OFFICE_DESK_TOP_Y`). Ping pong top = 6.84 m.
- Walls are given as centrelines. They are 0.9 m thick (kit) and 27 m tall. Doorways are 9.18 m gaps with a `doorFrame`
  centred in the gap, which leaves an 8.1 m wide x 18.9 m tall opening (lintel above).
- Desk depth 6.79 m (z), width 12.64 m (x). A facing pair is 13.58 m deep.

## 1. Floor bands
| Band | x range | z range | Notes |
|---|---|---|---|
| North rooms | -117..117 | -72..-46 | wall centreline z = -46 |
| N corridor | -88..84.13 | -45.55..-30 | 15.55 m clear, minus the top blocks' north chair band (about 6 m) |
| Top desk blocks | TL -68..-4.8, TR 20.48..83.68 | -30..-16.42 | spine z = -23.21. N row centre -26.605, S row centre -19.815 |
| Main aisle | -87.55..117 | -16.42..16.42 | 32.84 m wide, about 20.9 m clear between the chair bands |
| Bottom desk blocks | BL -68..-4.8, BR 20.48..96.32 | 16.42..30 | spine z = 23.21. N row 19.815, S row 26.605 |
| S corridor | -88..117 | 30..45.55 | 15.55 m clear minus the chair band |
| South rooms | -117..117 | 46..72 | wall centreline z = 46 |
| West rooms column | -117..-88 | -72..46 | wall centreline x = -88 |
| W corridor | -87.55..-68 | -46..46 | 19.55 m |
| Vertical aisle (VA) | -4.8..20.48 | -46..46 | 25.28 m = exactly 2 desk widths, so the bridge desks fit flush |
| E corridor | 96.32..117 | -16.42..46 | 20.68 m |

Desk centre x (column k = 0 is the west end):
- TL and BL: -61.68, -49.04, -36.40, -23.76, -11.12.
- TR: 26.80, 39.44, 52.08, 64.72, 77.36.
- BR: the TR columns plus 90.00.
- Bridges: 1.52, 14.16.

The plan is not drawn to scale. These bands keep its topology (the room order on every wall, 5/5/5/6 desks, the main aisle, the
vertical aisle, corridors along the room rows) and fit it to the 234 x 144 floor that maps.md uses. The left/right desk split
lands on the plan's position: the VA is a little east of centre (centre x = 7.84).

## 2. Walls, doors and rooms

### 2.1 Outer walls (solid, 0.9 thick, 27 tall, inner face on the floor edge)
| id | from | to |
|---|---|---|
| O-N | (-117.9, -72.45) | (117.9, -72.45) |
| O-S | (-117.9, 72.45) | (117.9, 72.45) |
| O-W | (-117.45, -72.45) | (-117.45, 72.45) |
| O-E | (117.45, -72.45) | (117.45, 72.45) |

No windows and no gaps. The front door in the lobby is a `doorFrame` dressed as a closed door against O-S at (-74, 71.33), rotY 0.
The outer wall continues behind it, so the world edge is always a plain white wall.

### 2.2 Interior walls (0.9 thick, 27 tall)
| id | material | from | to | between |
|---|---|---|---|---|
| W1 | solid | (-117, -46) | (-106.59, -46) | Loos N / Pantry |
| W2 | solid | (-97.41, -46) | (-88, -46) | Loos N / Pantry |
| W3 | glass | (-88, -46) | (-82.59, -46) | Fishbowl / corridor |
| W4 | glass | (-73.41, -46) | (-54.59, -46) | Fishbowl / corridor |
| W5 | glass | (-45.41, -46) | (-41, -46) | Fishbowl / corridor |
| W6 | glass | (20.48, -46) | (40.41, -46) | Corner / corridor |
| W7 | glass | (49.59, -46) | (51, -46) | Corner / corridor |
| W8 | glass | (51, -46) | (71.41, -46) | Blue / corridor |
| W9 | glass | (80.59, -46) | (84.13, -46) | Blue / corridor |
| W10 | solid | (-88, -72) | (-88, -46) | Loos N / Fishbowl |
| W11 | glass | (-41, -72) | (-41, -46) | Fishbowl / Shush alcove |
| W12 | glass | (20.48, -72) | (20.48, -56.59) | lounge / Corner |
| W13 | glass | (20.48, -47.41) | (20.48, -46) | lounge / Corner |
| W14 | solid | (51, -72) | (51, -46) | Corner / Blue |
| W15 | solid | (84.13, -72) | (84.13, -64.59) | Blue / Yellow |
| W16 | solid | (84.13, -55.41) | (84.13, -46) | Blue / Yellow |
| W17 | glass | (84.13, -46) | (84.13, -42.59) | N corridor end / Yellow |
| W18 | glass | (84.13, -33.41) | (84.13, -30) | N corridor end / Yellow |
| W19 | solid | (84.13, -30) | (84.13, -16.87) | TR east end (flush, face at 83.68) / Yellow |
| W20 | glass | (84.13, -16.87) | (99.41, -16.87) | Yellow / main aisle (aisle face at -16.42) |
| W21 | glass | (108.59, -16.87) | (117, -16.87) | Yellow / main aisle |
| W22 | solid | (-88, -46) | (-88, -42.59) | Pantry / W corridor |
| W23 | solid | (-88, -33.41) | (-88, -26.59) | Pantry / W corridor |
| W24 | solid | (-88, -17.41) | (-88, -4.59) | Pantry, Loos S / W corridor |
| W25 | solid | (-88, 4.59) | (-88, 14) | Loos S / W corridor |
| W26 | solid | (-117, -14) | (-88, -14) | Pantry / Loos S |
| W27 | solid | (-117, 14) | (-88, 14) | Loos S / Paper Jam |
| W28 | solid | (-117, 46) | (-88, 46) | Paper Jam / lobby |
| W29 | solid | (-107, -72) | (-107, -54) | Loos N cubicle block (closed) |
| W30 | solid | (-117, -54) | (-107, -54) | Loos N cubicle block (closed) |
| W31 | solid | (-107, -14) | (-107, -2) | Loos S cubicle block (closed) |
| W32 | solid | (-117, -2) | (-107, -2) | Loos S cubicle block (closed) |
| W33 | solid | (-60, 46) | (-60, 72) | lobby / gym |
| W34 | glass | (-60, 46) | (-49.59, 46) | gym / S corridor |
| W35 | glass | (-40.41, 46) | (0.41, 46) | gym / S corridor |
| W36 | glass | (9.59, 46) | (20.48, 46) | gym / S corridor |
| W37 | solid | (20.48, 46) | (20.48, 72) | gym / Den |
| W38 | glass | (20.48, 46) | (25.41, 46) | Den / S corridor |
| W39 | glass | (34.59, 46) | (103.41, 46) | Den / S corridor |
| W40 | glass | (112.59, 46) | (117, 46) | Den / S corridor |

Open sides (no wall):
- The Shush Booth alcove and the lounge (x -41..20.48 on z = -46).
- Paper Jam Corner's east side (x = -88, z 14..46).
- The lobby's north side (z = 46, x -88..-60).

The cubicle blocks (W29-W32) are closed loo stalls: solid full-height boxes you cannot enter. They read as stall doors in art.

Material rules (maps.md 2.5): glass blocks movement, bullets, grenades, blast line of sight and bot sight. It is only see-through in
rendering. Glass shattering: Later.

### 2.3 Doorways (16, each a 9.18 m gap with a `doorFrame`, 8.1 m clear)
| id | centre | frame rotY | connects |
|---|---|---|---|
| D1 | (-102, -46) | 0 | Pantry - Loos N |
| D2 | (-78, -46) | 0 | Fishbowl - N/W corridor corner |
| D3 | (-50, -46) | 0 | Fishbowl - N corridor |
| D4 | (45, -46) | 0 | Corner Office - N corridor |
| D5 | (76, -46) | 0 | Blue Room - N corridor |
| D6 | (20.48, -52) | pi/2 | Corner Office - lounge |
| D7 | (84.13, -60) | pi/2 | Blue Room - Yellow Room |
| D8 | (84.13, -38) | pi/2 | Yellow Room - N corridor end |
| D9 | (104, -16.87) | 0 | Yellow Room - main aisle |
| D10 | (-88, -38) | pi/2 | Pantry - W corridor |
| D11 | (-88, -22) | pi/2 | Pantry - W corridor |
| D12 | (-88, 0) | pi/2 | Loos S - main aisle west end |
| D13 | (-45, 46) | 0 | Jam & Gym - S corridor |
| D14 | (5, 46) | 0 | Jam & Gym - S corridor (VA south end) |
| D15 | (30, 46) | 0 | Ping Pong Den - S corridor |
| D16 | (108, 46) | 0 | Ping Pong Den - S corridor / E corridor |

Every enterable room has at least 2 doors except the two loos (1 door each), which are deliberately grenade traps.

### 2.4 Rooms (ids from narrative)
| POI id (name) | Area (x, z) | Floor | Enterable | Doors | Contents |
|---|---|---|---|---|---|
| `office_meeting` (Fishbowl Room) | -88..-41, -72..-46 | carpet | yes | D2, D3 | Long table of 4 `deskWood` (2 facing pairs) at x -71.0 / -58.36, z -62.795 (rotY 0) / -56.005 (rotY pi). 8 chairs. 1 plant. TV on the west wall (visual) |
| `office_phone` (Shush Booth) | -41..-16.7, -72..-46 | wood | alcove | open | 2 `phoneBooth` pods (closed, solid, not enterable) at (-35.75, -67.23) and (-21.5, -67.23), rotY pi (doors face the corridor). A 4.7 m slot between them holds rare loot |
| lounge (unnamed, "notice board") | -16.7..20.48, -72..-46 | wood | alcove | open, VA | `pinboard` on the north wall at (2, -72), rotY pi (board at 8.1-16.2 m, walk under). 2 plants, 2 `box`, 2 `boxSmall` |
| `office_corner` (Corner Office) | 20.48..51, -72..-46 | carpet | yes | D4, D6 | Exec `deskWood` at (39.92, -60), rotY 0, top 6.66 = plateau with **2 epic**. Exec chair (39.92, -66.5), rotY pi. Routes CO-A (book stairs) and CO-B (book tower). 2 plants, monitor + keyboard on the desk |
| `office_blue` (Blue Room) | 51..84.13, -72..-46 | carpet | yes | D5, D7 | `deskWood` pair at x 67.5 (z -62.795 rotY 0, -56.005 rotY pi). 4 chairs. 1 plant. TV on the north wall (visual) |
| `office_yellow` (Yellow Room) | 84.13..117, -72..-16.87 | carpet | yes | D7, D8, D9 (pass-through) | `deskWood` pair at x 101 (z -48.395 rotY 0, -41.605 rotY pi) = a climbable table plateau (rare). Routes YEL-N (book stairs) and YEL-S (whiteboard ramp). 4 chairs at (94.5, -57.2), (107.5, -57.2) rotY pi, (91, -45) rotY -pi/2, (111, -45) rotY pi/2. 1 laptop, 1 plant |
| `office_pantry` (Pantry & Loos) | -117..-88, -72..14 | tile | pantry + 2 loos | D10, D11 (pantry), D1 (Loos N), D12 (Loos S) | Pantry: `pantryCounter` at (-114.21, -30), rotY -pi/2 (top 8.1, not reachable). `deskWood` table at (-96, -30), rotY pi/2, with 2 chairs. Bottles and mugs, 2 `box`, 2 `boxSmall`. Loos N: cubicle block W29/W30, a `pantryCounter` as the vanity at (-91.24, -62), rotY pi/2. Loos S: cubicle block W31/W32, a vanity at (-100, 10.76), rotY 0. No toilet models (closed cubicles) |
| `office_admin` (Paper Jam Corner) | -117..-88, 14..46 | wood | alcove | open east side | 3 `filingCabinet` at (-114.3, 18.5 / 22.55 / 26.6), rotY -pi/2 (tops 9 m). `printer` at (-113.5, 40), rotY -pi/2. Admin `desk` at (-99.28, 18.0), rotY pi, with a chair at (-99.28, 24.4). 2 `box`, 3 `boxSmall`, 2 `bookStack` |
| `office_entrance` (Welcome Mat) | -117..-60, 46..72 | tile + mat decal | open north side | open | Reception `desk` at (-106, 52), rotY pi, chair at (-106, 58.4). 3 plants at (-114.5, 69.5), (-90, 69.5), (-63, 69.5). "Delivery pile": 3 `box` + 3 `boxSmall` around (-75, 54). Closed front door on O-S |
| `office_gym` (Jam & Gym Room) | -60..20.48, 46..72 | carpet (rubber look) | yes | D13, D14 | Keyboard stand = `deskWood` at (-30, 67.5), rotY 0, with a `keyboard` on top. 2 `dumbbellRack` at (18.0, 64) rotY pi/2 and (5, 69.9) rotY 0. 2 `guitarStand` at (-54, 68), (-48, 68). 3 `box` (amps / speaker stacks) and 3 `boxSmall`. 2 plants |
| `office_games` (Ping Pong Den) | 20.48..117, 46..72 | carpet | yes | D15, D16 | `pingPongTable` at (58, 59.2), rotY pi/2 (long axis x, top 6.84, **2 epic**, the net divides the halves). Routes DEN-W and DEN-E. `foosballTable` at (98, 59.2), rotY pi/2 (top 8.1, no route). 3 `box`, 2 `boxSmall`, 2 plants |

Not enterable: the two loo cubicle blocks and the phone pods (the kit pod has a closed glass door). Desk tops, the yellow table,
the exec desk and the ping pong table are plateaus (section 4).

## 3. Desk blocks

### 3.1 Desk geometry (kit `desk`, scale 1)
| Part | Collider (local) | Gameplay |
|---|---|---|
| top | box x +-6.3, z -3.37..3.38, y 6.39-6.66 | walkable plateau at 6.66; raised (stand underneath) |
| legL / legR | panels at x -6.12..-5.76 and 5.76..6.12, z +-3.15, y 0-6.39 | full-depth leg panels |
| beam | x +-5.76, z 2.52..2.88, y 5.4-5.94 | raised, irrelevant to movement |

Consequences:
- **Each desk column is a north-south tunnel**: between the leg panels, 11.52 m wide, 13.58 m long, 6.39 m clearance.
  Neighbouring columns are separated by two panels 0.4 m apart (an unenterable crack, not a pocket). You cross a block
  north-south under the desks, and east-west only on top.
- Facing rows share the tunnel (the panels of the two rows are 0.44 m apart at the spine, and the space between them is open).
- Desks in a block are flush (0 m gap), so each block top is one plateau.

### 3.2 Placement rule
- For every block and column k: north-row desk at (x_k, z_N) with rotY 0, and south-row desk at (x_k, z_S) with rotY pi.
  - Top blocks: z_N = -26.605, z_S = -19.815.
  - Bottom blocks: z_N = 19.815, z_S = 26.605.
- Kind: `desk` (white top) in blocks, `deskWood` for the bridges and room tables.
- Chair at a desk: `chair` at (x_k + jitter, z_desk - 6.4) for north-row desks and (x_k + jitter, z_desk + 6.4) for south-row desks.
  - jitter = seeded uniform [-2, 2].
  - Chair rotY = desk rotY + pi.
  - The chair base (cylinder r 2.97, 0.81 tall) then just touches the desk front. The seat (4.41) and arms (6.21) tuck under the
    slab (6.39).
  - Chair bands: N corridor z -35.97..-30.03, aisle z +-10.43..16.42, S corridor z 30.03..35.97.
- Chair exceptions:
  - Omitted where a ramp lands: TL S k0, TR S k4, BL N k4, BR N k5.
  - Fixed x (no jitter), to keep 2 m from a route: TL N k4 -13.5; TR S k0 30.0; BR N k0 30.0; BL S k0 -57.5;
    TR N k4 80.5; TR S k3 and BR N k4 no jitter toward the ramp (clamp x <= desk x).
  - 38 desk chairs in total.

### 3.3 Blocks, flavour and monitors
Flavour comes from the plan's colour blocks only. No nameplates or names anywhere. Monitors per desk follow the plan's monitor
icons, by column k = 0..5 from west to east ("-" = no monitor, 1 = `monitor`, 2 = `monitorDual`):

| Block | POI | North row k0..k5 | South row k0..k5 | Notes |
|---|---|---|---|---|
| TL (top-left) | `office_tea` on S k0. No block POI (mostly hot desks) | - - 1 1 1 | K - 1 1 1 | K = **Kettle Corner** desk cell (no monitor, no chair; ramp TL-A lands on it) |
| TR (top-right) | `office_sales` (Sales Row) | 1 1 1 1 P | 1 1 1 1 1 | P = NE perch desk (no monitor) |
| BL (bottom-left) | `office_design` (Design Bay, east half) + `office_project` (Deadline Corner, west half) | P 1 1 1 1 | 1 1 2 2 2 | P = SW perch desk (the plan's admin/QA cell) |
| BR (bottom-right) | `office_eng` (Engineering Pit) | 2 2 1 1 1 1 | 2 1 1 1 1 1 | 6 columns, east end faces the E corridor |

Totals: 30 single + 6 dual = 36 monitored desks (42 screens). 6 desks without a monitor: TL N k0, N k1, S k0, S k1, TR N k4, BL N k0.

Desk-top dressing rule (surface props at base y 6.66, local frame of the desk):
- Monitor or dual monitor at local (0, +1.5): screen centre 1.88 m from the back edge, which meets the kit's 1.8 m rule.
  World: rotY 0 means z + 1.5, rotY pi means z - 1.5.
- `keyboard` at local (0, -0.6) on every monitored desk.
- Desks with no monitor, except K and P: a `laptop` at local (+-3.0, -0.8). 5 more laptops go on random monitored desks.
- Clutter: 1-3 seeded items per desk from {mug, waterBottle, bookStack, boxSmall, plushSeal/Crab/Whale}, at local x in
  +-(3.6..5.4), z in -2.6..+0.6. Keep 1 m from loot points and from route landing points.
- Kettle Corner (TL S k0 at (-61.68, -19.815)): 6 `mug`, 4 `waterBottle`, 2 `boxSmall` (tea and snack boxes), 1 `plushWhale`.
  It is a counter-like cell, and the main ramp TL-A arrives here.
- Block totals: 24 mug, 18 waterBottle, 16 plush, 12 bookStack, 8 boxSmall, 4 box (full cover on the deck), 8 laptop.

**Monitors are canopies, not cover (director ruling, no art change).** The kit's screen collider spans 1.4-4.37 m above the desk.
A standing 1.3 m chibi fits under it, so on a plateau a monitor blocks only shots from above and the 0.23 m pole. Plateau cover
comes from plush (2.3-2.5 m), laptops (2.0), `box` (2.7), `boxSmall` (0.99) and `bookStack` (0.95). maps.md 2.4 needs a correction
(open issue T11).

### 3.4 Low cover under every block (maps.md 2.4)
Per tunnel (desk column k of every block, 21 tunnels), with s = (-1)^k and z_sp = the block spine:
- `boxSmall` (0.99 m, crouch and prone cover) at (x_k + 2s, z_sp + 2.5s).
- `bookStack` (0.95 m, prone cover) at (x_k - 2s, z_sp - 2.5s).
- Both stay more than 2.2 m from the leg panels. The tunnel centre (x_k, z_sp) is kept free for loot.
- Chair bases (0.81 m, r 2.97) at each tunnel mouth are prone cover too.
- The 4 bridge tunnels get 1 `boxSmall` each at (x_bridge + 3, z_bridge) (3, not 2, so the under-bridge loot keeps 0.75 m).
- Under a desk, standing (1.3 m) you are visible over all of these. Crouched behind a `boxSmall`, or prone behind anything, you are
  hidden from floor-level shooters. The slab hides you from the plateau.

### 3.5 Bridges (plateau links over the VA)
| id | deskWood placements | top | links |
|---|---|---|---|
| bridge N | (1.52, -19.815) and (14.16, -19.815), rotY pi | 6.66 | TL S k4 - TR S k0, flush (gap 0) |
| bridge S | (1.52, 19.815) and (14.16, 19.815), rotY 0 | 6.66 | BL N k4 - BR N k0, flush |

- **Upper deck** = TL + bridge N + TR: one plateau 151.7 m long. **Lower deck** = BL + bridge S + BR: 164.3 m long.
- Under each bridge the VA splits into two 11.52 m lanes.
- The VA's other row (top N row, bottom S row) is open, with a 25.28 m gap between the blocks: never jumpable.
- Each bridge seam holds 1 epic: exposed to the main aisle, both decks and the VA.

## 4. Climb routes (explicit data for the nav graph)

### 4.1 Rules met
- Ramps are walkable. Every other step rises <= 0.95 m: a jump, under the maps.md cap.
  - `bookStairs`: 7 steps of 0.945 m, treads 1.8 m; step 7 is 6.615, then a 0.045 m walk step onto the desk (6.66) or 0.225 onto
    the ping pong table (6.84). Waypoints use 0.945 k. The level test enforces the 0.95 cap on every physical step.
  - `bookStack`: 0.945 m per stack.
  - `whiteboardRamp`: kit `ramp` collider, 6.66 m over 14.85 m. The sim compiles it to stairs under its stair rule (rise <= 0.8 x
    `stepHeight` = 0.28): **24 steps of 0.2775 m rise**, tread 0.618 m. The walk route has one waypoint per step.
- Every desk block has a walk route and a jump route at **opposite ends**, plus a third route.
- Plateau gaps: inside a block 0; bridges 0; VA open row 25.28; main aisle 32.84; every room plateau is at least 6 m from any
  other plateau it could be jumped to.
  - Paper Jam desk to filing cabinets: 6.0.
  - Gym keyboard desk to guitar stands: 9.9.
  - Den table to foosball: 22.
  - Corner desk to plants: 6.5.
  - Fishbowl table to plant: 6.5.
- The ping pong net is a wall between the two table halves, so each half has its own route. The model is 1.35 m; the **collider
  is 1.6 m** (`OFFICE_PING_PONG_NET_WALL`), over the 0.95 cap and over the ~1.41 m physical hop.

### 4.2 Waypoint formula
dir = world direction of climbing = -(sin rotY, cos rotY).
- `bookStairs` at centre C:
  - start (floor) = C - 7.5 dir.
  - step k (k = 1..7) = C + (-5.4 + 1.8 (k - 1)) dir, at y = 0.945 k (kit tops 0.95, 1.89, 2.84, 3.78, 4.73, 5.67, 6.66).
  - end = C + 7.8 dir, on the plateau.
- `whiteboardRamp` at C: start = C - 8.5 dir, then one waypoint on the centre of each of the 24 compiled steps (y = 0.2775 i), end
  = C + 8.9 dir. Walk.
- Book towers: start, then each cell's top (base + 0.945 n), then the end (CO-B only).
- Bots jump whenever the next waypoint is more than `stepHeight` (0.35) higher. Drop-down links come from plateau edges (maps.md 4).

### 4.3 Route list
| id | kind | placement (x, z, rotY) | start (x, y, z) | end (x, y, z) | plateau | mode |
|---|---|---|---|---|---|---|
| TL-A | whiteboardRamp | (-61.68, -9.0, 0) | (-61.68, 0, -0.5) | (-61.68, 6.66, -17.9) | upper (Kettle Corner) | walk |
| TL-B | bookStairs | (-6.3, -36.3, pi) | (-6.3, 0, -43.8) | (-6.3, 6.66, -28.5) | upper (TL N k4) | jump |
| TL-C | bookStairs | (-74.3, -26.6, -pi/2) | (-81.8, 0, -26.6) | (-66.5, 6.66, -26.6) | upper (TL N k0) | jump |
| TR-A | bookStairs | (23.5, -10.12, 0) | (23.5, 0, -2.62) | (23.5, 6.66, -17.92) | upper (TR S k0) | jump |
| TR-B | whiteboardRamp | (76.0, -9.0, 0) | (76.0, 0, -0.5) | (76.0, 6.66, -17.9) | upper (TR S k4) | walk |
| TR-C | bookStairs | (74.0, -36.3, pi) | (74.0, 0, -43.8) | (74.0, 6.66, -28.5) | upper (TR N k4, perch desk) | jump |
| BL-A | bookStairs | (-74.3, 26.6, -pi/2) | (-81.8, 0, 26.6) | (-66.5, 6.66, 26.6) | lower (BL S k0) | jump |
| BL-B | whiteboardRamp | (-11.12, 9.0, pi) | (-11.12, 0, 0.5) | (-11.12, 6.66, 17.9) | lower (BL N k4) | walk |
| BL-C | bookStairs | (-64.0, 36.3, 0) | (-64.0, 0, 43.8) | (-64.0, 6.66, 28.5) | lower (BL S k0) | jump |
| BR-A | bookStairs | (23.5, 10.12, pi) | (23.5, 0, 2.62) | (23.5, 6.66, 17.92) | lower (BR N k0) | jump |
| BR-B | whiteboardRamp | (90.0, 9.0, pi) | (90.0, 0, 0.5) | (90.0, 6.66, 17.9) | lower (BR N k5) | walk |
| BR-C | bookStairs | (102.62, 26.6, pi/2) | (110.12, 0, 26.6) | (94.82, 6.66, 26.6) | lower (BR S k5) | jump |
| CO-A | bookStairs | (27.3, -60, -pi/2) | (21.9, 0, -56.6) [side entry: west wall at 20.93] | (35.1, 6.66, -60) | exec desk | jump |
| CO-B | book tower (28 `bookStack`) | cells below | (35.0, 0, -49.5) | (37.08, 6.66, -58.6) | exec desk | jump |
| DEN-W | bookStairs | (39.37, 59.2, -pi/2) | (31.87, 0, 59.2) | (47.17, 6.84, 59.2) | ping pong W half (+0.225 last step) | jump |
| DEN-E | bookStairs | (76.63, 59.2, pi/2) | (84.13, 0, 59.2) | (68.83, 6.84, 59.2) | ping pong E half | jump |
| YEL-N | bookStairs | (101, -58.09, pi) | (101, 0, -65.59) | (101, 6.66, -50.29) | yellow table | jump |
| YEL-S | whiteboardRamp | (101, -30.79, 0) | (101, 0, -22.29) | (101, 6.66, -39.69) | yellow table | walk |
| PERCH-NE | bookStack tower on TR N k4 | cells below | (69.5, 6.66, -26.6) | (80.42, 10.46, -26.6) | perch NE | jump |
| PERCH-SW | bookStack tower on BL N k0 | cells below | (-54.0, 6.66, 19.8) | (-64.72, 10.46, 19.8) | perch SW | jump |

Upper deck: 2 walk + 4 jump routes. Lower deck: 2 walk + 4 jump routes. Both decks link across the VA by the flush bridges.

**CO-B book tower.** `bookStack` columns (2.08 x 2.7 footprint), base y 0, n stacks = top 0.95 n. Waypoints in order:

| cell | (x, z) | stacks | top |
|---|---|---|---|
| o1 | (35.00, -52.56) | 1 | 0.95 |
| o2 | (37.08, -52.56) | 2 | 1.90 |
| o3 | (39.16, -52.56) | 3 | 2.85 |
| o4 | (41.24, -52.56) | 4 | 3.80 |
| i4 | (41.24, -55.26) | 5 | 4.75 |
| i3 | (39.16, -55.26) | 6 | 5.70 |
| i2 | (37.08, -55.26) | 7 | 6.65 |

Then onto the desk at (37.08, 6.66, -58.6). Cell i1 is left empty; it is open under the desk, so it is not a pocket.

**Perch towers.** `bookStack` columns standing on the desk top (base y 6.66), cells 2.08 (x) x 2.7 (z):

| | s1 | s2 | s3 | p1 | p2 |
|---|---|---|---|---|---|
| NE x (z = -26.6) | 72.10 | 74.18 | 76.26 | 78.34 | 80.42 |
| SW x (z = 19.8) | -56.40 | -58.48 | -60.56 | -62.64 | -64.72 |
| stacks | 1 | 2 | 3 | 4 | 4 |
| top | 7.605 | 8.55 | 9.495 | 10.44 | 10.44 |

- The platform is p1 + p2: 4.16 x 2.7 m at 10.44 m (10.46 in older text = 0.95 per stack). Eye height 11.49 is above the monitor
  tops (11.03), so you see over the decks.
- A walk-off costs about 15 HP at `fallDamageMinSpeed` 18, which is an intentional risk. Climbing down the steps is free.
- Perches are for humans and optionally for bots (`plateauHoldChance`).

Merge note: stacked `bookStack` instances in one cell can share one box collider (base to top). That turns 56 tower/perch
instances into 19 colliders.

## 5. Cover and sightlines

### 5.1 Long lanes (risky, like the island beach)
| Lane | Length | Breaks | Weapons |
|---|---|---|---|
| Main aisle | 205 m (Loos S door to the east wall) | 4 centre cover clusters K1-K4 (each a `box` 2.7 m + 2 `boxSmall` + 1 stray chair) at (-52, 4), (2, -5), (46, -5), (100, 6). The ramps and stairs jut in from both sides | DMR and rifle in roughly 100 m segments along the edges. The bot vision override (40 / 60 m) stops bots from sniping its full length |
| Vertical aisle | 91 m (lounge to the gym glass) | bridges overhead (you see and shoot under them) | rifle, LMG |
| N and S corridors | about 170 m | chair bands on one side (prone cover r 2.97); routes TL-B, TR-C, BL-C jut out | DMR. Glass walls show players inside rooms, who cannot be shot through the glass |
| Deck to deck across the aisle | 33-45 m, at 6.66 m height | plush, boxes, laptops on the decks | DMR, rifle. Prone on a deck edge is invisible from the floor |
| Perch to perch (NE to SW) | 147 m diagonal at 10.46 m | monitor canopies sit below eye height | sniper duel lane, the reason the perches carry epic loot |

### 5.2 Close quarters (like the island jungle)
- **Under-desk tunnels**: 21 tunnels plus 4 under the bridges, each 11.52 m wide, with panel walls between them. Shotgun and SMG.
  A grenade lobbed into a tunnel mouth is contained by the leg panels, which block blast line of sight.
- **Rooms**:
  - Fishbowl, Blue, Yellow: medium. Table tunnels in the middle.
  - Pantry, Loos (1 door): shotgun and grenade traps.
  - Corner Office: 2 doors, exec desk plateau. Grenade the desk from D4 or D6.
  - Den: big room. The table top is exposed to both doors.
- **Shush Booth slot**: a 4.7 m dead-end nook between the pods, shotgun range.

### 5.3 Stance (low cover)
| Height | Props | Hides |
|---|---|---|
| 0.81 | chair base (r 2.97) | prone |
| 0.86-0.95 | mug, bookStack | prone (crouch 0.95 only marginally) |
| 0.99 | boxSmall | crouch and prone |
| 2.0-2.7 | laptop lid, plush, box | everyone |
| raised 1.4-4.37 above a desk | monitor screen (canopy) | blocks only shots from above (director ruling: stays a canopy) |

- Stance heights: stand 1.3, crouch 0.95, **prone 0.6** (BUG-008; was 0.5).
- Prone on a plateau is invisible from the floor (maps.md 2.4).
- Under a desk you are covered from above. Crouch behind a `boxSmall` to hide from the aisle.
- Every block has both kinds of low cover (section 3.4).

**Deliberate gaps (stance.md level rule).** Every raised collider whose bottom sits 0.6-1.35 m above a walkable top must be listed
here. `office.ts` exports the list as `DELIBERATE_GAPS`, and the level test scans every placed part and fails on any gap that is not
on it.

| Part | Gap | Over | Who fits | Notes |
|---|---|---|---|---|
| `chair.back` | 0.99 m | the chair seat top (4.41) | crouch, prone | The seat is only reachable by dropping off a desk; the gap is at the back edge of the seat |

Checked and outside the band (not gaps): monitor screens 1.395 m above the desk top (a standing 1.3 m chibi passes under: the
canopy), laptop lids 0.135 m, desk beams and the foosball cabinet 5.4 m, desk slabs 6.39 m, door lintels 18.9 m, the pinboard 8.1 m.
Everything else sits directly on the surface under it.

### 5.4 Grenades
- Room walls are 27 m, so grenades only pass through doorways.
- From the floor the max apex is about 8.6 m, so lobs land on desk tops and the yellow table. The perches (10.46 m) are hard to hit
  from the floor and easy from the decks.
- Office loot tweaks (maps.md 2.6) raise grenade weights, which suits the tunnels and loos.

## 6. Props per area (kit kinds, counts)
Sizes and colliders: `docs/art/ASSET_LIST.md` "Office props". Key sizes at x9:
- desk: 12.64 x 6.79, top 6.66.
- chair: base r 2.97 / 0.81, seat 4.41, back to 10.08.
- monitor: 4.95 wide, screen 1.4-4.37 above the desk. Dual: 10.12 wide.
- bookStairs: 2.25 x 12.6. whiteboardRamp: 10.8 x 14.84. bookStack: 2.08 x 2.7 x 0.95. boxSmall: 2.97 x 1.98 x 0.99.
- box: 4.5 x 3.6 x 2.7. phoneBooth: 9.54 square x 19.8. pingPongTable: 13.72 x 24.66, top 6.84. foosballTable: top 8.1.
- pantryCounter: 16.56 x 5.58, top 8.1. filingCabinet: top 9. pottedPlant: pot r 1.35, leaves to 7.92.

| Area | Props |
|---|---|
| Desk blocks (TL, TR, BL, BR) | desk 42, chair 38, monitor 30, monitorDual 6, keyboard 36, laptop 8, mug 24, waterBottle 18, plush (seal 5 / crab 5 / whale 6) 16, bookStack 12 (top) + 21 (under), boxSmall 8 (top) + 21 (under), box 4 (top) |
| Bridges | deskWood 4, boxSmall 4 (under) |
| Routes in the open plan | whiteboardRamp 4, bookStairs 8, bookStack 28 (2 perches) |
| Main aisle cover K1-K4 | box 4, boxSmall 8, chair 4 |
| Fishbowl Room | deskWood 4, chair 6 (4 on the long sides, 2 at the west end), pottedPlant 1 |
| Shush Booth + lounge | phoneBooth 2, pinboard 1, pottedPlant 2, box 3, boxSmall 3 |
| Corner Office | deskWood 1, chair 1, monitor 1, keyboard 1, bookStairs 1, bookStack 28 (CO-B), pottedPlant 2, plushWhale 1, mug 1 |
| Blue Room | deskWood 2, chair 4, pottedPlant 1 |
| Yellow Room | deskWood 2, chair 4, bookStairs 1, whiteboardRamp 1, laptop 1, pottedPlant 1 |
| Pantry & Loos | pantryCounter 3 (1 kitchen + 2 vanities), deskWood 1, chair 2, waterBottle 6, mug 4, box 2, boxSmall 3 |
| Paper Jam Corner | filingCabinet 3, printer 1, desk 1, chair 1, box 2, boxSmall 3, bookStack 2 |
| Welcome Mat | desk 1, chair 1, pottedPlant 3, box 3, boxSmall 3, doorFrame 1 (closed front door) |
| Jam & Gym Room | deskWood 1, keyboard 1, dumbbellRack 2, guitarStand 2, box 3, boxSmall 3, pottedPlant 2 |
| Ping Pong Den | pingPongTable 1, foosballTable 1, bookStairs 2, box 3, boxSmall 2, pottedPlant 2 |
| Fire extinguishers (plan spots) | fireExtinguisher 4 at (-33.4, -44.0) N corridor by the Shush Booth, (-86.6, -15.5) pantry corner, (-86.6, 44.6) Paper Jam / lobby corner, (14.5, 44.6) S corridor at the VA end. A common loot point sits 1.5 m from each |
| Doors | doorFrame 16 (D1-D16) |
| Ceiling (visual only, no colliders) | lightPanel about 100: rows at z -38, -23.2, -8, 8, 23.2, 38, x = -78 + 16.2 i (i = 0..11), skipping any panel that crosses a wall, plus about 30 in rooms. Origin y 21.6 (hangs 5.4 m below the 27 m ceiling). acCassette 14 at the ceiling, x -60 / -20 / 20 / 60 / 100 x z +-23.2, plus 4 in rooms. Ducts and exposed ceiling: graphics-engineer |

**Totals**:
- desk 44, deskWood 15, chair 63, monitor 31, monitorDual 6, keyboard 38, laptop 9, mug 29, waterBottle 24, plush 17.
- bookStack 91, boxSmall 58, box 24.
- whiteboardRamp 5, bookStairs 12, pottedPlant 14, filingCabinet 3, printer 1, pinboard 1, fireExtinguisher 4, phoneBooth 2.
- pingPongTable 1, foosballTable 1, dumbbellRack 2, guitarStand 2, pantryCounter 3, doorFrame 16.
- About 510 placements, all instanced kit kinds, plus 44 wall runs (`createOfficeWall`).
- Collider parts are about 1,400. That drops to about 1,250 if chair arms and keyboards are made soft and stacked books merge.

**Placement rule (QA-checkable)**:
- Ground obstacles keep >= 2 m apart, or are flush (0 m).
- The only sub-2 m cracks are deliberate unenterable slivers: leg panels 0.4 m, chairs against walls 0.48 m, Fishbowl south chairs
  to glass 0.48 m.
- Loot keeps >= 0.75 m from prop footprints. Nudge on the same level within 3 m, like the island.

**Optional kit additions (Later, not needed for this layout; placeholders are box / boxSmall)**:
- sofa (0.12 m-real legs, so a crouch-only gap of 1.08 m). A deliberate gap: list it in section 5.3 when it is placed.
- drawer pedestal on casters: **gap >= 0.7 m** (prone height is 0.6 m since BUG-008; the old 0.6 m gap would not fit), prone-only
  crawl. A deliberate gap: list it in section 5.3 when it is placed.
- bin, backpack (1.2 m crouch cover), beanBag, treadmill, drumKit, kettle / coffee machine, wall TV, toilet cubicle front.

## 7. Spawns, loot, zone

### 7.1 Player spawns (24 fallback points)
**Superseded start:** matches start aboard the delivery drone (route at `maps.office.drop.carrierAltitude` 25, ADR 0005 §8,
drop.md); `spawnJitter` is gone. `playerSpawns` is a flat fallback list (dev/test World option, nav reachability tests,
review). The A/B sets below are kept only as design notes; they are not in the data (ARCHITECTURE §15.5 T9).

Rules checked (level test):
- Mostly open plan (19 open, 5 above rooms).
- >= 2.5 m from any collider (chair backs reach 3.62 m from the chair centre). The generator nudges a crowded point up to 3 m.
  Spawn 8 is nudged off the Yellow chair at (107.5, -57.2); spawn 21 may move a few decimetres off the K1 chair.
- >= 30 m horizontally from every open-plan epic (perches, bridges).
- No spawn above the Corner Office or the Den.
- Every spawn has >= 2 loot points within 25 m, and lands on floor reachable from the crossroads.
- Nearest neighbour >= 18 m (20 m before nudges).

| # | (x, z) | where | set |
|---|---|---|---|
| 1 | (-76, -39) | N corridor, W end | A |
| 2 | (-48, -39) | N corridor | B |
| 3 | (-46.5, -62) | above Fishbowl (east strip) | A |
| 4 | (-20, -39) | N corridor, Shush front | B |
| 5 | (6, -62) | lounge | A |
| 6 | (42, -39) | N corridor, Corner front | B |
| 7 | (55.5, -62) | above Blue (west strip) | A |
| 8 | (110, -60) | above Yellow | B |
| 9 | (104, 0) | main aisle E end | A |
| 10 | (112, 22) | E corridor | B |
| 11 | (90, 40) | S corridor E | A |
| 12 | (64, 39) | S corridor | B |
| 13 | (34, 39) | S corridor, Den front | A |
| 14 | (-20, 62) | above Jam & Gym | B |
| 15 | (-16, 39) | S corridor | A |
| 16 | (-40, 39) | S corridor W | B |
| 17 | (-100, 60) | Welcome Mat | A |
| 18 | (-102, 30) | Paper Jam Corner | B |
| 19 | (-78, -8) | main aisle W end | A |
| 20 | (-104, -36) | above Pantry | B |
| 21 | (-40, 0) | main aisle | B |
| 22 | (-20, -4) | main aisle | A |
| 23 | (32, 0) | main aisle | B |
| 24 | (60, 0) | main aisle | A |

- (Phase A proposal, dropped by T9: N <= 12 picks set A or B; N > 12 takes all 24.)

### 7.2 Loot (78 = 50 common / 20 rare / 8 epic)
Loot spawns need a **y** (plateau or floor at the same x, z). y = 0 is the floor, including under desks.

**Epic (8)**: all hard to reach, all at least 30 m from open-plan spawns or behind walls.
| id | (x, y, z) | spot |
|---|---|---|
| E1 | (36.5, 6.66, -60) | Corner Office exec desk |
| E2 | (43.5, 6.66, -60) | Corner Office exec desk |
| E3 | (51.5, 6.84, 59.2) | ping pong W half |
| E4 | (64.5, 6.84, 59.2) | ping pong E half |
| E5 | (80.42, 10.44, -26.605) | NE perch, on p2 (the route's last cell) |
| E6 | (-64.72, 10.44, 19.815) | SW perch, on p2 |
| E7 | (6.84, 6.66, -19.815) | bridge N, 1 m west of the seam |
| E8 | (8.84, 6.66, 19.815) | bridge S, 1 m east of the seam |

Build note: the Phase A spots for E5-E8 and R06 sat exactly on a seam (the 1 cm crack between perch stacks, the 4 cm crack between
flush desks), where no top supports the item. They now sit on one side of the seam. E5/E6 use p2, not the p1/p2 seam, which also
keeps spawn 16 more than 30 m from E6. Every loot spot is also nudged (same level, <= 3 m) off any prop closer than 0.75 m.

**Rare (20)**:
| id | (x, y, z) | spot | id | (x, y, z) | spot |
|---|---|---|---|---|---|
| R01 | (-36.4, 6.66, -28.0) | TL N k2 top | R11 | (112, 0, -25) | Yellow floor |
| R02 | (52.08, 6.66, -18.3) | TR S k2 top | R12 | (-28.6, 0, -67) | Shush slot |
| R03 | (-23.76, 6.66, 18.3) | BL N k3 top | R13 | (-96, 0, -30) | under pantry table |
| R04 | (64.72, 6.66, 28.3) | BR S k3 top | R14 | (-106, 0, 40) | Paper Jam |
| R05 | (-58.5, 6.66, -19.5) | Kettle Corner | R15 | (-30, 0, 55) | Jam & Gym |
| R06 | (101, 6.66, -46) | Yellow table top (1 m north of the seam) | R16 | (0, 0, 66) | Jam & Gym |
| R07 | (-71, 0, -59.4) | under Fishbowl table | R17 | (58, 0, 59.2) | under ping pong table |
| R08 | (-45, 0, -68) | Fishbowl corner | R18 | (39.92, 0, -60) | under exec desk |
| R09 | (67.5, 0, -59.4) | under Blue table | R19 | (-110, 0, 66) | Welcome Mat |
| R10 | (80, 0, -68) | Blue corner | R20 | (-100, 0, -60) | Loos N |

**Common (50)**, all y = 0 unless noted:
- Tunnels (11): (-49.04, -23.2), (-23.76, -23.2), (39.44, -23.2), (64.72, -23.2), (-49.04, 23.2), (-11.12, 23.2), (26.8, 23.2),
  (52.08, 23.2), (77.36, 23.2), under bridge N (1.52, -19.8), under bridge S (14.16, 19.8).
- Desk tops, y 6.66 (4): (-11.12, -18.3), (26.8, -28.2), (-49.04, 28.3), (94.0, 18.3).
- N corridor (6): (-62, -40), (-33.4, -42.0) [extinguisher], (-2, -40), (26, -40), (56, -42), (79, -42).
- Main aisle (7): (-60, 4), (-28, -4), (7.84, 0) [crossroads], (18, -4), (46, 4), (88, -4), (110, -8).
- W corridor (1): (-78, -28).
- S corridor (6): (-56, 40), (-28, 42), (2, 40), (20, 42), (48, 40), (76, 42).
- E corridor (1): (106, 36).
- Rooms (11):
  - Loos N (-112, -50), Loos S (-98, 2), Pantry (-108, -42), Paper Jam (-97, 18), Welcome Mat (-80, 56).
  - lounge (-6, -55), Corner (25, -50), Yellow (96, -66), Jam & Gym (-45, 52), Fishbowl (-84, -52), Den (112, 54).
- Extinguisher spots (3): (-85, -18), (-85, 43), (14.5, 42.8).

Risk vs reward:
- Epic only on plateaus you must climb to, or in the two rooms whose epics sit on climbable tops (Corner Office, Den).
- Rares sit in rooms and on deck tops.
- Commons sit along the corridor ring and in tunnels, so everyone is armed within about 30 s.
- Hot drops: Ping Pong Den (spawn 13 is 8 m from D15), Corner Office (spawn 6), the bridges (visible from everywhere).

### 7.3 Zone
- Start radius 140, centre (0, 0) (maps.md 2.2). The floor inset by 15 m is x in [-102, 102], z in [-57, 57].
- Final-centre candidates (`zoneCenters`), all inside the inset:
  1. (7.84, 0) crossroads
  2. (-40, 0) main aisle W
  3. (56, 0) main aisle E
  4. (-36.4, -23.21) TL block (tunnel k2 centre)
  5. (52.08, -23.21) TR block (tunnel k2)
  6. (-36.4, 23.21) BL block (tunnel k2)
  7. (52.08, 23.21) BR block (tunnel k2; the Phase A point x 58 was in the 0.4 m leg-panel crack between k2 and k3)
  8. (7.84, -40) VA north
  9. (7.84, 40) VA south
- Every candidate is on floor reachable from the crossroads (level test).
- Every final circle lands on a desk block or an aisle junction, so the endgame is vertical (deck vs tunnel vs aisle) and never
  inside a one-door room.

## 8. POIs (ids and names from narrative)
| id | name | centre (x, z) | radius |
|---|---|---|---|
| `office_meeting` | Fishbowl Room | (-64.5, -59.2) | 22 |
| `office_phone` | Shush Booth | (-28.6, -62) | 14 |
| `office_corner` | Corner Office | (35.7, -59.2) | 16 |
| `office_blue` | Blue Room | (67.6, -59.2) | 17 |
| `office_yellow` | Yellow Room | (100.6, -44.4) | 27 |
| `office_pantry` | Pantry & Loos | (-102.5, -29) | 32 |
| `office_admin` | Paper Jam Corner | (-102.5, 30) | 16 |
| `office_entrance` | Welcome Mat | (-88.5, 59.2) | 28 |
| `office_gym` | Jam & Gym Room | (-19.8, 59.2) | 40 |
| `office_games` | Ping Pong Den | (68.7, 59.2) | 48 |
| `office_tea` | Kettle Corner | (-61.68, -19.8) | 10 |
| `office_sales` | Sales Row | (52.08, -23.2) | 34 |
| `office_design` | Design Bay | (-23.76, 23.2) | 22 |
| `office_project` | Deadline Corner | (-55.4, 23.2) | 14 |
| `office_eng` | Engineering Pit | (58.4, 23.2) | 40 |

Unnamed areas: the TL block (hot desks), the lounge (notice board), the crossroads, the bridges and the corridors.
Narrative may add ids such as `office_hotdesks` or `office_crossroads` if the minimap needs labels there.

## 9. Pacing (12 players, about 7-8 min, island schedule)
| Time | What happens |
|---|---|
| 0:00-0:30 | Drop (3.1 s). Commons in the corridor ring and tunnels. Rooms give rares |
| 0:30-2:00 | Climbs to the decks. Hot fights at the Den table, the Corner Office desk and the bridges. P1 (95 m) cuts the west column (Pantry & Loos, Paper Jam, lobby) and the Yellow Room's far end |
| 2:00-5:20 | Deck-to-deck and aisle fights (P2 70 m, P3 50 m). Perch snipers. Tunnel flanks |
| 5:20+ | The circle sits on one block or junction (30 / 15 / 5 m). Plateau vs tunnel, grenades decide |

## 10. Privacy and IP
- No real names: desks are identified by block, row and column only. There are no nameplates, and the renamed room is the
  Corner Office.
- No company name, title, sign or logo. The exit sign is a pictogram. The plan's cartoon is not used.
- Department colours are only neutral flavour (Sales Row, Design Bay, Engineering Pit, Deadline Corner).
- The reference images stay in the repo root. Nothing is copied to `public/` or `src/`.

## 11. Open issues

### For the tech-lead (MapData `kind: 'indoor'`)
- **T1 Shape** (proposal):
  ```
  {
    kind: 'indoor', id: 'office', nameKey,
    floor: { minX, maxX, minZ, maxZ },
    ceilingHeight: 27,
    walls: { x1, z1, x2, z2, thickness, height, material: 'solid' | 'glass' }[],
    doors: { x, z, rotY, gap: 9.18 }[],            // frames, wall runs already split at gaps
    floorZones: { minX, maxX, minZ, maxZ, material: 'wood' | 'carpet' | 'tile' }[],   // default wood
    props: { kind, x, z, rotY, scale, y? }[],
    climbRoutes: { id, plateau, mode: 'walk' | 'jump', waypoints: Vec3[] }[],
    playerSpawns: (Vec2 & { set: 'A' | 'B' })[],
    lootSpawns: (Vec3 & { tier })[],
    zoneCenters: Vec2[],
    pois: { id, nameKey, x, z, radius }[],
  }
  ```
- **T2** Props need an optional base `y`: desk-top clutter, stacked `bookStack`, perches. `propBaseY()` should return
  `p.y ?? 0` indoors.
- **T3** Loot spawns need `y`, because a desk top and the tunnel under it share the same (x, z).
- **T4** `PropKind` must take the 34 office kinds. `PROP_SHAPES` comes from `getOfficePropInfo(kind).colliders`. The kit's `ramp`
  shape is not a vertical prism, so compile it to 20 flat steps (maps.md) or add a ramp collider.
- **T5** Multi-part colliders:
  - desk / deskWood: top + 2 leg panels + beam.
  - chair: base, pole, seat, back, 2 arms. The arms could be soft.
  - monitor / monitorDual: raised screen + pole.
  - laptop: base + lid.
  - pingPongTable: top, net, 2 leg panels.
  - foosballTable: raised cabinet + 4 legs.
  - pantryCounter: counter, machine, faucet.
  - pottedPlant: pot + leaves.
  - doorFrame: 2 jambs + lintel.
  - bookStairs: 7 steps.
  - whiteboardRamp: 20 steps.
  - Everything else is single-part.
- **T6** The collider grid is sized from `worldRadius`, and colliders are inserted by bounding circle. A 68 m wall would land in
  dozens of cells. For indoor maps: size the grid from the floor rect, and split walls into <= 10.8 m modules or insert by OBB.
- **T7** `heightAt` / `raycastTerrain` indoors is the plane y = 0, and nothing is ever 'water'. The ceiling at 27 m clamps shots
  and grenades (maps.md 2.5).
- **T8** About 1,250-1,400 collider parts (island about 600). The nav grid is about 33.7k floor cells plus about 5k plateau cells
  at 1 m.
- **T9** Spawn sets A/B, or the farthest-point rule in 7.1.
- **T10** Stacked bookStacks in one cell may merge into one collider (section 4.3).

### For other agents
- **T11 game-designer**: maps.md 2.4 says "monitors are full cover for a standing chibi". Per the director's ruling, monitors stay
  canopies (screen 1.4-4.37 m above the desk; a 1.3 m chibi stands under it). Please correct that line. Plateau cover is plush,
  boxes and laptops (section 5.3).
- **T12 (resolved)**: the net model stays 1.35 m; the kit collider is 1.6 m (`OFFICE_PING_PONG_NET_WALL`), so it can never be
  hopped. QA: 50 sprint-jumps at the net never cross it.
- **T15 (resolved)**: `bookStairs` step 7 is 0.735 m real (6.615 world), so every step rises 0.945 m.
- **T13 graphics-engineer**:
  - The office prop layer will exceed the island's prop draw-call line (about 30 kinds x body + hull, about 70-80 calls) while
    staying under the 250 total.
  - Light panels hang at 20.8-21.6 m, below the 25 m drop start. Players drop through them (visual only).
  - Walls near the camera should fade.
- **T14 graphics-designer (optional)**: the extra kinds listed in section 6. The `pottedPlant` leaves top (7.92 m) is walkable
  and harmless.

## 12. QA checklist
- Every route in 4.3, human and bot:
  - Start to end with no stall.
  - CO-A side entry.
  - Ramps walkable at sprint.
  - Perch steps (0.95).
  - The 17b jump test on the book stairs.
- Plateau gaps: no near-miss jumps (section 4.1 list). Try sprint-jumping off desk ends toward the cabinets, guitar stands and
  plants.
- Stuck spots:
  - leg-panel cracks (0.4 m)
  - chair-to-glass slivers
  - the Shush slot
  - boxSmall/bookStack pairs in tunnels
  - book tower cell i1
  - between bookStairs and walls (CO-A 0.07 m flush)
  - pods to Fishbowl glass (0.03 m flush)
- Doorways: all 16 are 8.1 m clear, and the lintels block nothing at walking height.
- Drop:
  - From each of the 24 spawns, you cannot reach any open-plan epic before landing (more than 30 m).
  - You cannot steer through any wall or lintel.
  - Spawns 3, 7, 8, 14 and 20 land inside their rooms.
- Spawn camping: from the NE perch, can you shoot spawns 5-6 in the N corridor (about 39 m)? From the decks, aisle spawns 19-24?
  Report anything oppressive.
- Fall: walk off the perch (expect about 15 HP), off the filing cabinets (5.8 HP), off the desks (0).
- Low cover: in every block, a crouched player behind a `boxSmall` is not hittable from a standing floor shooter at 15 m.
- Loot: none inside colliders. Desk-top loot sits on the top, not inside the slab.

## 13. Top-down map (approximate: 1 char = 3 m in x, 1 row = 4.5 m in z, north up)
Legend:
- `#` solid wall. `:` glass wall. `D` doorway.
- `=` desk plateau (6.66). `w` bridge desk. `K` Kettle Corner. `^` perch (10.46). `E` epic.
- `R` whiteboard ramp. `S` book stairs. `U` book tower.
- `P` phone pod. `T` ping pong table (`|` net). `F` foosball. `n` pinboard. `v` vanity / counter. `f` filing cabinets.
  `p` printer. `b` aisle cover cluster. `x` extinguisher.
- `s` player spawn. `+` crossroads. `%` closed front door.

```
x: -117      -88    -68  -60  -41        -5      20        51        84   96  117
###############################################################################
####    vv# FISHBOWL ROOM:PPP  PPP    nnnn    : CORNER  # BLUE ROOM#  YELLOW  #
####    vv#  ==========  :PPP  PPP   LOUNGE   :   ===== #  ======  D    S     #
####    vv#  ========== s:               s    :SSS=E=E= #s ======  D    S   s #
####    vv#  ==========  :                    D   UUUU  #  ======  #    S     #
#         #              :                    D         #          #  ======  #
####DDD####:DDD::::::DDD::  x                 :::::::DDD:::::::DDD::  ======  #
# PANTRY  D   s        s        s    S               s         S   D  ======  #
#   s     D     N CORRIDOR           S                         S   D   RRRR   #
#     === #                          S                         S   #   RRRR   #
#     === D SSSS======================        =================^^E^#   RRRR   #
#         D     === HOT DESK ROW =====        ==== SALES ROW ======#          #
#         D     KKKKK=================wwwwEwww=====================#          #
###########x                                                       ::::::DDD::#
####      #      RRRR                          S               RRRR           #
#### LOOS D      RRRR                   b      S      b        RRRR           #
#         D  s MAIN AISLE s     s        +        s        s              s   #
#         D           b           RRRR         S                   RRRR b     #
#  vvvvvvv#                       RRRR         S                   RRRR       #
###########                       RRRR         S                   RRRR       #
#ff             ^^E^^=================wwwwEwww==========================      #
#ff             =DEADLINE|DESIGN BAY==        ===== ENGINEERING PIT ====    s #
#ff         SSSS======================        ==========================SSSS  #
#    s           S                                                            #
#                S             S CORRIDOR                                     #
#pp              S        s       s               s         s        s        #
########## x       #:::DDD:::::::::::::DDD::x:#:DDD:::::::::::::::::::::::DDD:#
# =====            #                          #  PING PONG DEN                #
# =====            #   JAM & GYM ROOM         #       TTTT|TTTT       FFFF    #
#     s            #       =====              #   SSSSTTET|TETTSSSS   FFFF    #
#                  #       =====s             #       TTTT|TTTT               #
#                  #                          #                               #
#############%%%###############################################################
```

Notes:
- The lobby (Welcome Mat) is the bottom-left room. Paper Jam Corner (`f`, `p`) opens east onto the W corridor.
- The two loo cubicle blocks are the solid `###` runs at the west edge of rows 1-4 and 14-15.
- The coordinates in sections 2-7 are authoritative. This sketch is only for orientation.

## 14. Build notes (Phase C, `src/game/levels/office.ts`)
What the data does where Phase A was silent or had to change:
- **Generated, not typed:** desk blocks, chairs (seeded jitter), monitors, keyboards, laptops, under-desk cover, wall runs split at
  the doorway list (`OFFICE_DOORWAYS`, a 9.18 m gap per doorFrame), climb-route waypoints (section 4.2), book towers and the zone
  block centres. Sizes come from the kit (desk top, pong top, stack height, door gap).
- **Aisle cover K1-K4:** a `box` at the listed centre, two `boxSmall` flush against it (east and west sides for K1-K3; north and
  south for K4, which sits next to ramp BR-B), and a stray chair at offset (7, -7), (0, 7.5), (-7, 7) and (8, 3). The K3 chair sits
  west of its box so the zone centre (56, 0) and spawn 24 stay clear.
- **Room chairs:** one per room-table desk on the long side, pulled in to keep 0.48 m from the wall (they tuck under the slab), plus
  2 end chairs in the Fishbowl (west end) and the Blue Room (east end). The Fishbowl has 6 chairs, not 8 (8 would overlap).
  Pantry table chairs sit at its two ends. Lounge, Den, Gym, Paper Jam and the delivery pile follow section 2.4 with the boxes
  placed flush in pairs.
- **Desk-top clutter:** seeded, 1-3 items per block desk (none on K and P), kept 1 m from desk-top loot and 1.5 m from route
  landings, never under a monitor.
- **Loot and spawns** are nudged as described in 7.1 and 7.2; the level test bounds every nudge to 3 m.
- **Ceiling:** light panels from the section 6 rows plus room grids, skipping any that cross a wall; 14 AC cassettes.
- **Level tests** (`office.test.ts`): `validateIndoorMap`, counts, POI ids and strings, doorway gaps and two-sided passage, climb
  rises (waypoints and physical kit tops), ramp waypoints per compiled step, spawn and loot clearance, reachability of every loot spot,
  spawn, zone centre and route start (floor flood plus plateau floods through the routes), the deliberate-gap list (5.3), and a
  real-name blocklist over the map data, `en.json` and this document.

