# Rendering

Owner: graphics-engineer. Code: `src/render/` (except `src/render/procedural/`, which belongs to graphics-designer).
Contract: `IRenderer` in `src/shared/contracts.ts`; rules: `docs/tech/ARCHITECTURE.md` §3, §8, §12.

## 1. Pipeline

WebGL2 through `THREE.WebGLRenderer` (three 0.187). sRGB output, `NeutralToneMapping` at exposure 1.0 (chosen
because it preserves the hues of the bright toon palette), `PCFShadowMap`, and pixel ratio capped per
preset. WebGPU is not used.

Each `render(view, dt)` call does the following, in order. The renderer reads `FrameView` and never writes simulation
state.

1. **Camera** (`cameraRig.ts`). The camera sits at `target + right * shoulderOffset - aim * distance`, with Euler
   `(pitch, yaw, 0, 'YXZ')`. In `follow` mode the boom is ray-marched against `heightAt` (+0.3 m clearance), the
   sea surface (+0.25 m) and vertical prop cylinders (palms, rocks, bushes, crates, huts) in a uniform grid. A
   pull-in snaps immediately; a release eases out at a rate of 4 /s. The final position is always clamped above
   terrain and water. `orbit` mode (title and lobby) skips boom collision because its pivot can be underground at
   the island centre; only the floor clamp applies. The local chibi is hidden when the boom is shorter than 0.55 m.
   **M2a ADS:** `CameraView` already carries the ADS fov, distance and shoulder offset (ClientGame, ADR 0004 §5); the
   renderer applies them as given. When `camera.firstPerson` is true (scope view) the camera sits exactly at
   `camera.target` (the eye) with no boom or collision, and the local body, armor and held item are hidden. There is
   no second render pass and no scope geometry: Ui draws the 2D scope overlay. Explosion camera shake is added on top
   (position jitter ≤ 0.12 m and ≤ 0.012 rad pitch/roll at amount 1, decaying at 7 /s).
2. **Sun** (`Sky.ts`, `SunRig`). One directional light. Its orthographic shadow frustum is centred on
   `camera.target` and snapped to whole shadow texels in light space, so shadows do not shimmer. In orbit mode the
   frustum widens to cover the whole island. A hemisphere light provides fill. There are no point lights, so the
   light count never changes and no shader recompiles at runtime.
3. **Culling and instance updates.** Props and loot are culled per instance on the CPU (frustum + distance), then the
   visible instances are compacted into their InstancedMeshes. Prop matrices are re-uploaded only when the visible
   set changes.
4. **Entities.** Chibis are posed from anim flags and stance weights (scope glints and in-hand fuse sparks are
   emitted here), then live grenades and the throw preview, then the tide wall, water and sky uniforms, then
   particles, tracers and explosion decals. The marker batch (arc dots, fuse blinks, glints) is rebuilt every frame
   between `begin()` and `end()`.
5. `renderer.render(scene, camera)`, then the listener pose is updated.

### Scene contents

| Layer | Module | Draw calls | Notes |
|---|---|---|---|
| Sky dome + 14 clouds | `Sky.ts`, `shaders/sky.ts` | 2 | Gradient + hard-edged toon sun disc, pinned to the far plane. Not tone mapped, so the horizon equals the fog colour exactly. |
| Terrain | `TerrainMesh.ts`, `radialMesh.ts` | 1 | Polar grid, ~36k vertices, ~72k tris. Rings every 1.25 m inland, 0.75 m across the beach band, coarser at sea. Vertex colours (dry sand, wet sand, grass, seabed) with the shared toon material. Receives shadows; does not cast. |
| Water to the horizon | `Water.ts`, `shaders/water.ts` | 1 | One polar mesh from just inside the beach to r = 2400 m. Uses a half-float height texture (512², ±185 m) for depth. |
| Props | `PropLayer.ts`, `instancing.ts` | ≤ 21 (+≤ 10 shadow) | One InstancedMesh per (kind × part): body + outline hull, plus a flame for torches (flicker in the vertex shader). |
| Loot | `LootLayer.ts` | ≤ ~30 | Every distinct (geometry, material) part of `createLootModel(item, tier)` is one InstancedMesh shared by all loot. |
| Chibis | `PlayerViews.ts`, `chibiSkin.ts`, `characterPose.ts` | 2 per chibi + 2 per held item (+1-2 shadow) | See §3. Worn vest and helmet are merged into the skinned mesh: 0 extra calls. |
| Tide wall + target ring | `TideWall.ts`, `shaders/tideWall.ts` | 2 | |
| Name tags | `NameTags.ts` | 1 | Other living players within 45 m. Names rasterised once into a 512×1280 canvas atlas (one row per player, redrawn only on join or rename); camera-facing quads in one InstancedBufferGeometry. Constant on-screen height (2.6 % of the viewport), depth-tested (terrain and props hide them, so no wallhack), fade 30-45 m. Hidden for the local player, the spectate target and the dead. |
| Particles | `vfx/Particles.ts` | 1 | One `THREE.Points` for every puff, spark, star and flash. |
| Markers (M2a) | `vfx/Markers.ts` | 0-1 | One `THREE.Points` rebuilt per frame (capacity 512): grenade arc dots, fuse blinks, scope glints. Same shader as the particles, fog off so a glint reads at any range. |
| Grenades (M2a) | `GrenadeLayer.ts` | 0-2 (+1 shadow) | Instanced pineapple (colour + hull) for every live grenade, ×1.5, tumbling. |
| Throw preview ring (M2a) | `GrenadeLayer.ts` | 0-2 | Dashed blast ring (64 samples, draped on `max(terrain, sea)` each frame) + small solid inner ring. Only while `grenadeArc` is set. |
| Explosion decals (M2a) | `vfx/Explosions.ts` | 0-8 | Pools of 4 shock rings and 4 sand discs, one call each while alive (0.25 s / 2 s). |
| Tracers | `vfx/Tracers.ts` | 1 | Camera-facing quads in one dynamic buffer. |

### Water

- **Depth.** Depth is `surfaceY - terrainHeight`, sampled from the height texture with linear filtering. Colour comes
  in hard toon bands: shallow+white (< 0.55 m), `seaShallow` (< 1.9 m), `seaDeep` (< 5.5 m), then `seaAbyss`.
  Alpha runs from 0.5 at the waterline to 1.0 at about 2.4 m depth, so the sand shows through in the shallows.
- **Fake reflection.** A fresnel term mixes toward `skyHorizon`. There are no planar reflections at any preset.
- **Foam.** An animated swash band at the shoreline. On medium and high (`WATER_DETAIL`) there is also a second foam
  line that rolls toward the beach, broken up by noise. A faint, broken line of drifting surface foam marks
  `map.worldRadius`. It wobbles with the noise, is anti-aliased in screen space, sits at 60 % strength, and is drawn
  only within 55 m of the camera (fade from 30 m). From the island it is invisible, so it no longer reads as white
  dashes floating at the horizon (M1-fix; the old dashed rope had 16 m dashes, full white).
- **Height-texture edge.** Outside the baked ±185 m square the lookup clamps to the edge texel (flat reef floor,
  already in the abyss band). It used to jump to -60 m, which spiked `fwidth(depth)` and drew a one-pixel foam line
  along the square: a second source of "white dashes near the horizon". The depth anti-aliasing width is also
  clamped to 0.35 m.
- **Sparkle and waves.** Sun-glint sparkles use per-pixel derivative normals, with a hash-cell flicker within 60 m of
  the camera. Each glint is a round dot inside its 0.4 m cell (square cells read as floor tiles up close). Vertex waves are about 7 cm, fading out beyond 190-320 m (medium and high only).
- **Render-only reef.** The sim's sea floor flattens at `SEA_FLOOR_DEPTH` (0.9 m) everywhere, which would make the
  whole ocean shallow turquoise. `visualTerrain.ts` keeps `heightAt` exactly out to `worldRadius + 6` m, then drops
  the render-only height 7 m over 20 m. The result is a turquoise lagoon inside the boundary and deep blue sea
  outside it. Nobody can stand there, so gameplay is unaffected.

### Tide wall

- **Wall.** An open unit cylinder, 42 m tall, scaled to the zone radius every frame. Radius and centre are smoothed
  with τ = 0.12 s to hide the 20 Hz snapshot steps.
- **Shader.** Double-sided and translucent, so it reads from inside and outside. Diagonal stripes scroll upward, a
  rim brightens at grazing angles, and a churning foam skirt sits where the wall meets max(terrain, sea), sampled
  from the same height texture. The wall pulses on `zoneChanged`.
- **Target ring.** A dashed ribbon draped over `max(heightAt, 0) + 0.12` m. It is rebuilt only when the target circle
  changes, and is shown only while the target differs from the current circle.

## 2. Budgets and measurements

Budgets come from `docs/PRODUCTION.md` (B8, C5): ≤ 250 draw calls and ≤ 600k triangles in the busiest view, and
60 fps on a mid-range integrated GPU at 1080p (medium).

**How these were measured.** The numbers below are `renderer.info.render` after a full frame, which includes the
shadow pass. They were captured in headless Chromium (SwiftShader) at 1280x720 with a scratch harness that feeds
fake `FrameView`s: all 77 loot spawns populated, a tide zone, and shotgun bursts every 20 frames. SwiftShader is a
software rasteriser, so its fps numbers are meaningless; **draw calls and triangles are exact**. The fps target still
needs a run on the reference laptop (C5).

| View (medium unless noted) | Calls | Triangles |
|---|---|---|
| Follow, 16 chibis within 13 m, inland (worst crowd) — **before** chibi skinning | 287 | 373k |
| Same view, **after** chibi skinning (current) | 136-137 | 373k |
| Same view, low / high | 118 / 137 | 334k / 386k |
| Final-circle style crowd, 16 chibis, looking along the grove | 133 | 319k |
| Fight, 6 chibis, inland | 86-92 | 270-298k |
| Beach, 4 chibis, looking at sea | 49 | 144k |
| Title orbit, whole island, island-wide shadow frustum | 59-62 | 226-442k |

**M2a (2026-11-18), same harness** (`scratchpad/m2ar/h.ts`, 1280x720, `renderer.info` after a full frame):

| View (medium unless noted) | Before M2a | After M2a |
|---|---|---|
| Crowd: 16 chibis within 13 m (M1 harness view) | 134 calls / 273k | 136 / 276k (new guns and a grenade in hands) |
| Same, low / high | 115 / 248k, 143 / 284k | 117 / 250k, 144 / 286k |
| Same crowd, **every chibi armored** (vest 1-3 + helmet 1-3), mixed stand/crouch/prone | — | 138 / 292k (low 118 / 266k, high 147 / 302k) |
| Scope view, 8x, three targets at 40 m | — | 70 / 147k (narrow frustum) |
| Grenade throw preview + 2 grenades in flight + 3 remotes | — | 119-123 / 231-267k |
| Explosion at 10 m (boom particles + ring + disc) | — | +2 calls while alive, 16 particles |
| In-game (real client + server, 12 players, beach hamlet) | — | 78-91 / 292-327k |

Armor costs triangles only: +16k for 16 fully armored chibis (wearables 156-334 colour + 96-286 hull tris each) and
no draw calls. Geometry count stays flat over 300 frames (81-82), so armor changes do not leak.

Startup (headless, JS only): `new Renderer` takes about 130 ms (terrain build plus height-texture bake). The first
frame takes about 180 ms (shader compile).

Asset cost per instance (from `countTris`). Shadow-pass triangles are the body only.

| Asset | Tris (body / outline) | Count on island01 | Total |
|---|---|---|---|
| palm | 648 / 648 | 133 | 172k |
| bush | 344 / 280 | 74 | 46k |
| rock | 100 / 100 | 58 | 12k |
| other kinds | — | 101 | 26k |
| chibi | 2,440 / 1,872 | ≤ 16 | ≤ 69k |
| guns | 124-300 incl. outline | ≤ 16 | ≤ 5k |

## 3. Draw-call strategy

- **Props.** One InstancedMesh per (kind × part), for both body and outline hull. Instance matrix =
  `T(x, y, z) · Ry(rotY) · S(scale) · part.matrix`, where y = `heightAt`. Docks use absolute
  `y = (0.8 - 0.55) · scale`, so the model's deck top matches the sim's `DOCK_DECK_HEIGHT` (0.8). Boats use
  `max(heightAt, -0.12)`. Instances are culled on the CPU against the frustum, with each bounding sphere padded by
  8 m so shadow casters just off-screen still cast. Outline instances are dropped beyond `outlineDistance`.
- **Loot.** Fully instanced. It is rebuilt each frame because it bobs and spins (about 80 items × about 4 parts, which
  is trivial). The interact-highlighted loot gets a pulsing ring (1 call) and a 1.15× scale.
- **Chibis.** The procedural chibi is 6 rigid part meshes plus 6 outline hulls (12 calls and 6 shadow casts). At
  view creation, `chibiSkin.ts` bakes it into one rigid-skinned colour mesh and one rigid-skinned outline (2 calls,
  1 shadow cast). The procedural pivots (`body`, `head`, `armL/R`, `legL/R`) are reused directly as the skeleton
  bones, so pose code and the `handR` weapon socket are unchanged. Skinned geometry is cached per appearance. The
  outline uses a skinning-aware copy of the inverted-hull shader, so hull normals follow the bones. A bounding sphere
  is set manually so frustum and shadow culling still work. Views are pooled, and a reused view swaps geometry with
  `setVariant`. Character outlines turn off beyond `characterOutlineDistance`.
- **VFX.** One Points draw for every particle and one mesh for all tracers. Both use fixed-capacity struct-of-arrays
  pools with swap-remove compaction, update only the live range, and do not allocate per shot.
- **Armor (M2a).** `getWearableGeometry(kind, tier)` is authored in the bone frame (identity attach), so `chibiSkin`
  appends it to the skinned colour and outline geometry with skin weight 1 on the hip bone (vest) or neck bone
  (helmet). Hit flash, fade and outline LOD apply to it for free. A worn helmet also switches the head to the
  helmet-safe hair (`setVariant({ helmet: true })`). The cache key is `skin|outfit|hair|h<0/1>|v<tier>|m<tier>`
  (`skinKey`). Entries are ref-counted per view; unreferenced ones stay in a 12-entry LRU and are then disposed. A
  tier change rebuilds one merged geometry (about 1 ms, only on equip or break).
- **Grenades (M2a).** All live grenades share two InstancedMeshes; per-grenade state (tumble angle, blink phase,
  trail distance) comes from a pool keyed by grenade id.

### Stances (M2a, STYLE.md §16)

- `characterPose.ts` computes three full poses from the same input (stand, crouch, prone) and blends them:
  `out = lerp(lerp(stand, crouch, c), prone, p)`. The stance pivot (`parts.stance`) carries the crouch drop and the
  prone lie-down (`-PI/2`, lift 0.15, back 0.62), so the root keeps world position and yaw and the prone body is
  centred on the sim hitbox (feet position, ADR 0004 §2).
- `stanceBlend(stance, stanceFrom, stanceProgress)` gives `(c, p)` with the §16 staging: stand <-> crouch eases out;
  stand -> prone crouches over k 0-0.4, then lies down (ease-in-out); getting up reverses it; crouch <-> prone is one
  ease-in-out. Remote players use the interpolated snapshot fields; the local player uses the predicted ones. The
  weights are smoothed at 22 /s per view (hides snapshot steps and interrupted transitions) and frozen at death.
- Prone aim pitch is clamped to -0.25..+0.45 rad. The crawl (frog kick, arm alternation, shoulder roll) runs on the
  walk phase, whose stride shortens to 0.62 m prone (0.9 m crouched), with the amplitude scaled by speed relative to
  `walkSpeed x stances.prone.speedMultiplier`. Healing and reloading prone swap only the arm block.
- Death while prone rolls onto the side (root tilt z ±1.3 over 0.35 s) instead of toppling back.
- Name tags and the followed-character fade use the stance height (`movement.stances.<s>.height`).
- ADS weapon pose: the local player uses `FrameView.ads.cameraBlend`; remotes use `anim.ads` smoothed at 10 /s.
- Grenade in hand: `createGrenadeModel({ pin: !cooking })` on `handR` at `GRENADE_DIMENSIONS.handOffset`; cooking is a
  wind-up (arm up and back), `grenadeThrown` (not dropped) plays the throw follow-through.

**Fallback cuts if the reference laptop misses 60 fps**, in this order:

1. Lower `outlineDistance`.
2. Lower `shadowHalfExtent` and `shadowMapSize`.
3. Turn off `waterDetail`.
4. Drop prop shadows beyond about 25 m. This means splitting each kind into near and far instance sets, which costs
   about 10 more calls.
5. Thin the palms.

### Camera feel (BUG-003, director playtest)

- **Looking up.** When the boom end would go below the floor (terrain + 0.3 m, or the sea surface + 0.25 m), the
  rig keeps the boom length and slides the camera along the floor, farther behind the player
  (`slideAlongFloor` in `cameraRig.ts`). The camera sits low and behind and looks up past the character, instead of
  being pulled in to neck height. It is continuous at the pitch where the boom first touches the floor. Measured on
  sand: the camera stays 3.24 m from the pivot at 35°, 60° and 80° (before: 0.37-0.49 m above the feet at 60-80°).
- **Close camera.** When collision pulls the camera close to the followed character (local player or spectate
  target), the character fades: opaque beyond 1.15 m from the camera to the body axis, hidden inside 0.45 m
  (smoothstep). The outline hulls hide as soon as fading starts, and the weapon hides below 60 % opacity. The fade uses
  one shared translucent clone of the toon material, so it adds no programs per player.

## 4. Quality knobs (`src/render/quality.ts`)

| Knob | low | medium (default) | high |
|---|---|---|---|
| `maxPixelRatio` | 1 | 1.5 | 2 |
| `antialias` (MSAA, read at construction only) | off | on | on |
| `shadowMapSize` | 1024 | 2048 | 4096 |
| `shadowHalfExtent` (m) | 28 | 42 | 60 |
| `propDrawDistance` (m) | 220 | 320 | 450 |
| `outlineDistance` props (m) | 70 | 140 | 300 |
| `characterOutlineDistance` (m) | 25 | 45 | 80 |
| `lootDrawDistance` (m) | 50 | 75 | 110 |
| `maxParticles` (pool capacity, set at construction) | 512 | 1024 | 2048 |
| `waterDetail` | off | on | on |

**Zoom LOD (M2a).** While zoomed, `characterOutlineDistance`, prop `outlineDistance` and `lootDrawDistance` are
multiplied by `tan(baseFov/2) / tan(fov/2)` (`lodZoom`, capped at 4), so a target in a 4x/8x scope keeps the outline
and nearby loot it would have up close. The narrow frustum keeps the cost down (scope view above: 70 calls).

`Renderer.setQuality(preset)` switches presets at runtime. It is not part of `IRenderer` and is not wired to
`Settings` yet (see §6).

## 5. VFX (bus subscriptions; the renderer never emits)

| Event | Effect |
|---|---|
| `shotFired` | Star-burst muzzle flash and forward sparks at the shooter's `muzzle` node (falls back to `origin`). One tracer per impact; the streak travels at 220 m/s and fires its impact effect when it arrives: sparks and a puff on players, a headshot star, a sand or grass puff on terrain, wood chips on props, a splash on water. Fists: impact puff only. The shooter's arm gets a recoil kick. |
| `playerDamaged` | Hit flinch and an 80 ms white flash on the victim. Zone damage: blue droplets. Headshot: a star above the head. |
| `playerKilled` | Topple backward (0.35 s), lie still, then a poof at 1.1 s and the view hides. If there is no view: an immediate poof at `victimPos`. |
| `itemPickedUp` | Rising sparkle stars. |
| `land` / `jump` / `footstep` | Dust ring scaled by `fallSpeed`, or a splash in water. Footsteps: sprint and water only, within 35 m. |
| `zoneChanged` | Tide wall pulse. |
| `explosion` (M2a) | STYLE.md §15 boom sized to `radius`: 0.15 s flash star + orange burst, 7 cream/orange smoke balls that drift to 0.5 x radius over 0.6 s, a white shock ring growing to the radius in 0.25 s, then 6 sand chunks and a darker-sand disc that fades over 2 s, or (when `heightAt(pos) < 0`) a water spray with no disc. No permanent scorch. Camera shake `explosionShake(localDistance, radius)`: quadratic, none when null or beyond 2 x radius. The grenade stops drawing at once. |
| `grenadeThrown` / `grenadeCooked` (M2a) | Throw follow-through on the thrower (not for drops); the fuse clock for the in-hand spark. |
| `grenadeBounced` (M2a) | Small splash on `'water'`. |
| `stanceChanged` (M2a) | Splash when `forced` (water stand-up). |
| `playerDamaged` armor break (M2a) | `vest?.broken` / `helmet?.broken`: 10 tier-coloured shards and a ring at the chest or head. |
| `shotFired` new guns (M2a) | Flash scale and tracer width per weapon: dmr 1.15 / 0.065 m, sniper 1.35 / 0.08 m, lmg 1.05 / 0.055 m. |

**Per-frame (FrameView) M2a effects**
- Live grenades (`FrameView.grenades`): tumble about the horizontal axis across the velocity, a fuse blink at the cap
  whose rate rises from 2 Hz (≥ 2.5 s left) to 10 Hz at 0 (`fuseBlinkHz`; red in the last second), fuse sparks
  every 120 ms (60 ms in the last second), and a cream puff every 0.25 m while faster than 1.5 m/s.
- Throw preview (`FrameView.grenadeArc`): cream ink-rimmed dots every 0.35 m starting 0.7 m from the hand, shrinking
  toward the end (`resampleArc`, ≤ 200 dots), and the dashed danger ring at 35 % opacity plus a solid inner ring.
- Scope glint on remotes with `anim.ads` and a scope sight (`sightOf` / `isScopeSight` from Balance): a 4-ray flash
  at the objective lens (the `getWeaponSight` anchor's line of sight, 0.34 m (4x) / 0.54 m (8x) ahead of the rear
  lens). Strength is a smoothstep from 30° to 8° between the scope axis and the camera direction; the size is
  10-30 px on screen at any range.

Effects farther than 160 m from the camera are skipped.

## 6. Contract gaps and requests

- **Balance injection (Contract revision 1 #10).** `Renderer` takes `balance: Balance` as its 4th constructor
  parameter (required; main.ts is the only caller) and passes it to its submodules (`loot.pickupBobHeight`,
  `loot.extraAmmoScatter`, `movement.sprintSpeed`, `player.height`). Render never imports `BALANCE`.
- **Loot tier (M1-fix, Contract revision 1 #1).** The tier ring uses `LootState.tier` when present. When it is absent
  it falls back to the nearest map `lootSpawns` entry within `extraAmmoScatter + 1.5` m, else common.
- **Colliders vs models (M1-fix).** `sim/colliders.ts` is the single source of truth (ADR 0002 §7, read-only import).
  - Dock: the model is offset by `DOCK_DECK_HEIGHT - DOCK_MODEL_DECK_TOP` (sim constant imported, mirror deleted).
    Boats use the sim's `BOAT_MIN_BASE_Y`.
  - Camera collision is derived from the sim shapes for palm (three leaning trunk circles), rock (r 1.4, h 1.4),
    crate and hut (wall box plus stepped roof boxes to 5.1 m). `CameraObstacles` supports oriented boxes for this.
    Bushes keep a render-only cylinder (soft in the sim, opaque on screen). Umbrella, torch, driftwood, boat and dock
    do not block the camera.
  - Test (`m1fix.test.ts`): model body top vs collider top for rock, crate, hut (±0.15 m) and boat (±0.3 m; bow and
    stern rise to 0.79 m above the 0.55 m rim). Driftwood is excluded on purpose: the branch stub reaches 0.64 m but
    the collider stays at 0.35 m so the log can be hopped.
- **Chibi triangles (graphics-designer).** 2,440 colour + 1,872 outline, against the A6 budget of ≤ 1,500. It fits the
  frame budget, but please trim (sphere segments). `chibiSkin.ts` relies on the current structure:
  `chibi.meshes.{torso, head, armL, armR, legL, legR}`, each with one child mesh named `outline`, and each part mesh
  at identity under its pivot.
- **Quality setting (Contract revision 1 #7).** `Renderer.setQuality(quality: QualityLevel)` implements
  `IRenderer.setQuality`. Unknown values are ignored. main.ts calls it only on change.
- **WebGL context loss (M4).** `webglcontextlost` is `preventDefault`ed and `render()` does no work while lost. three.js
  re-creates its GL state on `webglcontextrestored` and re-uploads every geometry, texture and render target from its
  CPU copy (all render resources keep one; nothing frees arrays after upload). The renderer then re-reads the point
  size range and re-applies quality, shadow frustum, projection, point scale and name-tag scale. Verified in headless
  Chromium with `WEBGL_lose_context`: mean frame luminance 165.5 before, 0 while lost, 165.7 after restore.
  `stats()` reports `contextLost` and `contextLosses`.
- **Graphics status (ADR 0003 §5).** `getGraphicsStatus()` returns `'restoring'` while the context is lost, `'failed'`
  once `CONTEXT_RESTORE_TIMEOUT_MS` (5 s) passes without a restore, and `'ok'` otherwise, including after a late
  restore. The timeout is evaluated when polled, so there are no timers (`contextHealth.ts`, unit-tested). main.ts
  polls it after each render and forwards changes to Ui, which shows the reload overlay on `'failed'`.

## 7. Debugging and tests

- **Dev hook.** In dev builds only (`import.meta.env.DEV`), `window.__render` exposes `{ info, renderer, scene, camera,
  stats(), setQuality(p), presets }`. `stats()` returns fps, average and p95 frame ms, average CPU render ms, calls,
  triangles, geometries, textures, programs and live particles. Check for leaks by watching `info.memory` while
  players join and leave: views are pooled and geometry is cached per appearance, so the counts should stay flat.
  The hook is stripped from production builds.
- **Unit tests** (`src/render/*.test.ts`, Vitest, node):
  - camera placement, collision and orbit;
  - terrain within 0.05 m of `heightAt` (B8);
  - `rotY` convention;
  - loot tier lookup (`LootState.tier` first, inference as fallback);
  - dock/boat bases and model tops vs sim colliders, camera blockers from sim shapes (oriented boxes);
  - name-tag atlas rectangles;
  - poses for aim, run, drop and death;
  - M2a (`m2a.test.ts`): stance blend staging and continuity, crouch/prone key poses, prone pitch clamp, crawl
    amplitude by speed, prone death roll, grenade and ADS poses, glint visibility and strength, arc resampling,
    fuse blink rate, explosion shake falloff, zoom LOD, armor merge (bones, mesh count) and cache eviction;
  - particle pool capacity and lifetime.
- **Dispose.** `dispose()` unsubscribes from the bus, frees instance buffers, the skin cache, the height texture,
  render-owned materials and the WebGL context, then removes the canvas. Procedural geometry and material caches are
  shared and owned by `procedural/`, so they are left alone.

## 8. M2a requests to other owners

- **clientFeel (game-designer / game-developer):** at `adsCameraDistance` 1.9 m and `adsCameraShoulderOffset` 0.45
  the big chibi head covers the left half of the view and reaches the screen centre when aiming uphill (screenshot
  `scratchpad/m2ar/out/a/s_ads_*.png`). Suggest a shoulder offset of 0.55 (still < 0.6) or a slightly lower ADS pivot.

## 9. M2b: map switching, the office, the drop and first person (ARCHITECTURE §15.7)

### 9.1 Map scenes and switching (ADR 0005 §5)
- The static world is one `MapScene` (`mapScene.ts`): `IslandScene.ts` (sky, terrain, sea, island props, tide wall;
  the M1/M2a look unchanged) or `IndoorScene.ts` (office). Players, loot, grenades, VFX, the carrier and the viewmodel
  pass are map-independent and stay.
- `Renderer` builds the constructor map (title screen), then listens to `mapChanged`: it disposes the old scene
  (every render-owned geometry, material and texture; shared procedural caches stay), clears pooled VFX, builds the new
  scene and applies its `SceneLook` (key light direction / colour / intensity, hemisphere, fog, clear colour, shadow
  bias), camera far plane, camera limits and carrier model. The same map id only takes the new balance and clears the
  route. Per-match numbers come from `mapChanged.balance` (`PlayerViews.setBalance`, `ViewmodelPass.setBalance`).
- Leak check (harness, 4 island <-> office round trips): `info.memory` is flat at 80 geometries / 5 textures in the
  office and 27 / 4 on the island after the first round.

### 9.2 Office pipeline (STYLE.md §19)
| Layer | Draw calls | Notes |
|---|---|---|
| Floor | 1 | One plane. Plank (1.8 x 10.8 m, staggered thirds, AA seams that fade with distance), carpet (4.5 m two-tone) and tile (2.7 m + grout) computed per fragment from world xz and a nearest 0.45 m floor-zone texture. Under-desk darkening and the sprinkler wet tint. |
| Kit props | 2 per visible 40 m chunk (24 chunks) | Every non-ceiling placement is merged per chunk into one body + one hull (`mergeBuilder.ts`; hull width per vertex, so all outline classes share a call). 65k body + 46k hull tris for 615 placements. Hulls hidden past the outline distance per chunk. |
| Walls | 2 | Every `wallFrame` run (`getOfficeWallParts`, scaled to the exact length, thickness and bottom/top) in one body + one hull. |
| Glass / frost / glow | 3 | All panes (walls, phone booths) in ONE transparent mesh (renderOrder 1), frosted bands + glare in one (2), diffusers in one. Sorted after opaque. |
| Ceiling | 3 + 3 per ceiling kind | Dark plane at `ceilingHeight` (nothing above it; the camera is clamped under it), merged ducts + hull, and the kit's `'ceiling'` kinds instanced (light panels, AC cassettes: body, hull, glow). |
| Rain curtain | 2-3 | `RainCurtain.ts`: curtain cylinder (streaks scroll down), dashed target ring, GPU rain lines (1.2k / 2.8k / 4k per preset) outside the circle only, stopped by desk tops. Splash rings through the pooled particles. |
- **Under-desk darkening** (`indoorFx.ts`): a 0.5 m top-down cover texture (R covered, G underside height, B highest
  walkable top) built from kit collider boxes whose underside is 1.4-10 m above their support. Floor, props and the
  chibis (their colour material is `chibiCoverMaterial()`) multiply by 0.75 below the underside. Inert outdoors.
- **Cut-away**: in the 3P cases (carrier, chase, death, results; not the title orbit) every indoor material dithers
  away fragments near the camera -> subject segment (radius 3.2 m at the camera to 1.1 m at the subject, hulls x1.3 so
  no ink shows through the hole). Screen-door discard, so no sorting. Camera collision indoors is the floor, the
  ceiling (the boom slides along it, like `slideAlongFloor`) and the floor rectangle; walls are cut, not collided.
- **office.md T13 (light panels 20.9-21.6 m vs the 25 m drone and jump start)**: ceiling props within 10 m of the drone,
  or within 6 m of a camera above (lowest point - 3 m), retract upward (eased, ~0.3 s) until their lowest point is 1 m
  under the ceiling (26 m, above the drone top 25.85 m); wires pass behind the ceiling plane. Render-only.
- Lighting: key light `#F2F8FF` 1.8 from (-0.25, 0.9, -0.35), hemisphere 1.25, fog `#3A3F47` 120-300 m, shadow bias
  -0.0006 / normal bias 0.09 (the island's 0.035 gave acne on the 27 m walls). No warm point lights (shader cost on
  every material; listed as optional in STYLE §19.4).

### 9.3 Carrier, drop and first person
- `CarrierLayer.ts`: seaplane or drone by `map.carrier`, placed by `carrierPosAt` / `carrierHeading` from the
  `carrierDeparted` route (before it: at the carrier camera target, heading for the centre). Spinners at 32 rad/s
  with blur discs, gentle bob, casts shadows; indoors only drawn over the floor. Aboard players are hidden.
- Drop poses (`characterPose.ts`, STYLE §20): freefall rotates the stance pivot about the hips (pitch -1.35, bank about
  the spine with lateral steering, dive with forward steering, flutter); the hang pose is upright with a root sway
  and bank; `chute` 0..1 blends them over the 0.35 s deploy. `PlayerViews` estimates steering from rendered motion and
  owns a lazily created parachute per view on the stance pivot: packed in freefall, deploy pop, 0.4 s collapse after
  landing. Pre-gate drops without `dropPhase` render as freefall.
- VFX: `playerJumped` cream puff, `parachuteOpened` 4-ball pop at the canopy, FP freefall speed lines
  (`SpeedLines.ts`, 1 call, off with reduced motion), `'glass'` impact chips, floor-coloured dust indoors.
- Camera by `CameraView.view` (`cameraCaseOf`): first person = at `target`, `roll` applied, near 0.05 m, the subject's
  body (and its parachute) hidden; shake skipped with `reducedMotion`. The viewmodel pass (`ViewmodelPass.ts`, viewmodel
  graphics-engineer) draws after the world with a depth clear and adds its calls to `renderer.info`.
- BUG-008 head fit: the prone head follows 0.2 of the aim pitch looking up and none looking down; the crouched head tilt
  is capped at 0.4 rad. Measured (hair 0, precise bounds): prone top 0.673 / 0.673 / 0.675 m and head centre z
  -0.51 / -0.51 / -0.47 at -30 / 0 / +45 deg (`m2b.test.ts`).

### 9.4 Office measurements (harness, real `OFFICE` level, 1280x720 SwiftShader, `renderer.info` after a full frame, 40 frames, viewmodel off)
| View | low | medium | high |
|---|---|---|---|
| Floor, main aisle, 5 chibis, rain + curtain in view | 76 / 139k | 95 / 167k | 105 / 182k |
| All desks in view (24 m up over the south corridor) | 53 / 132k | 63 / 152k | 70 / 173k |
| Desk top / under desks / glass room (3P) | | 75 / 151k, 75 / 126k, 71 / 96k | |
| Drone carrier view (3P, 3 chibis, chute) | | 92 / 142k | |
| Island: chute 3P / seaplane / FP on foot | | 43 / 223k, 41 / 142k, 35 / 228k | |
All inside the 150 calls / 300k tris medium budget. Building the office scene takes 67 ms cold, 25-35 ms warm (Node, merging +
cover data), hidden in the countdown.
