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
2. **Sun** (`Sky.ts`, `SunRig`). One directional light. Its orthographic shadow frustum is centred on
   `camera.target` and snapped to whole shadow texels in light space, so shadows do not shimmer. In orbit mode the
   frustum widens to cover the whole island. A hemisphere light provides fill. There are no point lights, so the
   light count never changes and no shader recompiles at runtime.
3. **Culling and instance updates.** Props and loot are culled per instance on the CPU (frustum + distance), then the
   visible instances are compacted into their InstancedMeshes. Prop matrices are re-uploaded only when the visible
   set changes.
4. **Entities.** Chibis are posed from anim flags, then the tide wall, water and sky uniforms are updated, then
   particles and tracers.
5. `renderer.render(scene, camera)`, then the listener pose is updated.

### Scene contents

| Layer | Module | Draw calls | Notes |
|---|---|---|---|
| Sky dome + 14 clouds | `Sky.ts`, `shaders/sky.ts` | 2 | Gradient + hard-edged toon sun disc, pinned to the far plane. Not tone mapped, so the horizon equals the fog colour exactly. |
| Terrain | `TerrainMesh.ts`, `radialMesh.ts` | 1 | Polar grid, ~36k vertices, ~72k tris. Rings every 1.25 m inland, 0.75 m across the beach band, coarser at sea. Vertex colours (dry sand, wet sand, grass, seabed) with the shared toon material. Receives shadows; does not cast. |
| Water to the horizon | `Water.ts`, `shaders/water.ts` | 1 | One polar mesh from just inside the beach to r = 2400 m. Uses a half-float height texture (512², ±185 m) for depth. |
| Props | `PropLayer.ts`, `instancing.ts` | ≤ 21 (+≤ 10 shadow) | One InstancedMesh per (kind × part): body + outline hull, plus a flame for torches (flicker in the vertex shader). |
| Loot | `LootLayer.ts` | ≤ ~30 | Every distinct (geometry, material) part of `createLootModel(item, tier)` is one InstancedMesh shared by all loot. |
| Chibis | `PlayerViews.ts`, `chibiSkin.ts`, `characterPose.ts` | 2 per chibi + 2 per held gun (+1-2 shadow) | See §3. |
| Tide wall + target ring | `TideWall.ts`, `shaders/tideWall.ts` | 2 | |
| Name tags | `NameTags.ts` | 1 | Other living players within 45 m. Names rasterised once into a 512×1280 canvas atlas (one row per player, redrawn only on join or rename); camera-facing quads in one InstancedBufferGeometry. Constant on-screen height (2.6 % of the viewport), depth-tested (terrain and props hide them, so no wallhack), fade 30-45 m. Hidden for the local player, the spectate target and the dead. |
| Particles | `vfx/Particles.ts` | 1 | One `THREE.Points` for every puff, spark, star and flash. |
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

**Fallback cuts if the reference laptop misses 60 fps**, in this order:

1. Lower `outlineDistance`.
2. Lower `shadowHalfExtent` and `shadowMapSize`.
3. Turn off `waterDetail`.
4. Drop prop shadows beyond about 25 m. This means splitting each kind into near and far instance sets, which costs
   about 10 more calls.
5. Thin the palms.

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
  - particle pool capacity and lifetime.
- **Dispose.** `dispose()` unsubscribes from the bus, frees instance buffers, the skin cache, the height texture,
  render-owned materials and the WebGL context, then removes the canvas. Procedural geometry and material caches are
  shared and owned by `procedural/`, so they are left alone.
