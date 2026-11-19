# M2c art spec: "Fresh Every Match & Bigger Arsenal"

Owner: `graphics-designer`. Status: **built (A1, 2026-11-18)**: models in `src/render/procedural/`, pure kit data in
`src/shared/kits/`, tests in `src/render/procedural/m2c.test.ts`. Built numbers (triangles, sizes) are in
`docs/art/ASSET_LIST.md` "M2c"; where they differ from the first spec below, the built value wins and is noted. The art bible is `docs/art/STYLE.md`; this file adds the M2c parts, and STYLE.md §2 / §22 point
here. Item names, level names and look-preset names come from `docs/narrative/M2c.md` (narrative-designer). Hex values
are sRGB.

All rules from STYLE.md still apply: one shared `vertexColorToon()` material, the 3-step toon ramp, plum ink hulls, no
textures, no pure black, no gore, original shapes only. Office privacy rule: nothing in this file comes from the
reference photo or the seat-plan cartoon (no names, logos, likenesses or signage).

---

## 1. Item levels: one colour scale everywhere

### 1.1 The scale ("heat ladder")
The narrative names run cool to hot (Breezy, Warm, Hot, Scorcher). The colours follow the same idea and borrow the
order of the sun-safety UV-index chart (yellow, orange, then violet for "extreme"). That chart is a public-health
convention, not a game's rarity set. The lightness is spread out too, so the levels differ in brightness as well as hue.

| Level | Name (narrative) | Token | **Base** (world, badge fill, ring, collar) | Text on dark panel (`#1D2B4A`) | Additive glow (beam, sparkles) | Numeral / pips colour on the base |
|---|---|---|---|---|---|---|
| 1 | Breezy | `level1` / `--lv1` | **`#B8E7FF`** ice blue | `#B8E7FF` (10.6 : 1) | `#B8E7FF` | ink `#2A1D33` (12.0 : 1) |
| 2 | Warm | `level2` / `--lv2` | **`#FFF14D`** lemon | `#FFF14D` (12.0 : 1) | `#FFF14D` | ink (13.6 : 1) |
| 3 | Hot | `level3` / `--lv3` | **`#F2590D`** hot orange | `#FF7A3D` (5.4 : 1) | `#FF8048` | ink (4.7 : 1) |
| 4 | Scorcher | `level4` / `--lv4` | **`#B963E3`** UV violet | `#D08BF0` (5.8 : 1) | `#D494F2` | ink (4.5 : 1) |

These replace the ui-ux-designer's proposal in `docs/ui/M2c.md` §1.2. They meet its constraints: ink numeral ≥ 4.5 : 1
on every fill, CIE76 ΔE ≥ 30 between all pairs under all three simulations, and L4 is not the HUD accent `#FFC43D`.

**Why not the UI proposal** (`#F2EDE2`, `#2DB469`, `#8A7CFF`, `#FFB13B`)? It passes CIE76, but in CIEDE2000 (closer to
what the eye sees) its L2 green and L4 gold fall to **ΔE 10.9 under protanopia** (19.2 deuteranopia), so the best and
the second-lowest level look alike to about 1 in 12 men. Its pale, green, violet, gold order also does not follow the
narrative's heat names. The heat ladder keeps every pair at ΔE2000 ≥ 22 and follows the names. It has no two adjacent
reds or pinks: ice, lemon, orange, violet. It also splits brightness into two bands, light (L1, L2) and mid (L3, L4).
Inside each band the hues sit on opposite sides of the blue-yellow axis.

**Checks** (Machado 2009 matrices at full severity, CIELAB D65; script kept in the session scratchpad, numbers here):
| Pairwise ΔE | normal | protanopia | deuteranopia | tritanopia |
|---|---|---|---|---|
| CIE76, minimum pair | 78.7 (2-3) | 50.6 (2-3) | **32.1 (2-3)** | 36.6 (1-2) |
| CIEDE2000, minimum pair | 32.8 (1-4) | 30.8 (1-4) | **22.1 (2-3)** | 22.9 (3-4) |
Lightness L*: 89 / 94 / 58 / 57. L1-L2 and L3-L4 share a brightness band, but each pair sits on opposite ends of the
blue-yellow axis, which all three colour-vision types keep.

**Contrast against the scenery** (WCAG ratio / CIEDE2000). Every glow and collar has an **ink rim**, so the rim carries
contrast wherever the fill does not:
| Background | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| Sand light `#F7E4B5` | 1.05 / 30 | 1.07 / 16 (weakest: rim + beam carry it) | 2.69 / 37 | 2.81 / 57 |
| Grass `#7CC84F` | 1.56 / 41 | 1.75 / 23 | 1.65 / 60 | 1.72 / 84 |
| Sea shallow `#4FD8D0` | 1.32 / 19 | 1.49 / 38 | 1.94 / 58 | 2.03 / 46 |
| Office floor `#D9AE7A` | 1.55 / 36 | 1.74 / 23 | 1.66 / 24 | 1.73 / 50 |
| Office carpet `#5E6F8A` | 3.87 / 35 | 4.36 / 60 | 1.51 / 41 | 1.45 / 22 |
| Office tile `#E6EEF0` | 1.12 / 12 | 1.00 / 30 | 2.87 / 41 | 3.00 / 31 |
| HUD panel `#1D2B4A` | 10.6 | 12.0 | 4.15 (use the text variant) | 3.98 (use the text variant) |
Known overlaps, accepted: L3 is close to danger `#FF3B5C` in brightness (ΔE 21, but the hue differs). Danger always
comes with a shape (kill-marker ring, pulse), and a level always comes with a numeral or pips. Never use a level colour
for a warning.

The old loot-tier colours (`tierCommon` / `tierRare` / `tierEpic`) are retired from the ground markers (§1.3). The spot
tier now only decides the level roll (ui-ux M2c §1.3 agrees).

### 1.2 Non-colour tells (always on, never behind a setting)
| Where | Tell |
|---|---|
| HUD badge (ui-ux) | the numeral 1–4 in ink on the level fill, 2 px ink outline; L4 adds a 4-point sparkle on the corner (ui-ux M2c §1.1) |
| Armor cells (ui-ux) | 4 pips, N filled |
| Ground marker | **N pips** (diamond studs) standing on the ring, plus ring count and beam height that grow with the level (§1.3) |
| World / held model | the **level collar** with **N pip studs** (§1.4) |
| Kill feed / death card | weapon icon + badge (numeral) |

### 1.3 Ground marker (replaces the tier glow for levelled items)
Same parts and materials as the existing loot glow (`loot.ts`: disc, ring, ink rim, beam, ring2, sparkles), recoloured
and with pips added. Unlit, no shadows, `depthWrite: false`, render order 1–3 as now.
| Level | Disc (28%) + ring + ink rim | Pips on the ring | Second ring | Beam (additive, fades up) | Extra |
|---|---|---|---|---|---|
| 1 | base colour | 1 | – | – | – |
| 2 | base | 2 | – | 1.2 m | – |
| 3 | base | 3 | yes | 2.4 m | – |
| 4 | base | 4 | yes | 3.6 m | 4 orbiting sparkles (glow colour) + a slow ring pulse (scale 1 → 1.08, 1.2 s). Reduced motion: no pulse, sparkles still |
- **Pips**: diamonds (octahedra, r 0.05 m, 8 tris) evenly spaced on the outer ring and standing on it, in the numeral colour
  (ink) with the base colour as a 0.01 m rim. They turn with the item's `spin`. From standing eye height they read to
  about 10 m. Past that, the ring count and beam height do the job.
- **Non-levelled items** (ammo, heals, frag, smoke): a **supply marker**: cream `#FFF3D6` disc at 20%, a white ring and
  the ink rim, with no pips and no beam. It must not look like L1. L1 is ice blue and always has one pip.
- Office: the marker scales with the loot model (the 9x world), as now.

### 1.4 The level collar (world, held and viewmodel weapons)
- A **raised wrap band** 0.04 m long (along Z), 0.004 m proud of the surface it wraps, in the level base colour, inked by
  the weapon hull. It sits on **the same spot on every gun: the front end of the receiver, just ahead of the trigger
  hand** (melee: the top of the handle, just under the guard or throat). Players learn one place to look.
- **Pips**: N cube studs (0.012 m) in a row along Z on the **left face** (−X, which faces the camera in first person,
  because the hip pose yaws the gun toward the centre) and mirrored on the right face, in the numeral colour. Pips and
  collar stay **below the sight line** (top flush with the receiver top), so iron and red-dot pictures are unchanged.
- The collar is not the ammo band. Ammo bands are flat stripes on the barrel or handguard (STYLE §8). The collar is
  raised, has pips and sits in the fixed spot.
- Per gun (approximate, finalised in the build phase against the real geometry):
  | Gun | Collar centre z | Wraps |
  |---|---|---|
  | pistol | −0.13 | slide front |
  | smg | −0.21 | body front |
  | shotgun | −0.10 | receiver front |
  | rifle | −0.19 | receiver front (behind the sand handguard) |
  | dmr / lmg / sniper | receiver front, behind the handguard or barrel shroud | receiver |
  | dbshotgun | −0.04 | breech block, behind the hinge |
  | revolver | −0.05 | frame, just ahead of the cylinder |
  | rpg | +0.02 | the tube, right over the grip |
  | knife / machete | handle top (z −0.005 to −0.045) | handle |
  | paddle | throat (where the shaft meets the blade) | shaft |
- **Geometry**: merged into the weapon geometry per `(id, level)` (cached; at most 13 × 4 variants), so a held weapon
  stays 2 draw calls. Collar + pips cost ≤ 40 colour tris. The weapon budget (≤ 620 colour, ≤ 460 hull) includes it.
- **L4 glint** (optional, render): every 2.5 s a 4-point star sparkle pops on the collar for 200 ms (pooled particles).
  It is off with reduced motion. It is the only animated level cue on weapons.
- Remote players: `PlayerState` carries the held weapon's level, so others see the collar. At 30 m it is a 1–2 px band.
  That is fine, because the loot marker and the HUD carry the level at range.

### 1.5 Armor levels
Armor keeps its **tier silhouettes** (STYLE §14), which already code level 1–3 by shape. M2c changes each tier's
**accent** to its level colour, so the armor and weapon systems match. The main colours stay, so outfits stay readable:
| Level | Piece | Main (unchanged) | Accent, was → now |
|---|---|---|---|
| 1 | bucket hat / open vest | denim `#7FA8C8` | tan band, trims and pockets `#D9B26F` → **`#B8E7FF`** (the canvas parts stay tan; only the band, hem cord and pocket flaps turn ice) |
| 2 | vented dome / puffer | cobalt `#3A6FD8` | white stripe, collar and side stripes `#F4F7FB` → **`#FFF14D`** |
| 3 | shell / plate carrier | slate `#3D4A5C` | hibiscus pink `#FF5C8A` + mango `#FFC43D` → **`#F2590D`** (brow lip, plate rims, crest; the flower emblems turn orange with a cream centre) |
| 4 | Ship's Bell Helmet / Surfboard Vest | §6 | **`#B963E3`** |
Each vest also gets a **level badge**: a 0.07 m disc on the left chest (wearer's left, −X) with an ink rim and N pip dots
in the numeral colour (≤ 24 tris). Helmets get no badge, because the silhouette is the cue.

---

## 2. New weapons: shared rules
- **Frame** (same as guns): origin at the grip where the hand closes, barrel or blade toward **−Z**, top **+Y**.
  Children: `weapon` (+ `outline`), `muzzle` (guns), `sight` (guns: the eye point), plus the new ones listed per weapon.
  `root.userData = { weaponId, sightType, level }`.
- **Budget**: colour ≤ 620, hull ≤ 460 tris per model, collar included (same as M2a). Held: 2 draw calls.
- **Family colours** stay unique per gun. Guns that share an ammo type carry a flat band of the ammo colour (STYLE §8).
  New family colours avoid the level colours.
- **Loot scale** (side-on, spinning): knife ×2.0, machete ×1.3, paddle ×0.95, dbshotgun ×1.3, revolver ×1.8, rpg ×1.0.

### 2.1 Melee
Melee frame: the blade or paddle head runs along −Z from the hand. The blade is flat in the **YZ plane** (thin along X),
with the edge on −Y. The paddle blade is flat in the **XZ plane** (its broad face meets the target in a sideways sweep).
The child `tip` sits at the far end, and `swingTrail` marks the middle of the striking part (where the swing-trail VFX
anchors).
| Id (name) | Length | Look | Colours | Silhouette cue |
|---|---|---|---|---|
| `knife` (Shucking Knife) | 0.30 m (built): handle 0.11, round guard disc r 0.035, stubby leaf blade 0.11 × 0.04 with a rounded point | toy shucking knife: a fat bulb handle, the guard disc, a short thick blade with a white edge stripe | blade steel `#D3DCE6`, edge `#F4F8FB`, spine `#9AA6B4`; guard gun-dark `#3D3A4B`; handle coral `#FF7A5C`; cream pommel cap | the shortest item in the game, with a round guard |
| `machete` (Coconut Machete) | 0.56 m: handle 0.14, blade 0.42 widening from 0.05 to 0.085 with a squared tip | bolo blade with a dark spine stripe, cord-wrapped handle, a cream lanyard loop at the pommel | blade steel, spine `#9AA6B4`; handle palm green `#34983F` with `#4CBB4A` wrap stripes; wood rivets `#B57A48` | broad, top-heavy blade with a square end |
| `paddle` (Lifeboat Paddle) | 1.35 m (built): T-grip at +0.15 behind the hand, shaft r 0.022, leaf blade 0.48 × 0.19 | lifeboat paddle: a wooden shaft, a T-grip, and a painted blade with a teal tip band and a cream stripe | shaft plank `#D09A62` / `#B07E4C`; blade plank with a teal `#2EC4B6` tip band and a cream `#FFF4E2` stripe | the longest item; a wide flat head |
Built (L2, collar included): knife 228 + 180, machete 312 + 96, paddle 280 + 256. All levels: ASSET_LIST "M2c".

### 2.2 Guns
| Id (name) | Length | Body / family | Secondary | Ammo cue | Sight | Unique silhouette |
|---|---|---|---|---|---|---|
| `dbshotgun` (Double Scoop Shotgun) | 0.92 m | **mint** `#7FDDB8` side-by-side barrels (r 0.03 each, 0.044 apart) | gun-dark breech and hinge; **waffle-cone stock** `#D9A05B` with a `#B07A3A` diamond grid (vertex-colour checker); wood fore-end `#B9783F` | red shell band `#E94F37` round both barrels near the breech | iron: **bead** on the rib between the barrels + shallow V notch at the breech | two side-by-side **toy tips: strawberry `#FF8FB1` (left) and vanilla `#FFF3D6` (right)**, the "two scoops"; wide flat muzzle face; cone-shaped stock |
| `revolver` (Sand Dollar Revolver) | 0.34 m | **sky** `#4FB4EE` frame and hexagonal barrel with a top rib | **sand-dollar cylinder** `#F2E2C2` with a 5-petal dot pattern `#C9A273` on its rear face; walnut bird's-head grip `#8A5A34`; gun-dark hammer | green heavy band `#3E9B5A` on the barrel | iron: blade front post + notch in the top strap | fat 6-flute drum, hammer spur, curved grip |
| `rpg` (Sunburst Launcher) | 1.0 m tube (r 0.06) | **cream** `#FFF4E2` tube with **3 coral `#FF5A5F` spiral stripes** (a party-popper twist) | an 8-ray **sunburst** decal in mango `#FFC43D` on both sides; coral rims at both ends; gun-dark grip, trigger and sight frame; front grip | rocket nose visible in the muzzle (coral cone, §3) | iron: **sunburst ring** rear aperture (a ring with 8 short rays, r 0.02) + front post | the only tube; spiral stripes are a pattern cue as well as a colour cue |
Built (L2, collar included): dbshotgun 404 + 280, revolver 364 + 240, rpg 576 + 340 (sight rays carry no hull).

**Anchors** (weapon frame, metres; the eye-point rule from M2b: iron eye points 0.32–0.40 m behind the rear notch):
| Gun | `muzzle` | Extra children | `sight` eye point | Rear aperture, radius |
|---|---|---|---|---|
| dbshotgun | (0, 0.09, −0.62) (between the barrels) | `muzzleL` (−0.022, 0.09, −0.62), `muzzleR` (+0.022, 0.09, −0.62): flash from the barrel that fired (left first) | (0, 0.130, 0.30) | (0, 0.130, −0.06), 0 |
| revolver | (0, 0.075, −0.25) | `cylinder` (pivot for the reload swing-out, axis Z at (−0.0, 0.06, −0.03)) | (0, 0.122, 0.38) | (0, 0.122, −0.01), 0 |
| rpg | (0, 0.10, −0.60) | `exhaust` (0, 0.10, +0.42) back-blast; `rocketSeat` (0, 0.10, −0.52), where the loaded rocket's nose shows | (0, 0.26, 0.28) (the sight line is 0.10 m above the tube top, so the tube frames the bottom of the view without covering it) | (0, 0.26, −0.02), 0.02 (ring aperture) |
Sight types for `getWeaponSight`: dbshotgun `iron`, revolver `iron`, rpg `iron` (the ADS zoom is balance's `adsZoom`).

---

## 3. Rocket, trail and ammo pickup
- **Rocket model** `createRocketModel()`: 0.5 m long, body r 0.045, origin at the body centre, nose toward −Z. Cream
  `#FFF4E2` body with one coral `#FF5A5F` spiral stripe, coral ogive nose, 4 mango `#FFC43D` fins at the tail, gun-dark
  nozzle. Outline 0.018 m (the loot width, so it stays inked in flight). Child `nozzle` at the tail. Built: 236 + 228 tris.
  In flight: scale ×1.0, rolling about Z at 6 rad/s, with the nose along the velocity.
- **Exhaust flame**: two crossed camera-facing quads at `nozzle`, core `#FFF1A8` and edge `#FF9D2E`, additive, 0.25 m long,
  flickering (scale 0.85–1.15 at 30 Hz; held at 1.0 with reduced motion).
- **Smoke trail** (pooled particles, no extra draw call): a cream `#FFF3D6` puff with an ink-soft `#4A3A52` rim every
  0.35 m. Each puff grows r 0.08 → 0.30 m and fades over 0.7 s, drifting up 0.3 m. Every 0.7 m a yellow `#FFD23F` spark
  star pops (the "firework" nod). Cap: 32 live puffs per rocket. With reduced motion the puffs do not drift and there are
  no sparks.
- **Launch**: front flash at `muzzle` (the shotgun size, 0.5 m) + a back-blast at `exhaust` of 6 cream smoke balls in a
  0.8 m cone backwards, fading over 0.5 s.
- **`ammo_rocket` pickup** (Fireworks): **one** rocket (the only ammo with a single round, so the count also reads) lying
  diagonally on a low crate 0.36 × 0.12 × 0.16 m with coral/cream stripes and gun-dark corner caps. It uses the supply
  marker. Loot scale ×1.4. ≤ 260 + 160 tris.
- **HUD icon**: rocket silhouette pointing up-right (the ➤ slot in ui-ux M2c), coral nose and cream body.

---

## 4. Smoke: the Candyfloss Smoke Bomb and its cloud

### 4.1 The can (must not look like the frag)
| | Frag (M2a) | Smoke (M2c) |
|---|---|---|
| Silhouette | round pineapple with a leaf crown | **stubby cylinder** (d 0.11, h 0.15) with a **fluffy 3-blob candyfloss cap** |
| Colour | warm tangerine checker `#FF9F1C` / `#D97A12` | cool pastel **lilac** `#C9B6F2` body with 2 **pink** `#FFB3D1` hoops; cap `#FFD1E6` / `#F2B8F0` |
| Pin ring | hot pink `#FF3B5C` | cream `#FFF3D6` (it is not dangerous, so no danger colour) |
| Lever | gun-dark spoon | gun-dark spoon |
`createSmokeModel({ pin })` in `grenade.ts`: same frame and anchors as the frag (origin at the body centre, cap +Y,
`fuse` child at the cap top, the same `handOffset` and `flightScale` ×1.5). Outline 0.018 m. Built: 260 + 208 tris. Loot ×2.4.
In flight: the same tumble. There are no fuse sparks; instead it puffs 2 tiny pink-cream balls every 150 ms from `fuse`.
Throw-arc preview: the same cream dots, but the landing ring is lilac `#C9AEDF` (dashed, 35%) at the cloud's **final**
radius, never danger red.

### 4.2 Cloud look
A cartoon cotton-candy cloud: big round cel-shaded puffs with ink lines, pastel lilac-pink. It must read as "a solid wall
you cannot see through" from outside, at every quality preset (fairness: smoke looks the same on low and high).

**Palette**: lit `#FBEAF6`, mid `#EBCFF0`, shadow `#C9AEDF`, hull ink-soft `#4A3A52` at 0.035 m (a softer line than
props). Inside veil `#EFDDF2`. It reads on sand (ΔE 33), sky (25), sea (40), grass (54), office floor (33) and carpet
(36). It differs from the explosion smoke (cream and orange) and the death poof (white).

**Structure** (all clouds together share 3 draw calls):
1. **Core**: an opaque icosphere (detail 2, 320 tris, no hull) at **0.88 × the sim radius** `r(t)`, **unlit**, in the
   mid colour (shading baked into vertex colours, see below). This is the real occluder: anything behind or inside it is hidden. Fully opaque means no sorting and no
   blending overdraw.
2. **Puffs**: 22 instanced low-poly balls (icosahedron detail 1, 80 tris, + hull 80) per cloud on a shell between
   0.70 r and 1.02 r. Ball radius 0.28–0.42 r. Their layout is seeded by the cloud id, so every client draws the same
   shape. Puffs are flattened on the ground side (none below `ground + 0.15 r`) so the cloud sits on the floor like a
   mound instead of a sphere sunk into the sand. **Unlit**: the 3 colours above are baked into vertex colours as cel
   bands (lit on top, mid at the sides, shadow underneath), so the cloud looks the same in every look preset and on
   every quality setting.
3. **Puff hulls**: one instanced hull mesh.
Drawing the puffs `DoubleSide` keeps them visible from inside.
**Decision (Phase 2):** the smoke is unlit with shading baked into vertex colours (no scene lights, no shadow ramp), for
fairness across presets and for cost.

**Time** (pure function of `t` since `smokeDeployed`, the same `r(t)` the sim uses):
| Phase | Look |
|---|---|
| Grow (balance, about 1–2 s) | core and puffs scale with `r(t)` (ease-out). The first 0.3 s is a "pop": 6 puffs burst from the can and overshoot by 10% |
| Hold (about 15–20 s) | slow churn: each puff bobs ±0.04 r and turns, period 3–5 s. No change in coverage |
| Fade (last ~2 s) | **dithered** dissolve (4×4 Bayer, screen space): the top puffs go first, the core last, so the cloud thins from the top down and the occlusion drops in step with the sim's radius curve |
The sim radius is the truth. The visual core is always inside it (0.88 r) and the puffs stop at 1.02 r, so "hidden to
me" (render) and "hidden to bots" (sim segment vs sphere) agree within a thin rim.

**Inside the cloud** (camera within `r(t)`): a full-screen **veil** quad drawn after the world and **before the viewmodel**
(your own hands stay visible). Colour `#EFDDF2`, opacity `smoothstep(r, 0.75 r, d) × 0.96`, where `d` is the camera's
distance from the cloud centre. At the core you see 4% of the world, enough to make out your own feet and a body
pressed against you, and nothing beyond about 2 m. Add a faint lilac vignette `#C9AEDF` at 30% on the screen edges.
Scope overlays (ui) sit on top. The lens shows the veil, because ADS does not see through smoke. Name tags, hit markers
and the spectate outline follow the ui-ux M2c §6.2 rules (segment vs cloud test).

**Reduced motion**: no churn or bob, no pop overshoot, and no trailing puffs from the can in flight. Growth and fade still
follow `r(t)` (gameplay). The dither pattern is fixed in screen space, so it does not shimmer when the camera is still.

**Budget** (worst case: 8 live clouds, every one in view):
| | Per cloud | 8 clouds |
|---|---|---|
| Draw calls | 0 extra (shared instanced meshes) | **3** total (core, puffs, puff hulls) + **1** veil only while the camera is inside a cloud |
| Triangles | 320 + 22 × 160 = 3.8k | 30k |
| Overdraw | opaque and depth-tested: about 1–2 layers where puffs overlap the core; no alpha blending in the volume | the veil is 1 full-screen blended pass, only while inside |
| Shadows | none (clouds do not cast or receive) | – |
| CPU | per-instance matrices updated per frame for live clouds (≤ 176 puffs) | – |

---

## 5. Explosions and glass

### 5.1 Rocket explosion (reuses the grenade boom)
The grenade's cartoon boom (STYLE §15) fits. Reuse it, **scaled by `rocketRadius / grenadeRadius`**, plus three changes:
- **Fireworks burst**: 10 star sparks in coral `#FF5A5F`, mango `#FFC43D`, mint `#7FDDB8` and lilac `#C9B6F2` fly out
  to 0.6 × the radius and fade over 0.5 s (pooled particles). This tells a rocket blast apart from a frag at a glance and
  ties it to the Sunburst Launcher. With reduced motion: 5 sparks, no trails.
- **Direct hit** (event flag): add a white `#FFFFFF` 6-point star flash, 0.25 s, 1.2 m, at the impact point.
- **Airburst** (max range or time, nothing hit): skip the ground shock ring and dust. Show the flash, the smoke balls and
  the fireworks burst only.
- Surfaces: sand dust, a foam splash ×1.5 on water, floor-coloured dust indoors (as the grenade), and the glass shatter
  (§5.2) on glass. Camera shake 1.5× the grenade's, skipped with reduced motion.

### 5.2 Glass shatter (new; melee and rockets break office glass)
There is no shatter yet (M2b only had the `'glass'` impact chip). Build it from that chip:
- **Burst**: 16–20 shard particles: flat triangles in pane tint `#BFE6F0` with white `#F4FAFC` glints, 0.3–0.8 m in office
  world size, ink edge optional. They fall with gravity, bounce once on the floor and fade by 1.2 s. Add the existing chip
  flash ring at 2× size and 6 white sparkle stars. With reduced motion: 10 shards, no sparkle.
- **Broken pane**: the pane, its frosted band and its glare streaks disappear for that glass module. Keep the merged glass
  call at 1: add a per-vertex `paneId` attribute and a small "broken" mask (uniform array or data texture) that the
  glass, frost and glare shaders discard on. The **frame stays**, with 6–10 small jagged teeth (triangles in the pane
  tint) along the inner edge of the frame, all in one dynamic mesh (+1 call while any pane is broken).
- **Floor litter**: 10–14 flat glints (pale aqua, 0.4–0.9 m) on the floor under the opening. They stay for the rest of the
  match (pooled, cap 12 panes × 14).
- Render state only. Which panes are broken comes from the sim or event (tech-lead).

---

## 6. Level 4 armor (from the wreck)
Both pieces follow the fit rules of STYLE §14: identity attach, helmet front rim 0.08–0.11 m above the head centre so the
eyes show, vest within hip-local y 0.09–0.41. Budget: colour ≤ 360, hull ≤ 300.

**`helmet_4`, Ship's Bell Helmet**: a brass ship's bell worn on the head.
- Lathe bell: flared lip r 0.31 at +0.08 above the head centre, waist r 0.27, shoulder r 0.25 at +0.26, a domed crown to
  +0.34, and the **hanging loop** (a torus r 0.045 standing upright) on top to +0.42. The loop and the flared lip are the
  silhouette: no other helmet has a top loop or a flare.
- Colours: brass `#C98B2E` (deliberately a deep orange-brown, so it is not read as L2 lemon), highlight band `#F2C46A`
  on the shoulder, dark lip edge `#8E5F1E`, a **UV violet `#B963E3` rope band** round the waist with a short cream
  `#FFF4E2` lanyard tail hanging at the back.
- Hair: as other helmets (`setVariant({ helmet: true })`).
- Audio hook (narrative): a "ding" on helmet hits is optional for audio-designer.

**`vest_4`, Surfboard Vest**: two halves of a short surfboard taped front and back.
- Front board: rounded nose up (under the chin, top at hip-local y 0.40), 0.30 wide (x ±0.15, so it stays inside the
  torso width), 0.035 thick, with 0.03 rocker, standing 0.025 off the chest. Back board: the tail half, with a **single
  fin** 0.06 m sticking out backwards (+Z) at y 0.18. That fin is the side-view silhouette cue. The back may reach r 0.235
  (+Z only; the arms are at ±X).
- Tape: 2 shoulder straps and a waist strap in tape grey `#C9CED6` with an ink hull.
- Colours: board deck **UV violet `#B963E3`**, a cream `#FFF4E2` stringer down the middle and cream rails, 3 small wax
  dots `#FFF14D` on the front board. Level badge (§1.5) on the left chest, over the board.
- The loot model is the wearable, as M2a (vest ×1.15, helmet ×0.95).

---

## 7. First-person viewmodel (additions to STYLE §21 and the `VIEWMODEL_POSES` table)
Conventions as M2b: socket in camera space, hand targets in item space, Euler XYZ, `VIEWMODEL_FOV_DEPTH` applies. For
every gun, ADS = `pos = −sight.eye`, rot 0 (unit-tested as now). Numbers marked "≈" are framed in the build phase with
headless renders. The intent below is the spec.

### 7.1 Guns
| Item | Hip socket pos / rot (≈) | ADS | Hand R | Hand L | Notes |
|---|---|---|---|---|---|
| dbshotgun | (0.18, −0.20, −0.47) / (0.03, 0.16, −0.06) | (0, −0.130, −0.30) | grip (0.004, −0.045, 0.05) | under the fore-end (0, −0.03, −0.28) | both muzzles visible at the hip; the bead sits on the screen centre at ADS |
| revolver | (0.12, −0.13, −0.46) / (0.02, 0.07, 0) | (0, −0.122, −0.38) | grip (0.004, −0.04, 0.035) | cupping under the grip (as the pistol) | the sand-dollar pattern faces the camera on reload |
| rpg | (0.20, −0.14, −0.30) / (0.02, 0.10, −0.03), tube along the view on the right, the rear end behind the camera | (0, −0.26, −0.28) | grip (0.004, −0.05, 0.0) | front grip (0, −0.06, −0.25) | the sunburst ring frames the front post; the tube top takes about the bottom 25% of the ADS view near the camera |

**Recoil** (adds to STYLE §21.3):
| Weapon | pos z | rot x | rot z | decay ms | Notes |
|---|---|---|---|---|---|
| dbshotgun | +0.09 | 0.26 | 0.05 (sign follows the barrel: left −, right +) | 240 | the heaviest kick of the hand-held guns |
| revolver | +0.05 | 0.18 | 0.03 | 160 | the hammer drops (rot −0.4 on the hammer piece if split; otherwise skip) |
| rpg | +0.12 | 0.12 | 0.02 | 300 | the view kick is in the camera code (shake), skipped with reduced motion; back-blast VFX at `exhaust` |

**Reload** (t = 0..1 of `reloadMs`):
- dbshotgun **break-open**: 0–0.2 the barrels drop (socket rot x +0.5, the breech opens toward the camera); 0.2–0.35 two
  empty shells pop out (2 small red shell particles); 0.35–0.75 the left hand dips twice to load 2 shells; 0.75–0.85 snap
  shut (socket kick y +0.015); 0.85–1 back to hip.
- revolver **swing-out**: 0–0.2 tilt left (rot z +0.4), `cylinder` swings out to −X; 0.2–0.35 tip up (rot x −0.5), and 6
  tiny casings fall; 0.35–0.7 the left hand brings a speed-loader ring (6 cream dots) and pushes it in; 0.7–0.85 the
  cylinder snaps back; 0.85–1 back to hip.
- rpg **front load**: 0–0.2 lower the tube (socket y −0.06, rot x +0.2); 0.2–0.5 the left hand comes up from below the
  screen holding a rocket (`createRocketModel()` at ×0.9) and slides it into the muzzle; 0.5–0.7 push home (the nose
  shows at `rocketSeat`); 0.7–1 raise back to hip.

### 7.2 Melee (hold and swing)
Melee has no ADS. RMB does nothing visible (the ADS pose = the hip pose) unless the game-designer adds a guard. The
left hand stays a fist in a guard (the fists pose's left hand), except on the paddle (two hands).
| Item | Hold socket pos / rot (≈) | Hand R | Hand L | Curl R / L |
|---|---|---|---|---|
| knife | (0.17, −0.16, −0.38) / (0.35, 0.15, −0.25): blade forward and slightly up | handle (0, −0.01, 0.04) | fist guard (−0.16, −0.15, −0.42) camera space | −1.5 / −1.6 |
| machete | (0.20, −0.20, −0.42) / (0.55, 0.10, −0.35): blade up and forward, resting | handle (0, −0.01, 0.06) | fist guard | −1.5 / −1.6 |
| paddle | (0.10, −0.26, −0.50) / (0.45, 0.55, 0.85): shaft diagonal across the lower view, blade upper-left | T-grip side (0, 0, 0.10) | shaft (0, 0, −0.38) | −1.4 / −1.3 |

**Swing arcs.** Times are fractions of the designer's swing duration. **`h`** = the hit-frame fraction (the
designer's hit-frame time ÷ swing duration). Wind-up ends before `h`, and the blade crosses the screen centre exactly at
`h`, so the visual hit matches the sim's single hit test.
| Item | Wind-up (0 → 0.7h) | Strike (0.7h → h + 0.1) | Recover (→ 1) | Extra |
|---|---|---|---|---|
| knife | cock right: pos (0.26, −0.12, −0.34), rot y −0.55 | fast flat slash right → left through the centre to (−0.14, −0.15, −0.50), rot y +0.75 | back to hold, ease-out | alternate forehand / backhand on consecutive swings; a thin white `swingTrail` arc (3 quads, 120 ms) |
| machete | raise over the right shoulder: pos (0.28, 0.03, −0.30), rot x +1.3, rot z +0.4 | diagonal chop from upper right to lower left: (−0.10, −0.30, −0.50), rot x −0.6, rot z −0.5 | lift back up to hold | view kick rot x 0.012 at `h`; white trail arc |
| paddle | long wind-up to the right: pos (0.36, −0.10, −0.24), rot y −0.95, both hands follow | wide flat sweep right → left, the blade face leading: (−0.32, −0.16, −0.56), rot y +0.95 | slow return (the heaviest) | at `h`: view kick rot y −0.02 and a "smack" star at `swingTrail` if it hit; the trail arc is wider (0.5 m) |
Built as `MELEE_SWING_KEYS` + `meleeSwingPose(id, t, h, backhand)` in `viewmodel.ts` (keys: hold → wind-up at 0.7 h →
centre exactly at h → follow → hold), with `h = meleeHitFraction(weapons.<id>)` = `hitFrameMs / fireIntervalMs`
(knife 100/350, machete 200/650, paddle 350/1000). Sign convention (three.js): +rot y turns the blade LEFT, +rot x tips
it UP; the first-draft table had both signs flipped and is corrected above. The knife and machete are one-handed (the
left hand is lowered out of view); the paddle's left hand holds the shaft.
On a hit: the hit puff (STYLE §10) at the target and a 40 ms hit-stop (the socket freezes) for game feel. Hit-stop is
skipped with reduced motion. On glass: the shatter (§5.2).

### 7.3 Smoke can
The same poses as the frag (`grenade` / `grenade_cooking`). The left hand pinches the **cream** ring. There is no
fuse-spark jitter while held: the can gives a small wobble instead.

---

## 8. Third-person poses (for `characterPose.ts`, graphics-engineer)
- **Melee hold**: the gun-hold arm pose. The blade or paddle points along the arm (the frame above). Paddle: the left arm
  reaches the shaft (`armL` as the long-gun support hand).
- **Melee swing** (by phase as §7.2, applied to the arm pivots; `rotation.x > 0` swings forward):
  | Item | Wind-up | Strike end |
  |---|---|---|
  | knife | `armR` x π/2, z +0.7 (out to the right) | `armR` x π/2, z −0.6 (across the body); `body` y −0.15 |
  | machete | `armR` x 2.7 (raised), z +0.3 | `armR` x 0.9, z −0.3; `body` x −0.12 (lean in) |
  | paddle | both arms x 1.2, `body` y +0.5 (twist right) | both arms x 1.3, `body` y −0.6; the stance pivot steps forward 0.05 |
  Prone: swings use only the arms (no body twist), at half range.
- **RPG**: carried on the shoulder. Socket offset (0, +0.10, +0.05) and the arm raised to `x = π/2 + 0.15` so the tube
  sits over the shoulder. Exported as `userData.holdOffset` on the rpg model.

---

## 9. Per-match layout variety: prop kits
The level-designer owns where things go (`docs/design/levels/variety.md`, being written in parallel; it did not exist
when this spec was finished, so the kind names below are a proposal to align on). The art kit has two classes:
- **Sim props** (they collide; sim data, identical on server and client). Each gets a kit entry (origin, size, collider
  parts) as pure data, like `OFFICE_KIT`.
- **Decor** (client-only, no collider, still placed from the seed). Rule: decor must be **flat or soft**: at most 0.35 m
  tall at map scale (office: 0.35 m world), or vegetation you could walk through (grass, ferns, seaweed). Nothing hard
  and tall may be walk-through, because it would look like a wall that bullets and bodies pass through.
- **Variants without new colliders**: a `variant` index (0..n−1) on a placement picks another geometry or colourway with
  the same collider (umbrella colourways, crate dressings, rock shapes, hut roofs). Request to the tech-lead: an optional
  `variant?: number` on `PropPlacement` / `IndoorPropPlacement`, render-only, seed-derived.

### 9.0 What was built (A1) and the canonical names
The level data's names are canonical (`docs/design/levels/variety.md`, `DECOR_KINDS` in the layout grammar). Built:
- **Decor table** (`src/render/procedural/decor.ts`, data `src/shared/kits/decor.ts`), exactly these kinds, one `body`
  part each (no hull, no shadow), ≤ 0.5 m tall, ≤ 130 tris:
  | Kind | Variants | Look | Tris | Size (m) |
  |---|---|---|---|---|
  | `shellCluster` | 2 | 2 scallops + 1 conch in cream / coral-pink / peach | 92 | 0.49 × 0.10 × 0.33 |
  | `starfish` | 2 (mango, coral) | 5 flat arms on a disc | 64 | 0.30 × 0.03 × 0.31 |
  | `sandcastle` | 1 | square base, 3 towers with cones, moat ring, a coral flag | 128 | 0.80 × 0.44 × 0.80 |
  | `beachTowel` | 4 (towel blue, coral, mango/teal, lilac/white) | striped towel with a rolled pillow end | 60 | 0.96 × 0.11 × 1.78 |
  | `fernTuft` | 1 | 7 low fronds in two greens | 56 | 0.60 × 0.29 × 0.58 |
  | `flowerTuft` | 2 (hibiscus, white) | 4 leaves + 3 stemmed flowers | 116 | 0.36 × 0.41 × 0.36 |
  | `coconutPile` | 1 | 4 coconuts + a half shell | 105 | 0.45 × 0.31 × 0.38 |
  | `seaweed` | 1 | 4 flat olive ribbons | 48 | 1.09 × 0.03 × 0.58 |
  | `paperSheets` (office, 9x) | 2 (3 sheets; 2 sheets + sticky note) | fanned blank sheets with grey abstract bars (no text) | 108 / 84 | 3.39 × 0.08 × 3.21 |
- **Island variants** (`ISLAND_VARIANTS` in `src/shared/kits/island.ts`; `getPropParts(kind, variant)`): palm 2, rock 3,
  crate 3, hut 3, umbrella 4, the rest 1. Same collider; every variant stays inside the variant-0 bounds (+0.35 m).
- **Office**: the `waterCooler` kit kind (below). The other kinds in §9.1 / §9.2 are **proposals, not built**; the
  level data does not use them.

### 9.1 Island kit
Existing kinds (STYLE §7) stay: palm, rock, bush, crate, hut, dock, umbrella, boat, tikiTorch, driftwood.

**New sim props**
| Kind | Size (scale 1) | Look | Tris (colour + hull) | Suggested collider |
|---|---|---|---|---|
| `palmLean` | 6.0 m, curved trunk leaning 2.4 m, 7 fronds | the classic beach lean, over the sand toward the sea | ≤ 320 + 320 | circle r 0.35 at the base |
| `palmYoung` | 3.2 m, 6 fronds, no coconuts | short and bushy; fills gaps at eye level | ≤ 200 + 200 | circle r 0.22 |
| `rockFlat` | 2.4 × 1.6 slab, 0.55 m high | low, faceted, light top | ≤ 80 + 80 | box 2.2 × 1.4, h 0.55 (crouch cover; walkable top) |
| `rockTall` | pillar r 0.9, 2.8 m | stacked two-block stone | ≤ 100 + 100 | circle r 0.9, h 2.8 |
| `crateStack` | 2 crates stacked + 1 beside: 2 × 1 footprint, 2.0 m high | the crate model ×3, slightly rotated | ≤ 420 + 36 | box 1 × 1 h 2 + box 1 × 1 h 1 |
| `crateLong` | 2 × 1 × 1 cargo box | planks, 3 bands, rope handles | ≤ 220 + 12 | box 2 × 1 × 1 |
| `barrel` | r 0.4, 1.0 m | wooden water barrel, 2 rope hoops | ≤ 120 + 120 | circle r 0.4, h 1.0 |
| `hutOpen` | 4 × 4 roof on 4 posts, 1.0 m half-walls on 3 sides, open front +Z | beach shack: thatch roof, plank half-walls, a counter | ≤ 480 + 300 | 4 posts r 0.12 + 3 half-wall boxes h 1.0 (crouch cover, see-over) |
| `hutSmall` | 3 × 3 walls, 3.8 m, door +Z | storage shed with a single-pitch roof | ≤ 320 + 240 | box 3 × 3, h 3.8 |
| `logBarrier` | 3 m long, 0.9 m high (two stacked driftwood logs and stakes) | bleached logs, the driftwood colours | ≤ 160 + 160 | box 3 × 0.6, h 0.9 (crouch cover) |
| `surfRack` | 2.2 × 0.8, 1.6 m high | A-frame with 4 boards in the parachute stripe colours | ≤ 400 + 300 | box 2.2 × 0.8, h 1.6 |
Variants (same collider): `umbrella` v0 coral/cream, v1 towel-blue/white, v2 mango/teal, v3 lilac/white; `crate` v0
plain, v1 rope net, v2 with a tarp; `rock` v0–v2 three facet sets; `hut` v0 thatch, v1 palm-leaf roof (greener), v2 with
a hammock on the porch (decor-sized, within the hut collider); `palm` v0–v1 frond colour pairs.

**New decor** (client-only)
| Kind | Size | Look | Tris (colour + hull) |
|---|---|---|---|
| `shell` v0 scallop, v1 conch, v2 cockle | 0.15–0.3 m | pastel shells (cream, coral-pink, peach) | ≤ 40 + 0 (no hull under 0.3 m) |
| `starfish` | 0.3 m | mango or coral 5-arm star, flat | ≤ 30 + 0 |
| `pebbles` | 0.6 m cluster | 4–5 grey-violet rock bits | ≤ 50 + 0 |
| `grassTuft` | 0.5 m tall, 0.6 m wide | dune grass blades, grass-dark | ≤ 40 + 0 |
| `fern` | 0.7 m | low fronds under palms | ≤ 60 + 40 |
| `seaweed` | 1.2 m strand, flat | olive green `#6E8F3A` on wet sand only | ≤ 24 + 0 |
| `towel` v0–v3 | 1.0 × 1.8 m, flat | striped towels (towel blue, coral, mango/teal, lilac) | ≤ 12 + 4 |
| `beachBall` | r 0.25 | 6 gores in coral, mango, teal, cream | ≤ 60 + 60 |
| `sandcastle` | 0.6 m | 3 towers and a moat ring, sand-dark | ≤ 90 + 60 |
| `bucketSpade` | 0.3 m | teal bucket + coral spade | ≤ 50 + 30 |
| `flipFlops` | 0.3 m pair | coral or teal straps | ≤ 24 + 0 |
| `coconutPile` | 0.5 m | 4 coconuts | ≤ 60 + 40 |
| `ropeCoil` | 0.6 m | cream rope rings | ≤ 48 + 24 |
| `buoy` | r 0.25 (on sand or the dock) | coral and cream ring | ≤ 64 + 48 |
| `crabSmall` | 0.25 m | a static coral crab (ties to the office plush; not the same model) | ≤ 60 + 40 |
Decor caps: island ≤ 900 placements, ≤ 50k colour + 25k hull tris for the whole map. Per scatter zone, the
level-designer picks the kinds (dunes: grassTuft, shells, pebbles; groves: fern, coconutPile; shoreline: seaweed,
shells, starfish; POIs: towels, beachBall, sandcastle, bucketSpade, flipFlops, buoy, ropeCoil).

### 9.2 Office kit (all authored real-size × 9, like `OFFICE_KIT`)
Fixed: walls, rooms, doors, glass and climb routes. Desk zones pick arrangements (level-designer). Clutter scatters.

**New sim props**
| Kind | Origin | Real size → world | Look | Tris | Suggested collider |
|---|---|---|---|---|---|
| `waterCooler` (**built**) | floor | 0.32 × 1.10 × 0.32 → drawn 3.34 × 9.9 × 3.33 (taps, tray and cup tube stick out) | white cabinet with a pale-aqua water bottle on top, 2 taps (cool blue, warm coral), a paper-cup tube | ≤ 220 + 160 | box 2.9 × 8.1 + cylinder r 1.3 to 9.9 |
| `deskShort` | floor | half-length desk → 6.32 × 6.66 × 6.79 | the desk model at half width | ≤ 84 + 72 | as `desk`, half width |
| `deskDrawers` | floor | desk + a drawer pedestal under the +X end | white pedestal with 3 drawers and wood pulls | ≤ 140 + 100 | desk colliders + pedestal box 3.6 × 6.39 × 5.4 (blocks the crawl under that end) |
| `chairTipped` | floor | a desk chair lying on its back | the chair model rotated | ≤ 280 + 220 (reuses the chair parts) | 2 boxes (seat and back lying down), about 4 m high |
| `boxOpen` | surface | as `box`, flaps open, paper inside | cardboard + cream paper | ≤ 72 + 24 | as `box` |
| `boxStack` | floor | 2 boxes stacked, offset | cardboard | ≤ 96 + 24 | 2 boxes |
| `paperStackFloor` | floor | ream stack 0.105 real → 0.95 m world | cream reams with coloured wrappers | ≤ 48 + 12 | box: one jump step (like `bookStack`) |
| `plantTall` | floor | 0.35 × 1.6 real → pot r 1.6, 14.4 m tall | potted ficus-style tree, round leaf clumps | ≤ 260 + 200 | cylinder r 1.6 to 2.7 (pot); leaves soft |
| `binRecycling` | floor | 0.3 × 0.6 real → 2.7 × 5.4 | teal bin with a cream lid band and a generic arrows-free swirl icon (no real logo) | ≤ 96 + 60 | cylinder r 1.35, h 5.4 |
| `backpack` | floor | 0.27 × 0.13 × 0.18 real → 2.4 × 1.2 × 1.6 world (the level-designer's "1.2 m crouch cover") | slumped backpack, mango or teal, lying on its back | ≤ 160 + 120 | box 2.4 × 1.6, h 1.2 (crouch cover) |
| `deskLamp` | surface | 0.45 real → 4 m tall | flexible-arm lamp, white, with a warm unlit bulb part (lights up in After Hours, §10.2) | ≤ 140 + 100 (+ `glow` 24) | base cylinder + soft arm |

**New decor** (flat or soft; desk tops and floors)
| Kind | Real → world size | Look | Tris |
|---|---|---|---|
| `paperStack` | A4 stack 0.03 real → 0.27 m | cream sheets with one coloured folder | ≤ 24 + 12 |
| `paperScatter` | 2–4 loose sheets, flat | cream with grey "text" bars (no words) | ≤ 16 + 0 |
| `stickyNotes` | flat cluster | the sticky-note colours of STYLE §19.1 | ≤ 12 + 0 |
| `penCup` | 0.1 real → 0.9 m: **sim** if placed on a walkable top (it is taller than 0.35 m world) | teal cup with 3 pens | ≤ 60 + 40 |
| `plantDesk` | succulent 0.12 real → 1.1 m: **sim** for the same reason | cream pot, green rosette | ≤ 80 + 60 |
| `cableTangle` | flat on the floor | gun-dark loops | ≤ 24 + 0 |
| `snackBox` | 0.04 real → 0.36 m | coral/mango generic snack box with no brand | ≤ 24 + 12 |
| `headphones` | flat on the desk | teal over-ear pair | ≤ 60 + 0 |
Note: at the 9x scale most desk items are taller than 0.35 m world and players walk on desk tops, so they must be sim
props. Only paper, notes, cables, headphones and snack boxes qualify as decor.

**Monitor screens** (model change, all presets): split the screen face of `monitor`, `monitorDual` and `laptop` into a
`screen` part (unlit vertex colour, §10.2), so screens can glow in the dark presets. This adds no draw calls when merged
(§11).

Office decor caps: ≤ 400 placements, ≤ 20k colour + 10k hull tris.

---

## 10. Look presets (one per match, picked from the layout seed)
Ids follow narrative (`docs/narrative/M2c.md` §4). **`noon` and `day` equal the current M1 / M2b looks exactly**, so the
default and any pinned QA baseline do not change. **The shipped M1/M2b scene values stay authoritative:** the
graphics-engineer applies the other presets' art values *relative to* the shipped look (the `noon` / `day` columns below
mirror STYLE §3 / §19.4 and may lag the code; where they differ, the code wins). The values are for graphics-engineer's `SceneLook`. Suggested pick
weights (data for the level module or map data): island morning 25, noon 35, golden 25, overcast 15; office day 45,
evening 30, afterHours 25.

**Guardrails** (every preset): the fog colour equals the sky horizon; the sun colour's lowest channel is ≥ 0.6 × its
highest (so characters are not dyed); hemisphere intensity ≥ 0.85 (the toon shadow step is never near-black); fog
`far` ≥ 200 m on the island (long-range fights stay possible) and ≥ 250 m in the office; loot markers, the level collar,
smoke, the tide wall and VFX are unlit, so they look the same in every preset. Ink outlines never change.

### 10.1 Island
| Setting | `morning` (Early Dip) | `noon` (Full Sun) = shipped M1 | `golden` (Mango Hour) | `overcast` (Sulky Skies) |
|---|---|---|---|---|
| Sun colour / intensity | `#FFE6CC` / 2.0 | `#FFF1D6` / 2.4 | `#FFD2A1` / 2.0 | `#F0F2F5` / 1.1 |
| Toward-sun direction (elevation) | (0.72, 0.53, 0.45) from the east (32°) | (−0.55, 0.75, 0.35) (49°) | (−0.88, 0.36, 0.30) from the west (21°) | (−0.30, 0.86, 0.40) (60°) |
| Hemisphere sky / ground / intensity | `#CDE6FF` / `#EBD9B0` / 1.05 | `#C4E8FF` / `#E9D3A2` / 1.0 | `#B9C8F0` / `#E8C49A` / 1.0 | `#DDE5EE` / `#D9CDB4` / 1.5 |
| Sky top / horizon (= fog) | `#6FB8F2` / `#E4F2FA` | `#4FB2F0` / `#D2F1FF` | `#6F8FE0` / `#FFD7B0` | `#A9B7C6` / `#C9D3DC` |
| Sun disc | `#FFF0D8`, ×1.0 | `#FFF6DA`, ×1.0 | `#FFE1B0`, ×1.6, low on the horizon | hidden |
| Fog near / far (linear) | 50 / 240 m | 60 / 260 m | 60 / 250 m | 45 / 210 m |
| Sky clouds (the 14 toon clouds) | white, 10 | white, 14 | peach `#FFE3CF` lit / `#C9A9C8` shade, 14 | 22, `#E4E8EE` lit / `#B8C0CC` shade, lower and bigger |
| Sea shallow / deep / abyss | `#5ADCD5` / `#2284C2` / `#14609A` | `#4FD8D0` / `#1F7FBF` / `#125A96` | `#5FCFC0` / `#2A74AE` / `#1E4F86` | `#6FC9C6` / `#3A7DA8` / `#2A5F85` |
| Water glints | 80% | 100% | 120%, tinted `#FFE1B0` | 25% |
| Tiki flames | as M1 | as M1 | ×1.3 brighter (unlit scale) | ×1.15 |
| Exposure | 1.0 | 1.0 | 1.0 | 1.05 |
Golden hour keeps the sun at 21° or higher so the shadows stay inside the shadow frustum and the palms do not throw
30 m shadows across the beach.

### 10.2 Office
| Setting | `day` (Full Lights) = shipped M2b | `evening` (Overtime) | `afterHours` (Lamps Only) |
|---|---|---|---|
| Key light colour / intensity | `#F2F8FF` / 1.8 | `#FFC99A` / 1.35 | `#BFD2FF` / 0.6 |
| Toward-light direction | (−0.25, 0.9, −0.35) | (−0.85, 0.45, −0.25): low raking "sunset through the blinds", long desk shadows | (0.2, 0.95, 0.25) |
| Hemisphere sky / ground / intensity | `#EEF6FF` / `#D9AE7A` / 1.25 | `#E6E0F0` / `#D9AE7A` / 1.05 | `#8E9BC0` / `#6E5A48` / 0.9 |
| Fog colour, near / far | `#3A3F47`, 120 / 300 | `#43393F`, 115 / 290 | `#1E2230`, 100 / 260 |
| Clear colour | `#3A3F47` | `#43393F` | `#1E2230` |
| Light panels | all on (`#F4FBFF`) | all on, warm white `#FFF1DC` | **about 60% off** (`#5A6270`), chosen from the seed **by whole rows or rooms**, never as a checkerboard; the rest on |
| Monitor screens (unlit `screen` part) | as now (toon-lit) | as now | **glow**: the screen colours unlit (`#36507A` field, `#6C8FC2` window) |
| Desk lamps (`deskLamp` glow) | off (bulb `#E8E2D6`, lit by the scene) | off | **on**: bulb `#FFE3A8` unlit + a warm additive light-pool decal (r 3 m world, `#FFD9A0` at 25%) on the desk top under it |
| Under-desk darkening | ×0.75 | ×0.75 | ×0.85 (less, because the room is already dark) |
| Optional blinds stripes | – | 4–6 soft warm stripes (`#FFD9A0` at 18%) projected on the floor near the west wall (one decal mesh) | – |
After Hours readability: players must stay readable on the dark floor. The chibi colour material may get a faint
fresnel rim (`#FFFFFF` at 0.12) in this preset only (optional, graphics-engineer). Loot markers are unlit and stand out
more here, which is fine. The Sprinkler zone visuals are unchanged in every preset.

---

## 11. Draw-call and triangle budgets (worst case per map)
Budgets: office **≤ 150 draw calls** (medium), island **≤ 250 calls / ≤ 600k tris** in the busiest view (B8), and
stay **≤ 150 calls** in normal fights on medium. The worst seed must pass (tests over ≥ 200 seeds, per the brief).

### 11.1 Instancing plan
- **Island static props + decor: merge per chunk at match start** (the office's `mergeBuilder` path). Chunks are about
  56 m square: **2 calls per visible chunk** (body + hull, hulls hidden past the outline distance), whatever the number
  of kinds and variants. Per-kind instancing would cost 2 calls per kind: 10 old + 11 new sim kinds + 15 decor kinds is
  about 70 calls plus shadows, which is too many. Tiki flames stay instanced (vertex-shader flicker, 1 call). Build time
  target: ≤ 120 ms on the client, hidden in the countdown; measure and report it next to the server nav build.
- **Office**: decor and the new kit kinds join the existing per-40 m-chunk merge: **0 extra calls**. Merge every unlit
  emissive part (panel diffusers, monitor `screen` parts, lamp bulbs) into **one** unlit vertex-colour mesh per map. On/off
  per preset is baked into the vertex colours at build time, because the preset is fixed for the match. The light-pool
  decals go in one additive mesh (+1, After Hours only).
- **Loot**: the level collar is merged into the weapon geometry per `(id, level)`. Ground markers are per-level parts
  (disc, ring, pips, beam, ring2, sparkles), instanced across all loot.
- **Rockets**: all live rockets in 2 instanced meshes (body + hull). Trails and flames go in the shared particle Points.
- **Smoke**: 3 instanced meshes for all clouds, + 1 veil while inside (§4.2).
- **Glass**: 1 merged pane call (as now) with a broken mask; +1 teeth mesh while any pane is broken.

### 11.2 Worst-case tally (medium)
| Layer | Island | Office |
|---|---|---|
| Sky / terrain / water / tide wall (island) or floor / walls / ceiling / glass / frost / glow (office) | 6 | ≈ 14 |
| Static props + decor (chunks) | ≤ 24 (12 visible chunks) + ≤ 10 shadow | ≤ 40 (20 visible chunks, measured view) + shadow as now |
| Tiki flames / light-pool decals / glass teeth | 1 | 1 + 1 |
| Loot (instanced parts incl. level markers) | ≤ 44 | ≤ 44 |
| Chibis 16 × (2 + 2 held) + shadows | 64 + 16 | 48 + 12 (12 players on the office map) |
| Smoke (3 + veil) | 4 | 4 |
| Rockets (2) + grenades (2) + preview (2) + explosion decals (≤ 8) | 14 | 14 |
| Particles, markers, tracers, name tags, speed lines | 5 | 5 |
| Viewmodel (arms 4 meshes + hulls, or merged 2; + item 2) | ≤ 6 | ≤ 6 |
| **Total** | **≤ 194** (B8 ≤ 250 ✓) | **≤ 149** (≤ 150 ✓; first cut if over: decor hulls past 25 m, then clutter density) |
| Triangles in view | ≤ 450k (props + decor ≤ 150k visible, chibis ≤ 70k, smoke 30k, rest as M2a) | ≤ 300k medium (decor + new kinds ≤ 30k) |
The office row uses the M2b measured 95 calls (main aisle, 5 chibis) as its base. The extra chibis and smoke push it to
the limit, so QA should measure the 12-player final circle with 4 clouds on the office map first.

---

## 12. HUD / kill-feed icons (for ui-ux-designer; the 32 × 32 SVGs are built in `src/render/procedural/icons.ts`)
| Id | Icon shape | Fill |
|---|---|---|
| knife | short wedge blade + round guard + bulb handle, 45° | steel `#D3DCE6` blade, coral `#FF7A5C` handle |
| machete | long broad blade with a square tip, 45° | steel blade, green `#34983F` handle |
| paddle | long shaft + leaf blade, 45° | wood `#D09A62`, teal `#2EC4B6` tip band |
| dbshotgun | two parallel barrels + cone stock | mint `#7FDDB8`, waffle `#D9A05B`; two scoop dots at the muzzle (pink, cream) |
| revolver | drum + barrel + curved grip | sky `#4FB4EE`, sand-dollar `#F2E2C2` drum |
| rpg | fat tube with spiral stripes + sunburst | cream `#FFF4E2`, coral `#FF5A5F` stripes, mango burst |
| ammo_rocket | rocket ➤ pointing up-right | cream body, coral nose, mango fins |
| smoke | cylinder can + three-puff cap | lilac `#C9B6F2`, pink hoops, candyfloss cap |
| vest_4 | surfboard half with tape straps | violet `#B963E3`, cream stringer, grey tape |
| helmet_4 | bell with a top loop | brass `#C98B2E`, violet band |
Armor icon fills (ui-ux M2c open question): **keep the per-tier art** (silhouette + main colour), recolour each tier's
accent to its level colour (§1.5), and keep the 4 pips. The level badge carries the level colour on its own.

---

## 13. Originality and privacy
Every item here is an original procedural toy design. The double-barrel, revolver and launcher are generic chunky toy
shapes, not real-world models. The ice-cream, sand-dollar, party-popper and surfboard motifs are this project's own. The
UV-index colour order is a public-health convention, not a game's rarity scheme. Office additions are generic objects
with no brands, labels, text or people. `docs/art/CREDITS.md` gets an M2c entry when the models are built.

---

## 14. Scope attachments (Addendum 1)
Scopes are loot items (`scope_red_dot`, `scope_2x`, `scope_4x`, `scope_8x`) with no levels. They mount on a gun's
**rail anchor** and change its sight type. Which gun takes which scope is the game-designer's list in balance.json. Art
gives **every gun except the rpg a rail**, so any list works.

### 14.1 One scope frame, one rail anchor: eye relief lines up by construction
- **Scope frame** (every scope model): origin = the centre of the mount footprint **on the rail's top surface**, optics
  toward −Z, +Y up. Each scope exports `SCOPE_GEOMETRY[id] = { axisY, eye, rear, apertureRadius, footprint }`, all in
  this frame. `eye` already includes the eye relief.
- **Rail anchor** (every gun): an empty child **`rail`** at the top surface of the receiver, at the centre of the mount
  zone, plus `userData.railLength` (the usable length along Z). It is not a visible part. Each scope carries its own
  mount base, so a gun without a scope keeps a clean top.
- **Mounting**: `scope.position = rail.position`, no rotation, scale 1. The gun's sight becomes
  `eye = rail + scope.eye` and `rear = rail + scope.rear`. The first-person ADS rule stays `socket = −eye, rot 0`
  (`VIEWMODEL_POSES[id].ads` is computed from the mounted sight instead of stored), so every gun-scope pair lines up with
  no hand-tuned numbers. The hip pose does not change with the scope.
- **Defaults are scopes too**: the rifle and lmg red dot, the dmr 4x and the sniper 8x are now drawn as the
  `scope_*` model on the rail. With the numbers below, the defaults rebuild **exactly** the M2a/M2b eye points (rifle
  (0, 0.165, 0.272), lmg (0, 0.185, 0.262), dmr (0, 0.172, 0.18), sniper (0, 0.178, 0.26)), so nothing moves and the
  existing ADS tests keep passing. If the player removes a mounted scope, the gun's default sight comes back.
- **Iron sights fold away**: on iron-sight guns the front post and rear notch are a separate piece group (`ironSights`),
  dropped from the merged geometry while an optic is mounted, so no post pokes into the lens picture.
- **Geometry**: the merged weapon geometry is cached per `(id, level, sight)`, so a held gun stays 2 draw calls (+1 lens
  for the red dot, as now). Remote players draw the scope from the held gun's sight in `PlayerState`. Ground guns draw
  their carried scope.
- **Budget**: gun + the heaviest compatible scope + collar ≤ **680 colour / 500 hull** tris. A unit test runs over every
  compatible pair, as `m2a.test.ts` does for guns today.

### 14.2 Rail anchors per gun (weapon frame, metres)
| Gun | `rail` (x, y top, z centre) | railLength | Notes |
|---|---|---|---|
| pistol | (0, 0.095, −0.04) | 0.10 | slide top; red dot only fits (footprint) |
| revolver | (0, 0.105, −0.08) | 0.10 | top strap ahead of the hammer |
| smg | (0, 0.11, −0.06) | 0.16 | body top |
| shotgun | (0, 0.115, −0.02) | 0.16 | receiver top |
| dbshotgun | (0, 0.115, −0.10) | 0.12 | the rib over the breech, ahead of the hinge |
| rifle | (0, 0.115, −0.06) | 0.24 | = the M2a red-dot spot |
| lmg | (0, 0.135, −0.07) | 0.24 | = the M2a red-dot spot |
| dmr | (0, 0.115, −0.06) | 0.26 | = the M2a 4x spot |
| sniper | (0, 0.110, −0.07) | 0.30 | = the M2a 8x spot |
| rpg, melee | none | – | |
A scope's **mount footprint** (the span of its mount bases along Z) must fit inside `railLength`. Footprints: red dot
0.07, 2x 0.09, 4x 0.17, 8x 0.23 m. So the 4x fits rails ≥ 0.17 (rifle, lmg, dmr, sniper) and the 8x the same four
guns. Tubes may overhang the rail front and back, as they do today. Tell the game-designer if a list breaks this; the
art test asserts it.

### 14.3 The four scopes
Each scope has its **own accent colour**, which is the same on any gun, on the ground, on the icon and on the overlay
rim, so players learn "coral lip = 2x" once. The red dot's band changes from the gun family colour (M2a) to cream; it is
the only visible change to existing guns.
| Id | Silhouette (the main cue) | Size (frame) | axisY | `eye` (z) / rear z / aperture r | Accent | Tris (colour + hull) |
|---|---|---|---|---|---|---|
| `scope_red_dot` | **open ring hood** on a low block (the M2a red dot) | block 0.05 × 0.026 × 0.07, hood r 0.033 × 0.065 | 0.050 | **0.3325** / 0.0325 / 0.03 | cream `#FFF3D6` front band; red `#FF3B5C` dot inside an ink ring; see-through `lens` part | ≤ 80 + 50 (+ lens 40) |
| `scope_2x` | **boxy prism sight**: a square-sectioned housing with a round objective on the front and a squared eyepiece hood; one top turret. No tube | housing 0.05 × 0.05 × 0.09; objective r 0.026; total length 0.12 | 0.052 | **0.18** / 0.06 / 0.022 | coral `#FF7A5C` objective lip and turret | ≤ 140 + 100 |
| `scope_4x` | **medium tube** with an objective bell (the M2a dmr scope) | tube 0.22 × r 0.03, bell r 0.044 × 0.06, eyepiece r 0.038 × 0.05; mounts at z ±0.07 | 0.057 | **0.24** / 0.16 / 0.03 | cornflower `#5B8DEF` lips and turrets (unchanged) | ≤ 200 + 150 |
| `scope_8x` | **long tube** with a big bell (the M2a sniper scope) | tube 0.38 × r 0.033, bell r 0.056 × 0.10, eyepiece r 0.044 × 0.07; mounts at z ±0.10 | 0.068 | **0.33** / 0.25 / 0.036 | bubblegum `#FF6FA8` lips, band and turrets (unchanged) | ≤ 240 + 180 |
Glass discs stay opaque flat `#9FE8F0` (except the red-dot lens). Scope glints for other players (M2a markers) come
from the **sight type** (4x and 8x), not the weapon id, so a 4x rifle glints too.

### 14.4 Scopes as pickups
The scope model alone, side-on, hovering and spinning like guns, with the **supply marker** (no levels, §1.3). Loot
scale: red dot ×2.2, 2x ×2.0, 4x ×1.6, 8x ×1.3, so all four read at a similar size, while the silhouette (ring, box,
short tube, long tube) and the accent tell them apart without colour. A spare in the attachment stash uses the icon
(§14.6) in the HUD.

### 14.5 2x overlay (first person, next to STYLE §17)
The 2x is a "friendly" low-power optic: a wider lens and a lighter frame than the 4x/8x, so it reads as "a bit zoomed",
not "sniping".
- Lens radius **46vmin** (4x/8x: 42vmin). Outside the lens: `#140E1A` at **88%** (4x/8x: 100%), so a hint of the world
  shows round the edge.
  CSS: `background: radial-gradient(circle at 50% 50%, transparent 0 45.6vmin, #2A1D33 45.6vmin 46.6vmin, rgba(20,14,26,0.88) 46.6vmin);`
- Rim: the 1.0vmin ink ring, then a 0.5vmin **coral `#FF7A5C`** inner ring, then a soft inner shadow from 92% to 100% of
  the radius (`#140E1A` 0 → 35%). The 4x/8x rims now use the scope accent too: they are the same colours as before.
- Scope-in: the same 120 ms iris (34 → 46vmin). Scope-out: 80 ms fade.
- Reticle: **"sunrise ring"**, an open ring around the aim point, a centre dot, and three short posts (left, right,
  bottom) that stop short of the ring. Same `viewBox="-100 -100 200 200"` convention, sized to the lens diameter (92vmin).
```svg
<svg viewBox="-100 -100 200 200" style="width:92vmin;height:92vmin">
  <style>path, circle { vector-effect: non-scaling-stroke; }</style>
  <g fill="none" stroke-linecap="round">
    <g stroke="#2A1D33" stroke-width="7"><path d="M-100 0 H-34 M34 0 H100 M0 100 V34"/></g>
    <g stroke="#3D3A4B" stroke-width="4"><path d="M-100 0 H-34 M34 0 H100 M0 100 V34"/></g>
    <circle r="14" stroke="#2A1D33" stroke-width="5"/>
    <circle r="14" stroke="#FF7A5C" stroke-width="2.6"/>
  </g>
  <circle r="2.2" fill="#FF3B5C" stroke="#2A1D33" stroke-width="1.2"/>
</svg>
```
The red-dot sight keeps the M2b behaviour: no overlay, the dot on the viewmodel lens.

### 14.6 Icons (32 × 32, 2 px ink outline, flat fills, one top highlight; STYLE §18 rules)
Shape is the primary code (ring, box, short tube, long tube). The same shapes as the 3D models, side view, pointing left.
```svg
<!-- scope_red_dot: open ring hood on a block, red dot -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <rect x="8" y="22" width="16" height="5" rx="1.2" fill="#3D3A4B"/>
  <circle cx="16" cy="14" r="8.5" fill="#9FE8F0" fill-opacity="0.55"/>
  <circle cx="16" cy="14" r="8.5" fill="none" stroke-width="2"/>
</g>
<circle cx="16" cy="14" r="8.5" fill="none" stroke="#3D3A4B" stroke-width="3"/>
<path d="M10.5 7.5 A8.5 8.5 0 0 1 21.5 7.5" stroke="#FFF3D6" stroke-width="2" fill="none"/>
<circle cx="16" cy="14" r="2.4" fill="#FF3B5C" stroke="#2A1D33" stroke-width="1"/></svg>

<!-- scope_2x: boxy prism housing, coral lip and turret -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <rect x="13.5" y="7" width="5" height="4" rx="1" fill="#FF7A5C"/>
  <rect x="9" y="10.5" width="16" height="11" rx="1.5" fill="#3D3A4B"/>
  <rect x="3" y="11.5" width="6.5" height="9" rx="2" fill="#FF7A5C"/>
  <rect x="25" y="12" width="4" height="8" rx="1" fill="#3D3A4B"/>
  <rect x="11" y="21.5" width="12" height="4.5" rx="1" fill="#3D3A4B"/>
</g><path d="M11 13 H21" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/></svg>

<!-- scope_4x: medium tube, cornflower lips -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <rect x="13" y="8.5" width="4" height="4" rx="1" fill="#5B8DEF"/>
  <path d="M3 10 L9 12.5 H23 L27 11.5 V20.5 L23 19.5 H9 L3 22 Z" fill="#3D3A4B"/>
  <rect x="1.5" y="9.5" width="3" height="13" rx="1" fill="#5B8DEF"/>
  <rect x="26.5" y="11" width="3" height="10" rx="1" fill="#5B8DEF"/>
  <path d="M10 19.5 V24 H13 V19.5 M19 19.5 V24 H22 V19.5" fill="#3D3A4B"/>
</g><path d="M9 14.5 H22" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/></svg>

<!-- scope_8x: long tube, big bell, pink lips -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <rect x="14" y="9.5" width="4" height="3.5" rx="1" fill="#FF6FA8"/>
  <path d="M2.5 8 L8 13 H25 L29 12 V20 L25 19 H8 L2.5 24 Z" fill="#3D3A4B"/>
  <rect x="1" y="7.5" width="3" height="17" rx="1" fill="#FF6FA8"/>
  <rect x="28" y="11.5" width="2.5" height="9" rx="1" fill="#FF6FA8"/>
  <path d="M9.5 19 V23.5 H12.5 V19 M20.5 19 V23.5 H23.5 V19" fill="#3D3A4B"/>
</g><path d="M8 15 H24" stroke="#FFF3D6" stroke-opacity="0.6" stroke-width="1.5"/>
<path d="M17 19 V22" stroke="#FF6FA8" stroke-width="2"/></svg>
```
HUD clip-path fallbacks (`src/ui/icons.ts` style): red dot = circle, 2x = rounded square, 4x = short capsule, 8x = long
capsule with a wide left end. Colour = the scope accent. A mounted scope can show as a tiny icon on the gun slot, next to
the level badge (ui-ux's call).

### 14.7 Draw calls
No change per held gun (the scope is merged). Loot: up to 4 more instanced parts on the ground (one per scope model) +
the red-dot lens: ≤ +5 calls in the worst view. That fits inside the §11 loot line (≤ 44).

---

## 15. A model per item level (Addendum 2)
Every levelled weapon (pistol, smg, shotgun, rifle, lmg, dmr, sniper, revolver, dbshotgun, rpg, knife, machete, paddle)
has four distinct models, in third person, first person and as ground loot. The level collar with N pips, the level
tint on the collar and the ground marker stay. Shape is an extra cue on top of them, never the only one. Icons stay one
per weapon.

### 15.1 The per-level design rule (one rule, applied to all 13)
| Level | Name | Idea | What changes (from the shared parts) | Silhouette cue |
|---|---|---|---|---|
| 1 | Breezy | **makeshift / worn** | family colour dulled 38% toward driftwood `#A8957C`; 2 tape wraps (grey `#C9CED6` / `#A9AEB8`, a little crooked) on the body and grip; a frayed cord loop `#D9C49A` hanging from the stock end or pommel | the cord loop and lumpy tape |
| 2 | Warm | **clean standard** | the M2b model as authored (no extras) | the familiar shape |
| 3 | Hot | **upgraded parts** | + a muzzle device (dark cylinder with two port slots) just behind the toy tip; + a ribbed rubber grip wrap `#2E2B3A`. Melee: a bigger guard disc (knife), a round knuckle guard (machete), a metal tip cap (paddle) | thicker muzzle / guard |
| 4 | Scorcher | **sleek, extra parts** | L3 + a swept chrome fin `#E9EEF5` under the fore-end (melee: a raised spine or centre rib); chrome side trims; a mango star badge on the left face; family colour 12% brighter | the fin and the chrome |
Rules every level keeps (unit-tested in `m2c.test.ts`): identical `muzzle`, `sight` eye, `rail`, `collar`, melee `tip` /
`swingTrail` and the other anchors, so ADS, muzzle flash, hand poses and balance never change. The length along Z stays
within ±10% (built: at most +3.5%, from the L1 cord loop). Every extra stays below the iron-sight line and clear of the
rail's mount footprints. The cream toy tip stays visible at every level.

### 15.2 How it is built
- `createWeaponModel(id, { level, scope })` / `getWeaponGeometry(id, { level, scope })` (`weapons.ts`): shared design
  pieces + `levelDressPieces(dress, level)` + `collarPieces(collar, level)` (`levelCollar.ts`) + the mounted scope,
  merged into ONE geometry per `(id, level, scope)` and cached. Each weapon declares its dressing anchors (`LevelDress`).
- No `level` → the M2b look with no collar (backward compatible; every existing caller is unchanged).
- Viewmodel: `createViewmodelItem(id, { level, scope })`, `applyViewmodelPose(rig, id, ads, { level, scope })`.
- Loot: `createLootModel(item, tier, { level, scope, marker })`, `createLootMarker(level | 'supply')`.

### 15.3 Triangles (colour + hull; L2 includes the collar)
Worst level model + its heaviest compatible scope: ≤ 860 colour / ≤ 520 hull (tested). Measured worst: lmg L4 + 4x
840 + 472, sniper L4 (8x) 780 + 496, dmr L4 (4x) 684 + 424. Full table: ASSET_LIST "M2c". Per level the extras cost
about: L1 +96..164, L3 +104, L4 +148..212.

### 15.4 Draw calls and batching (for the graphics-engineer)
- **Held (3P and FP):** still 2 calls per held item (merged colour + hull), +1 for the red-dot lens. Geometry is cached
  per `(id, level, scope)`, so keep one cached Object3D per key per view (as `PlayerViews.setHeld` does per id today) and
  switch it on `weaponLevel` / `sight` changes. No new materials: everything uses `vertexColorToon()` and the shared
  `OUTLINE.small` hull (`viewmodelOutlineMaterial()` in first person).
- **Ground loot:** today `LootLayer` makes one InstancedMesh per distinct (geometry, material), so every visible
  `(id, level, scope)` combination costs 2 calls. With 13 weapons × 4 levels (+ scopes) on the ground that can reach
  40–60 calls in a loot-dense view. Recommended: draw every loot item mesh in ONE `THREE.BatchedMesh` (three 0.187 has
  it) for colour + ONE for hulls (the hull shader needs `batchId` support, as it has `instanceMatrix` today). That is
  2 calls for all loot items whatever the mix. Fallback: per-key InstancedMesh with a cap, LRU by distance. The markers
  stay instanced per level part (disc, ring, pips, beam, ring2, sparkles: ≤ 4 × 6 + supply 3).
- **Memory:** about 13 × 5 × (1–3 scopes) geometries at most, built lazily (each 0.2–0.9k tris); only combinations that
  appear are built.
- **Measure** (LV13b): loot spots populated with a mix of all levels 1–4 and scopes, office worst seed ≤ 150 calls.

## 16. Build summary (A1) for other owners
| Area | Files | API |
|---|---|---|
| Levels | `levelCollar.ts` | `LEVEL_COLORS`, `LEVEL_TEXT_COLORS`, `LEVEL_GLOW_COLORS`, `LEVEL_NUMERAL_COLOR`, `SUPPLY_MARKER_COLOR`, `clampLevel`, `collarPieces`, `levelDressPieces`, `levelTone` |
| Weapons | `weapons.ts`, `melee.ts` | `getWeaponAnchors(id, {level, scope})` (pure data: muzzle(s), sight eye/rear, rail, collar, grip, support hand, extras, hold offset), `createWeaponModel(id, {level, scope})`, `getWeaponGeometry`, `getWeaponSight(id, {scope})`, `getWeaponRail`, `weaponAcceptsScope`, `LEVELLED_WEAPON_IDS`, `WEAPON_SIGHT_TYPES`; anchors `muzzle`, `muzzleL/R`, `sight`, `rail`, `collar`, `tip`, `swingTrail`, `exhaust`, `rocketSeat`, `cylinder`; `userData.holdOffset` (rpg) |
| Scopes | `scopes.ts` | `SCOPE_GEOMETRY`, `createScopeModel`, `getScopeGeometry`, `scopeFitsRail`, `mountedScopePieces`, `SCOPE_FOR_SIGHT` |
| Rocket | `rocket.ts` | `createRocketModel`, `getRocketGeometry`, `ROCKET_DIMENSIONS`, `ammoRocketPieces` |
| Smoke | `smokeCan.ts` | `createSmokeModel({pin})`, `getSmokeCanGeometry`, `SMOKE_CAN_DIMENSIONS`, `SMOKE_CLOUD_COLORS` |
| Armor L4 | `wearables.ts` | `createHelmetModel(4)`, `createVestModel(4)`, `getWearableGeometry(kind, 4)` (tiers clamp to 1–4) |
| Loot | `loot.ts` | `createLootModel(item, tier, {level, scope, marker})`, `createLootMarker`, `isLevelledLootItem`, `LEVEL_BEAM_HEIGHT` |
| Viewmodel | `viewmodel.ts` | new `ViewmodelItemId`s (`revolver`, `dbshotgun`, `rpg`, `knife`, `machete`, `paddle`, `smoke`, `smoke_cooking`), `viewmodelPoseFor(id, {scope})`, `MELEE_SWING_KEYS`, `meleeSwingPose`, `meleeHitFraction` |
| Decor | `decor.ts`, `src/shared/kits/decor.ts` | `getDecorParts(kind, variant)`, `createDecor`, `DECOR_KIND_INFO`, `DECOR_VARIANTS` |
| Island variants | `props.ts`, `src/shared/kits/island.ts` | `getPropParts(kind, variant)`, `createProp(kind, variant)`, `ISLAND_VARIANTS`, `islandVariant` |
| Office | `office.ts`, `src/shared/kits/office.ts` | kit kind `waterCooler` |
| Icons | `icons.ts` | `M2C_ICON_SVG` (knife, machete, paddle, dbshotgun, revolver, rpg, ammo_rocket, smoke, vest_4, helmet_4, 4 scopes), `SCOPE_2X_RETICLE_SVG`, `SCOPE_2X_FRAME`, `SCOPE_RIM_COLOR` |
Not built in A1 (spec only): the monitor `screen` split and desk lamp for After Hours (§9.2, §10.2), and the proposed
island and office kinds that the level data does not use.
