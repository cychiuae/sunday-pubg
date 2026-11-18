# System: Camera (first person) (M2b)

Numbers: `balance.json` `clientFeel.fp*`, `clientFeel.vm*`, `clientFeel.fpRecoil.<weaponId>`, the third-person keys (`cameraDistance`,
`cameraShoulderOffset`, `cameraFovDeg`, `orbit*`) for the 3P cases, and the sim key pair `movement.stances.pronePitchMinDeg / MaxDeg`.
The camera is client presentation **except** the prone pitch clamp, which is a sim rule. This file owns the camera rules from M2b on;
`combat.md` and the GDD point here.

## Purpose
First person puts the crosshair exactly on the shot ray and removes the third-person peek (seeing around corners your character cannot
shoot past), which makes fights fairer and more readable at toy scale: under-desk crawlspaces and monitor canopies feel huge from the eye.

## Camera mode per state
| State | Mode | Details |
|---|---|---|
| Waiting room / countdown | UI | Room UI; the countdown map shows the route (`drop.md`). |
| Aboard the carrier | 3P orbit | Orbit around the carrier at `clientFeel.carrierCameraDistance` (island 26 m for the 22.6 m seaplane; office override 10 m for the 7.7 m drone under the 27 m ceiling), free mouse look, `cameraFovDeg`. Ceiling, floor and wall clamps as in the other 3P cases. |
| Freefall | **FP** | From the eye; WASD steers relative to the look yaw ("look where you steer"). Viewmodel: arms in a skydive pose. |
| Parachute | **FP** | Same; viewmodel arms on the toggles; the local canopy model is drawn above the eye and is visible when looking up. |
| On foot (alive, landed) | **FP** | Eye point = sim `eyePoint` (feet + stance eye height, lerped in transitions). Local body hidden, viewmodel on. No 3P toggle. |
| Dead (death screen, `match.deathScreenSeconds`) | 3P orbit | Slow orbit around your body, or the killer if alive and within `clientFeel.deathCamKillerRange` (30 m) (existing death cam). |
| Spectating | **FP** (default) / 3P chase (V) | FP from the spectated player's interpolated eye with their viewmodel; **V** toggles a 3P chase view (existing 3P camera with boom collision and wall fade). The choice persists while spectating. Click/Space still cycles targets. |
| Results | 3P | Slow orbit around the winner if alive, otherwise the last camera frozen behind the results panel. |

FP rules that apply in every FP mode:
- Camera position = eye point + cosmetic offsets (bob, landing dip) whose total length is capped at `clientFeel.fpMaxCameraOffset` (0.06 m)
  and is **0 at full ADS**. Camera rotation = look yaw and pitch exactly (no bob or recoil rotation on pitch or yaw), so the screen centre is
  always on the shot ray, within at most 6 cm of parallel offset from bob.
- The hip crosshair is drawn at the screen centre (no raycast projection needed in FP) and sized to the current cone (`combat.md`).
- No camera boom collision and no close-camera body fade in FP; both stay for the 3P cases.
- The local body is hidden in FP. Own shadow: optional (graphics). Remote players render as before.
- Nothing renders above the office ceiling in any mode.

## Field of view
- **Setting "Field of view"**: default `DEFAULT_FP_FOV_DEG` 80 deg, range `FP_FOV_MIN_DEG` 70 .. `FP_FOV_MAX_DEG` 100, as a **horizontal
  FOV at the reference aspect** `FP_FOV_REFERENCE_ASPECT` (16:9). These are settings constants in `src/shared/contracts.ts` (ADR 0005 §9),
  like the mouse-sensitivity range, not balance keys (the `clientFeel.fpFov*` keys were removed in M2b). The client converts the setting
  once to a vertical FOV and keeps that vertical FOV for every window shape (Hor+): `vFov = 2 atan(tan(hFov / 2) / FP_FOV_REFERENCE_ASPECT)`.
  Default 80 deg horizontal = 50.5 deg vertical.
- It applies to every FP mode. 3P modes use `cameraFovDeg` (vertical).
- The viewmodel is drawn in its own pass with the fixed vertical FOV `clientFeel.viewmodelFovDeg` (55), so the arms never clip into walls
  and look the same at every FOV setting.

## Head bob, sway and motion
| Effect | Applies to | Amount | Notes |
|---|---|---|---|
| Head bob, walk | camera position | vertical `fpBobWalkVertical` 0.02 m, lateral `fpBobWalkLateral` 0.012 m | one vertical cycle per footstep (`footstepStrideWalk`), one lateral cycle per two steps |
| Head bob, sprint | camera position | `fpBobSprintVertical` 0.035 m, `fpBobSprintLateral` 0.02 m | stride `footstepStrideSprint` |
| Crouch / crawl | camera position | bob x `fpBobCrouchFactor` 0.6 / x `fpBobProneFactor` 0.5 | |
| Landing dip | camera position | `fpLandDip` 0.05 m down, back over `fpLandDipMs` 150 | after jumps and drops |
| Bob in ADS | camera position | x (1 - cameraBlend) | 0 at full ADS: aimed shots are exact |
| Viewmodel bob | viewmodel | camera bob x `vmBobFactor` 1.5 | reads clearly without moving the view |
| Idle sway | viewmodel | `vmSwayIdleDeg` 0.6 deg, period `vmSwayIdlePeriodMs` 3000 | never the camera |
| Look sway (lag) | viewmodel | `vmSwayLookFactor` 1.5 deg per rad/s of look speed, capped at `vmSwayMaxDeg` 3 | never the camera |
| Stance change | camera | eye height lerp from the sim | smooth by construction |

All of these are cosmetic. The sim's spread is the only accuracy rule.

**Reduced motion** (Settings "Reduce motion", default follows the OS `prefers-reduced-motion`): head bob and the landing dip are off,
viewmodel bob and sway x `reducedMotionViewmodelFactor` (0.3), recoil camera roll and FOV punch off, freefall speed-line shake and
grenade/explosion camera shake off. The separate **Head bob** toggle (default on) turns only the camera bob and landing dip off; reduced
motion forces it off.

## Prone pitch (sim rule, replaces the render-only clamp)
- M2a clamped prone aim only in the pose (-0.25..+0.45 rad, about -14..+26 deg) while the sim allowed +-80 deg, so a prone player could
  shoot straight up with an arm pose that did not match. First person needs more range, and the sim must agree with what you see.
- **New rule**: while the stance is prone, or a transition has prone at either end, the sim clamps pitch to
  [`movement.stances.pronePitchMinDeg` -30, `pronePitchMaxDeg` +45]. Stand and crouch keep +-80 (`PITCH_MIN/MAX`).
- Why these limits: from a 0.35 m eye, -30 deg reaches the ground 0.6 m ahead (inside your own prone box's front 0.75 m, so you can aim
  at the floor right in front of you); +45 deg lets a prone player under a desk edge or on a plateau shoot at players above on the next
  level. The prone hitbox is a level box and does not depend on pitch; the **pose** (graphics) must reach the same limits: chin down at
  -30, upper body propped on the elbows at +45. `PRONE_PITCH_MIN/MAX` in render should read these keys.
- The client clamps the look the same way (prediction), so the camera never shows an angle the sim rejects. Entering prone with pitch
  outside the range: the sim clamps on the first tick of the transition (firing is blocked during transitions anyway) and the camera eases
  to the clamped pitch over the transition time.
- Grenade throws from prone use the clamped pitch (max +45, still above the 35 deg full-speed point).
- Bots obey the same clamp.

## ADS in first person
- **Timing reuse**: the sim `adsProgress` (from `adsTimeMs`) is unchanged. The client `cameraBlend` follows `adsProgress` going in and
  eases out over `adsExitBlendMs` (120) when ADS ends (the sim exit stays instant).
- **Zoom**: true magnification relative to the **default** FOV, so ADS views are identical for every FOV setting (no advantage from the
  slider): `vFovAds = 2 atan(tan(vFovDefault / 2) / adsZoom)`, and the current vertical FOV blends from the player's own vFov to
  `vFovAds` by `cameraBlend`. This replaces the M2a linear `fov / adsZoom` formula.
- **Sensitivity**: look speed = base x `lerp(1, adsSensitivity, cameraBlend) / zoom`, with
  `zoom = tan(vFovPlayer / 2) / tan(vFovCurrent / 2)` (screen-space speed stays constant while zooming).
- **Iron sights and red dots**: the viewmodel moves from the hip pose to the ADS pose over the same blend, so the weapon's `sight` anchor
  (per-weapon model data from the graphics-designer) lands **exactly on the screen centre at cameraBlend 1**. The hip crosshair fades out
  between `adsCrosshairFadeStart` 0.3 and `adsCrosshairFadeEnd` 0.7; the iron front post or the red dot is the reticle. The red dot is
  drawn on the sight glass at the screen centre.
- **Scopes (4x, 8x)**: the viewmodel raises the scope toward the eye during the blend; at `adsProgress` = 1 the full-screen scope overlay
  appears with a `scopeOverlayFadeMs` (80) black fade, and the viewmodel is hidden. Leaving ADS removes the overlay at once.
- Recoil in ADS: viewmodel kick x `fpAdsRecoilFactor` (0.5); with a scope overlay only the FOV punch and roll play.
- Scope glint for remote players (`combat.md`) is unchanged.

## Recoil: visual only (decision)
**Recoil is a visual kick only; the sim spread stays the only accuracy rule.**
- A real aim offset would need new server state per player, prediction and reconciliation of that state, bot compensation, and a new
  balance pass: M2a weapon kill shares were just measured inside target (SMG 27-33%, rifle 25%, DMR 14-19%) and real recoil would reshuffle
  them. Visual kick costs none of that.
- The kick never rotates the camera's pitch or yaw (that would move the screen centre off the shot ray). It is: the viewmodel kicks back
  and up, the camera rolls slightly (roll keeps the centre fixed), and the FOV punches out briefly. Everything returns within `returnMs`.
- Per weapon (`clientFeel.fpRecoil.<id>`):

| Weapon | kickBack (m) | kickPitchDeg (viewmodel) | rollDeg (camera) | fovPunchDeg | returnMs |
|---|---|---|---|---|---|
| pistol | 0.03 | 4 | 0.4 | 0.5 | 120 |
| smg | 0.015 | 1.5 | 0.25 | 0.2 | 70 |
| shotgun | 0.06 | 8 | 1.0 | 1.5 | 250 |
| rifle | 0.02 | 2 | 0.3 | 0.3 | 90 |
| lmg | 0.025 | 2.5 | 0.35 | 0.35 | 100 |
| dmr | 0.045 | 5 | 0.6 | 0.8 | 180 |
| sniper | 0.08 | 10 | 1.2 | 2.0 | 400 |

Fists use the punch animation; the grenade uses the throw animation (no recoil entry). Automatic fire stacks kicks up to 2x the single
kick, then holds.

## Viewmodel (summary; graphics owns the art and animation)
Stubby chibi arms with the player's skin tone and outfit sleeve, holding the active weapon, grenade, heal item or fists. Animations:
idle, walk/sprint bob, swap, reload (length = `reloadMs`), heal (length = `useMs`), grenade pull/cook/throw, punch, ADS pose. Sleeve
tint or vest edge for worn armor only if cheap. Spectating in FP shows the spectated player's viewmodel and weapon; their ADS shows from
`anim.ads` (scope overlay once `adsTimeMs` has passed since it turned on).

## Tunable values
`clientFeel.viewmodelFovDeg`, `carrierCameraDistance` (per map), `fpBob*`, `fpMaxCameraOffset`, `fpLandDip`,
`fpLandDipMs`, `vmBobFactor`, `vmSway*`, `reducedMotionViewmodelFactor`, `adsCrosshairFadeStart/End`, `scopeOverlayFadeMs`,
`fpAdsRecoilFactor`, `fpRecoil.<id>.*`, `adsExitBlendMs`; sim: `movement.stances.pronePitchMinDeg/MaxDeg`.
Third-person keys still used only by the 3P cases (aboard orbit, death cam, V chase, results): `cameraDistance`, `cameraShoulderOffset`,
`cameraFovDeg`, `orbitDistanceFactor`, `orbitPitchDeg`, `orbitDegPerSecond`, `deathCamKillerRange`. `adsCameraDistance` and
`adsCameraShoulderOffset` were deleted after the C-gate (no FP use).
The FOV setting range and default are `FP_FOV_*` in `contracts.ts` (tech-lead), not balance.
**Expected to need playtest tuning**: the default FOV 80 (`DEFAULT_FP_FOV_DEG`; players may want 90), `carrierCameraDistance`, bob amplitudes, recoil kicks, `pronePitchMaxDeg`.

## Edge cases
- Walking into a wall: the viewmodel is in its own pass, so it never clips; the camera near-plane must be small enough (<= 0.05 m) that a
  wall at the 0.45 m player radius never cuts the view.
- Prone under a monitor canopy or desk: the eye (0.35 m) is far below everything; no camera collision is needed because the eye is always
  inside the player's own collision cylinder.
- Spectated player changes stance: their eye height lerps from snapshot interpolation.
- Spectated player dies: the death cam of that player is not shown; the spectate target switches by the M1 rule.
- Freefall looking straight down: allowed (+-80); steering stays relative to yaw only.
- FOV slider changed during ADS: takes effect on the base FOV; the ADS target FOV does not change.

## What the UI must show
Settings: Field of view slider (70-100, default 80), Head bob toggle, Reduce motion, ADS mode and ADS sensitivity (M2a). A "V: switch
view" hint while spectating. Crosshair at the screen centre. Strings from `en.json`.

## Acceptance criteria (QA)
1. On foot, the camera position equals the sim eye point within `fpMaxCameraOffset` (0.06 m), and exactly at full ADS or with head bob off;
   the camera's forward vector equals `aimDirection(yaw, pitch)` at all times (also during recoil).
2. A shot fired at full ADS with forced 0 spread hits the world point under the screen centre (raycast check) in stand, crouch and prone.
3. Mode table: aboard = 3P orbit; jump = FP; landing = FP on foot; death = 3P orbit for `deathScreenSeconds`; spectate = FP, V toggles 3P
   chase and back; results = 3P.
4. FOV: default horizontal 80 at 16:9 gives a vertical FOV of 50.5 deg (+-0.1); values outside 70-100 clamp; a 21:9 window keeps the same
   vertical FOV.
5. ADS FOV is identical with the slider at 70 and at 100 (rifle full ADS: `2 atan(tan(25.27 deg) / 1.6)` = 32.8 deg vertical, +-0.2).
6. Iron/red dot: the sight anchor's screen position is within 1 px of the centre at cameraBlend 1 for every gun.
7. Scope: the overlay appears on the frame `adsProgress` reaches 1, the viewmodel is hidden while it shows, and it disappears on ADS release.
8. Recoil: after one rifle shot the camera pitch and yaw are unchanged; the viewmodel returns to rest within 90 ms; sim spread values are
   unchanged versus M2a tests.
9. Prone pitch: with stance prone, sim pitch is clamped to [-30, +45] deg for humans and bots; stand and crouch still allow +-80; entering
   prone at pitch +70 ends at +45 by the first prone tick; client and server pitch agree (no reconciliation correction).
10. Reduced motion on: camera bob, landing dip, recoil roll and FOV punch are all 0; viewmodel sway is 0.3x. Head bob off alone: camera bob 0,
    viewmodel bob unchanged.
11. Viewmodel never intersects a wall: standing face-to-wall, no wall pixels are drawn over the arms.
12. Freefall and parachute are FP; the canopy is visible when looking up during the parachute phase and not in freefall.
