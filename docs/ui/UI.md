# UI / UX: Last One Dry (M1 + M2a "Arsenal & Stance")

Owner: ui-ux-designer. Code: `src/ui/` (entry `src/ui/Ui.ts`, `export class Ui implements IUi`).
Inputs: `docs/design/GDD.md` §4, §5, §11; `docs/narrative/WORLD.md`; palette from `src/render/procedural/materials.ts`
(`docs/art/STYLE.md` was not written yet when this was drafted; the UI tokens below mirror `palette.ui*`).

All player-facing text comes from `src/content/strings/en.json` through `t()` / `tRandom()` / variant keys.
Gameplay numbers are never hard-coded. The UI reads `HudView` each frame and bus events for moments, and it sends
intents only through `UiCallbacks`.

---

## 1. Screen flow

```
 page load
    │
    ▼
 ┌─────────┐ Play (valid name)  ┌────────────┐ welcome  ┌────────────────────┐ countdown hits 0 ┌──────────────┐
 │  TITLE  │───────────────────▶│ CONNECTING │─────────▶│ LOBBY (waiting /   │─────────────────▶│  MATCH HUD   │
 │ name +  │◀── bad_name ───────│            │          │  countdown)        │                  │ (alive)      │
 │ Play    │                    └─────┬──────┘          └────────────────────┘                  └──────┬───────┘
 └─────────┘                          │ error / close            ▲      ▲                              │ local eliminated
      ▲                               ▼                          │      │ phase → lobby                ▼
      │                      ┌──────────────────┐ Retry/Rejoin   │      │                       ┌──────────────┐
      └── (no stored name) ──│ CONNECTION LOST  │────────────────┘      │                       │ DEATH CARD   │
                             └──────────────────┘ (from any screen      │                       │ (≥3 s, or    │
                                                   after Play)          │                       │  Spectate)   │
                                                                        │                       └──────┬───────┘
                         ┌──────────────┐  Play again (dismiss)  ┌─────┴──────┐  match ends            ▼
                         │ LOBBY        │◀──────────────────────│  RESULTS   │◀────────────── ┌──────────────┐
                         │ "Next match  │                        │            │◀───────────────│  SPECTATE    │
                         │  in N"       │                        └────────────┘   (alive HUD   └──────────────┘
                         └──────────────┘                                          wins too)
```

Screen choice is a pure function (`selectScreen` in `src/ui/logic.ts`, unit-tested):

| Condition (in order) | Screen |
|---|---|
| Player has not pressed Play | Title |
| `hud.connection` is `disconnected` or `error` | Connection lost (Retry, or Rejoin if we were ever joined) |
| `!hud.joined` | Connecting |
| `phase` is `lobby` or `countdown` | Lobby |
| `phase` is `results` | Results (Lobby once "Play again" is pressed) |
| `phase` is `playing` | Match HUD. Sub-state comes from `hud.local` / `hud.spectate`: alive HUD, death card, spectate bar, or "waiting" chip for mid-match joiners |

Overlays inside the match:
- **Click to play / Resume** shows when the local player is alive, `!hud.pointerLocked`, and neither Settings nor the
  death card is open. The first lock of each match says "Click to play". After that it says "Resume" (Esc pause).
  Clicking the button or anywhere on the dim backdrop calls `onResume()` inside the click handler. The UI never
  requests pointer lock itself.
- **Settings** can be opened from Title, Lobby and Pause. Esc or a backdrop click closes it, and focus returns to
  where it was.
- The **death card** opens on `playerKilled` with `isLocalVictim`. It collapses into the spectate bar once
  `hud.spectate` is set and `hud.deathScreenSeconds` (balance `match.deathScreenSeconds`) have passed, or right away
  when the player presses Spectate. If the field is missing, the spectate target appearing is the cue (ClientGame only
  starts spectating after that delay anyway).
- **Refused actions** (`actionFailed`, local only, not `fire`) show a short toast above the ammo box: warn glyph,
  dashed border, 1.6 s. A repeated press replaces its toast rather than stacking. Pickup refusals also nudge the prompt.

## 2. Wireframes

### Title
```
┌──────────────────────────── island orbit camera behind ───────────────────────────┐
│                                                                                   │
│                  ╔═[coral|cream|teal towel stripe]═══════════════╗                │
│                  ║   LAST ONE DRY           (logo, tilted, bob)  ║                │
│                  ║   The tide is rising. Your manners are not.   ║                │
│                  ║                                               ║                │
│                  ║   What's your castaway called?                ║                │
│                  ║   ┌─────────────────────────────────────────┐ ║                │
│                  ║   │ Your name                               │ ║  remembered    │
│                  ║   └─────────────────────────────────────────┘ ║  (bsp.name.v1) │
│                  ║   ⚠ Pick a name first      (only when invalid) ║                │
│                  ║   ┌─────────────── PLAY ────────────────────┐ ║                │
│                  ║   └─────────────────────────────────────────┘ ║                │
│                  ║                                  ⚙ Settings   ║                │
│                  ╚═══════════════════════════════════════════════╝                │
└───────────────────────────────────────────────────────────────────────────────────┘
```
Enter submits. The name is sanitised the same way the server does it (control characters stripped, trimmed, at most
`MAX_NAME_LENGTH` code points). An empty name shows an inline error with a warning glyph, a dashed red border and a
short shake (no shake with reduced motion), and focus stays in the field.

### Connecting / connection lost
```
        ╔═══════════════════════╗           ╔═══════════════════════════╗
        ║        (spinner)      ║           ║        (lifebuoy)         ║
        ║     Paddling in…      ║           ║ Lost at sea. Connection   ║
        ║                       ║           ║ dropped.                  ║
        ╚═══════════════════════╝           ║   [ Rejoin ]  / [ Retry ] ║
                                            ╚═══════════════════════════╝
```
Server reasons: `full` → `menu.connection.full`, `bad_version` → `menu.connection.version`, `bad_name` → back to
Title with the name error. Anything else → "lost" (if we had joined) or "failed".

### Lobby (left-aligned so the island stays visible)
```
┌────────────────────────────────────────────────────────────────────────┐
│ ╔═════════════════════════════╗                                        │
│ ║ Beach Lobby                 ║                                        │
│ ║ Mangomoon Isle              ║                                        │
│ ║           (7)               ║  ← countdown bubble: ink digits on an  │
│ ║      Match starts in 7      ║    accent circle, centred, pops 1.2×   │
│ ║                             ║    about its own centre each second    │
│ ║                             ║    ("Waiting for castaways…" before;   │
│ ║                             ║    at 0 the line reads the "Go!" text) │
│ ║ 3 in lobby                  ║                                        │
│ ║ ●●●▢▢▢▢▢▢▢▢▢   (12 seats)    ║  ● human (filled circle)              │
│ ║ ▢ Bots will fill the empty  ║  ▢ bot (dashed square)                │
│ ║   spots                     ║                                        │
│ ║ Controls  [WASD] Move …     ║                                        │
│ ║                 ⚙ Settings  ║                                        │
│ ╚═════════════════════════════╝                                        │
└────────────────────────────────────────────────────────────────────────┘
```
After "Play again" during results, the status line reads "Next match in N".

M1-fix: the old countdown number was a 4.2em text block as wide as the panel, and it popped from scale 1.35 about the
centre of that block. Its left-aligned digit was pushed past the panel's left edge, and the panel (`overflow: auto`)
clipped it. The bubble is now a fixed 2em circle centred in the panel, so it scales in place.

### In-match HUD (1280×720 reference; `--edge` ≈ 15 px)
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ┌kill feed (≤5, 6 s)──────────────────┐                     [(o) 9 alive] [★ Kills 2]     │
│ │ Pat splashed Sue with a Conch Pistol│                                ┌──────────────┐  │
│ │ ◎ Bea bopped Kim on the noggin …    │                                │   minimap    │  │
│ └─────────────────────────────────────┘                                │  N-up, ring  │  │
│                ┌──────────── ANNOUNCER BANNER ───────────┐             │  + next ring │  │
│                │      Here comes the tide!               │             └──────────────┘  │
│                └─────────────────────────────────────────┘     [≈ 2/6  Tide rising in 1:23]│
│                     ▲ [≈ Outside the safe sand!]  (arrow → safe zone)                     │
│                                                                                          │
│                         ╭─ damage arc (rotates to source) ─╮                             │
│                                    ╷                                                     │
│                                 ─  ·  ─   crosshair (gap = spread)                       │
│                                    ╵      + reload/heal ring                             │
│                              [Reloading…] / [Healing…][[Q] Cancel]                       │
│                                                                                          │
│                         [◆ [E] Pick up Longshore Rifle]                                  │
│                                                                     [● Pebbles  30]      │
│                        [(i) Press R to reload.]                        (pickup toasts)      │
│ ┌───────────────────────────┐ ①        ②        ③       ④      ┌──────────────────────┐   │
│ │ ♥ HEALTH ███████████  100 │ [⬡ DMR] [⯃ LMG] [○ Fists] [🍍 ×2]│            12 / 48   │   │
│ │[vest◆◆◇ 31/55][helm 9/30][🧍]│ [  8  ] [ 60  ]  ▼ active       │ [Q] [+Bandage 2]     │   │
│ └───────────────────────────┘                                  │     [⊞Medkit 1]      │   │
│                                                                └──────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
- Combat-critical items (crosshair, hit marker, damage arcs, ring) sit at the centre. Status is at the corners.
  Nothing animates unless it changed.
- While **dropping**, the crosshair and weapon slots hide. The prompt slot shows `hud.drop` (or the one-time
  `hint.drop`).
- While **dead or spectating**, vitals, slots and ammo hide. The bottom-centre spectate bar shows
  "Spectating {name}", their HP and "[Space] Next castaway".
- On **ultrawide** screens the HUD is clamped to a 2.2:1 box centred on screen, so corners stay near the centre of view.
- At **≤ 900 px wide or ≤ 560 px tall**, the minimap shrinks, the slots narrow and the controls list hides.

### Death card
```
            ╔══════════════════════════╗
            ║        (lifebuoy)        ║
            ║      Washed out!         ║
            ║   Eliminated by Pat      ║   or "Swept away by the tide" / "Gravity wins this round"
            ║       #7 of 12           ║
            ║        Kills 1           ║
            ║      [ Spectate ]        ║
            ╚══════════════════════════╝
```

### Results
```
            ╔════════════════════════════════════╗
            ║            (trophy)                ║
            ║   King of the Sandbar!  (tRandom   ║  win: results.win.*, loss: results.loss.*
            ║   Mango stayed dry!      variant)  ║
            ║    #1 of 12        Kills 4         ║
            ║ ┌────────────────────────────────┐ ║
            ║ │ ▶#1  Mango              ★ 4    │ ║  local row: accent fill + ▶ marker + outline
            ║ │  #2  Crabby Pat  [BOT]  ★ 3    │ ║  bots: dashed [BOT] tag
            ║ │  …                             │ ║
            ║ └────────────────────────────────┘ ║
            ║       Next match in 9              ║
            ║  [         Play again           ]  ║
            ╚════════════════════════════════════╝
```

### Click to play / Pause
```
  (dimmed backdrop: click anywhere = resume)
            ╔════════════════════════════════════╗
            ║            (mouse)                 ║
            ║  [        Click to play         ]  ║   "Resume" after the first lock in a match
            ║  Esc frees your mouse              ║
            ║  Controls                          ║
            ║  [WASD] Move      [Shift] Sprint   ║
            ║  [Space] Jump     [Mouse] Aim      ║
            ║  [LMB] Fire       [R] Reload       ║
            ║  [E] Pick up      [1/2/3] Switch   ║
            ║  [Q] Heal         [Esc] Release    ║
            ║                         ⚙ Settings ║
            ╚════════════════════════════════════╝
```

### Settings
```
            ╔════════════════════════════════════╗
            ║ Settings                           ║
            ║ Mouse sensitivity  ───●─────  1.00 ║  0.1–3, step 0.05   (Settings, contract)
            ║ Volume             ─────●───   80% ║  0–1                (Settings, contract)
            ║ ☐ Invert Y                         ║                     (Settings, contract)
            ║ Graphics quality                   ║  radio group        (Settings.quality, contract)
            ║ [ Low ] [✓Medium] [ High ]         ║  default medium; selected = fill + tick + thick border
            ║ UI size            ──●──────  100% ║  80–150 %           (UI-only pref)
            ║ ☐ Reduce motion                    ║  default = OS pref  (UI-only pref)
            ║                          [ Close ] ║
            ╚════════════════════════════════════╝
```
`Settings` persist in `localStorage['bsp.settings.v1']`. They are clamped on load, and `onSettingsChanged` fires once
after construction and then on every change. UI-only prefs live in `bsp.uiprefs.v1`. Storage errors (private mode)
are swallowed, and the settings still apply for the session. `quality` is always written (`'low' | 'medium' |
'high'`, unknown values load as `medium`); main.ts calls `renderer.setQuality` only when it changes.

**UI sounds:** Ui calls `UiCallbacks.playUiSound` from listeners on its own root (never `document`): `ui.click` on
button / checkbox / radio clicks (capture phase, so buttons that stop propagation still click; keyboard activation
counts), `ui.hover` when a mouse pointer enters a button, segment, check row or slider (45 ms throttle, no hover sound
for touch), and `ui.slider` on range input (70 ms throttle). Disabled controls are silent.

## 3. Visual language: "beach toys"

- **Panels:** sand `#f7e4b5`, a thick ink `#2a1d33` outline (≈3 px, matching the cel-shaded ink lines), a hard
  offset drop shadow (`0 0.25em 0 ink`) and generous rounded corners. Menu panels get a coral/cream/teal
  beach-towel stripe along the top.
- **HUD chips:** ink glass (`rgba(42,29,51,.82)`) with cream text. They read over bright sand, sky and sea.
- **Buttons:** chunky and pressable. Hover lifts them about 1 px and brightens them. Press pushes them down onto
  their shadow. Focus shows a 3 px teal ring with an offset. Disabled buttons are flat, dashed and greyed. Every
  state change takes ≤ 60 ms.
- **Type:** a system stack only, with no downloads. Display text uses `ui-rounded, "SF Pro Rounded",
  "Arial Rounded MT Bold", "Varela Round", "Nunito", system-ui…` at weight 800–900. Body text uses `system-ui…`.
  Numbers use `tabular-nums` so counters don't jitter.
- **Glyphs:** inline SVG masks in CSS (person, star, wave, eye, gear, warning, lifebuoy, trophy, mouse, target, bulb,
  heart, shield, lock). No image assets.
- **Tokens** (mirroring `palette.ui*`): accent `#ffc43d`, accent-2 `#2ec4b6`, health `#5ee06a`, armor `#4fa8ff`,
  danger `#ff3b5c` (`#a30f2c` when used as text on sand), tide `#46b8ff`.

## 4. Accessibility

**Contrast (WCAG AA, measured):**

| Text / background | Ratio |
|---|---|
| ink on sand | 12.6 |
| ink-soft on sand | 8.3 |
| ink on accent (buttons, active slot) | 10.0 |
| ink on tide stripes (light stripe) | 7.2 (9.4) |
| danger-text on sand (low ammo) | 6.3 |
| cream on ink glass (over white / over sky) | 8.6 / 10.1 |
| accent on ink glass (feed names) | 5.6 |
| blocked prompt text on ink glass | 5.9 |
| placeholder on cream | 4.8 |

**Colour is never the only signal:**

| Signal | Colour | Non-colour cue |
|---|---|---|
| Weapons / items | family colour | Shape per item: pistol ●, SMG ▲, shotgun ■, rifle ◆, fists ○ ring, LMG octagon, DMR hexagon, sniper ★; ammo light ●, heavy ◆, shell ■, sniper ★; bandage ✚, medkit ⊞; vests, helmets and the grenade use their STYLE §18 SVG silhouettes. The type name is always shown as text. |
| Armor tier | tier colour (denim / cobalt / slate) | 1–3 filled diamond pips, a different silhouette per tier, and "Lv.N" text in the prompt |
| Armor broken | — | Icon at 40 % with a diagonal ink slash, "Broken" text, and a warning toast |
| Empty armor slot | — | Dashed cell, greyed tier-1 silhouette, the slot name ("Vest" / "Helmet") |
| Stance | accent fill when crouched / prone | Different silhouette per stance (stand / crouch / prone); a progress underline during transitions |
| Cook ring last second | red | Thicker stroke, pulse, dashed border on the countdown chip |
| Grenade danger | red ring | Pineapple icon, pulsing ring, edge pointer arrow, size grows as it gets closer |
| Hit marker vest / helmet / break | armor blue | Dashed ring (vest), cap arc above the ticks (helmet), four shards flying out (break) |
| Grenade slot with 0 grenades | — | Dashed slot, desaturated icon, "×0" |
| Active weapon slot | accent fill | Raised and scaled up, a thicker outline, a ▼ pointer under the slot |
| Empty slot | — | Dashed outline plus the "Empty" label |
| Hit marker body / head / kill | white / yellow / red | Tick length grows (head < kill), the head adds a diamond "crown", the kill uses thicker ticks and a longer show time. |
| Damage taken vs tide damage | red / blue | Tide arcs are dashed. All arcs have an outward chevron. |
| Low health | red | Diagonal stripes plus a pulsing heart glyph |
| Low ammo / out of ammo | red text | Warning glyph plus the "Out of ammo!" text |
| Tide urgent / final | blue / yellow | Diagonal stripes, the wave glyph and text that changes |
| Outside the zone | blue vignette | A striped vignette pattern, a text banner and an arrow toward safe sand |
| Kill feed: my kill / my death | accent / red border | Solid thick border vs dashed border |
| Lobby humans vs bots | — | Filled circle vs dashed square |
| Standings: me / bots | accent row | ▶ marker and outline; dashed "BOT" tag |
| Pickup refused (vest at full armor) | — | Dashed chip plus a lock glyph plus the text |
| Loot tier (future: if tier is ever shown) | common white / rare blue / epic purple | Use circle / diamond / star and a text label (`loot.tier.*`), same rule |

**Reduced motion:** the `.is-reduced-motion` class is set from the OS `prefers-reduced-motion` media query by
default, and the Settings toggle can override it. It removes all translation, scaling, shaking, bobbing and looping
pulses. Opacity fades that carry information (hit marker, damage flash, feed and toast expiry) stay, but they are
short and linear.

**Scalable UI:** the root font-size is `clamp(12px, 0.9vmin + 7px, 20px) × --ui-scale` (UI size 80–150 %).
Everything is sized in `em`, and the canvas minimap re-rasterises on resize.

**Other:**
- Every control is a real `<button>` / `<input>` / `<label>`.
- Focus is visible on everything, and modals move focus in and restore it on close.
- `role="status"` / `aria-live` is used for the tide, banners and hints. `role="alert"` is used for the outside-zone
  warning and name errors.
- Buttons are at least 2.6em tall (≈44 px at default scale).
- `#ui-root` is `pointer-events: none`. Only `.ui-interactive` panels take the mouse.

**Input hints:** key glyphs are drawn as keycaps from `menu.controls.*.key`. The controls list appears on Lobby and
Click-to-play/Pause. One-time contextual hints are each shown once per browser (`bsp.hints.v1`):

| Hint | Trigger |
|---|---|
| `hint.drop` | First spawn |
| `hint.loot` | First pickup prompt |
| `hint.switch` | First gun picked up |
| `hint.reload` | Magazine 0 with reserve ammo |
| `hint.heal` | First weapon damage taken |
| `hint.tide` | First tide warning or first time outside the zone |
| `hint.ads` (M2a) | First time a gun with a sight is in hand after landing |
| `hint.crouch` (M2a) | First local shot fired |
| `hint.prone` (M2a) | First voluntary crouch |
| `hint.grenade` (M2a) | First grenade picked up |

**Touch (later, planned now):**
- The layout leaves the bottom corners as stick zones: vitals move to the top-left under the feed, and ammo moves
  next to the minimap.
- Context buttons for E / R / Q reuse the prompt and ring positions.
- All tap targets are already ≥ 44 px, and `env(safe-area-inset-*)` is respected.

**Key rebinding / colour-blind mode:**
- Key rebinding needs ClientGame to own a binding map. Proposed for M2 as a `Settings.bindings` field.
- No separate colour-blind mode in M1, because every cue above already has a non-colour channel.

## 5. Announcer and feed rules

| Moment | Source | Output |
|---|---|---|
| Match start | `matchPhaseChanged` → playing | `announcer.matchStart` (big) and a reset of feed, banners, HUD and death state |
| Local drop | `localPlayerSpawned` | `announcer.drop` |
| First elimination with a killer | `playerKilled` | `announcer.firstBlood` |
| Alive count crosses 10 / 5 / 3 (only if the match started above that number) | `hud.aliveCount` | `announcer.remain` |
| Alive count reaches 2 | `hud.aliveCount` | `announcer.finalTwo` (big) |
| Tide warning | `zoneWarning` | `announcer.tide.warning` (warn tone: blue stripes and wave glyph) |
| Tide starts shrinking / final collapse | `zoneChanged` | `announcer.tide.rising` / `announcer.tide.final` |

- Banners queue one at a time, 2.6 s each. Hints show for 5 s each.
- Kill feed groups: `zone` → `feed.zone.*`; `fall` → `feed.fall.*`; M2a `explosion` / weapon `grenade` → the
  victim's own grenade → `feed.grenadeSelf.*`, else `feed.grenade.*` (pineapple icon on both); no killer or no
  weapon → `feed.generic.*`; `fists` → `feed.melee.*`; headshot → `feed.headshot.*`; otherwise `feed.kill.*`.
- Self-grenade detection (`logic.isSelfGrenadeKill`): grenades.md credits a self-kill to the last enemy who hit
  the victim (or nobody), so `killerId` alone cannot tell. The Ui remembers the attacker of each victim's latest
  explosion damage; a kill with cause `explosion` is a self-kill when `killerId` is null or the victim, or that
  last blast attacker was the victim. The death card then reads `death.eliminatedBySelf`.
- The headshot flag comes from the last `playerDamaged` on that victim, because `playerKilled` has no headshot field.
  See §7.
- Names are inserted as text nodes (never `innerHTML`) and styled bold. A headshot adds a target glyph.

## 6. Performance rules (as built)

- `update(hud)` writes to the DOM only through diffing helpers (`TextSlot`, `Flags`, `Shown`, `StyleVar` in
  `src/ui/dom.ts`), so an unchanged value costs a string compare.
- It never reads layout. The viewport height is cached on `resize`, and the minimap size comes from a
  `ResizeObserver`.
- Bars, reload fill, crosshair gap and the ring use `transform` / CSS variables only, which composite and never
  trigger layout.
- One-shot animations restart by removing a class and re-adding it on the next rAF, with no forced reflow.
- The minimap redraws at 10 Hz. Its static layer (sea, coastline from `coastlineRadius`, grass, hills, POI names) is
  cached in an offscreen canvas and rebuilt only on map or size change.
- The feed, toasts and banners expire with CSS animations, and DOM nodes are removed on a timer. The feed holds at
  most 5 nodes and the toasts at most 3.

## 7. Contract fields used (Contract revision 1, ARCHITECTURE.md §12)

All are optional in the contract. The UI no longer guesses their values; while a field is absent it degrades as noted.

| Field | Use | While absent |
|---|---|---|
| `HudView.cameraFovDeg` | crosshair spread → px | crosshair stays at its resting gap |
| `HudView.deathScreenSeconds` | death card hold before spectate | card closes when `hud.spectate` appears |
| `HudView.spectate.targetMaxHp` | spectate HP bar scale | bar hidden, number only |
| `HudLocalView.healMax`, `reserveMax`, `ammoType` | prompt shows `hud.inventory.full` (blocked) before the press | normal pickup prompt; the sim's `actionFailed` toast still explains |
| `playerKilled.headshot` | kill feed headshot variant | last `playerDamaged.headshot` for that victim |
| M2a `localHitConfirmed.vest` / `helmet` | hit marker vest / helmet / break variants | n/a (required) |
| M2a `playerDamaged.vest/helmet.broken` (local victim) | broken toast + crossed-out icon | n/a (required) |
| M2a `interactPromptChanged.durability` / `refusal` | armor prompt "31/55", blocked prompt before the press | read with `?? null`: durability hidden; refusal predicted from HUD fields |
| M2a `HudView.ads` | crosshair → dot / red dot / scope overlay | hip crosshair |
| M2a `HudView.grenadeDanger` | danger icons | none |
| M2a `HudLocalView.vest/helmet/grenades/grenadeMax/cook/stance*` | gear panel, slot 4, cook ring, stance icon | defaults (empty, 0, stand) |
| `GameEvents.actionFailed` | refusal toast (key table in ARCHITECTURE §12) | nothing shown |
| `Settings.quality`, `UiCallbacks.playUiSound` | see Settings | n/a (Ui is the producer) |

Reserve is only known for the active weapon's ammo type, so a "full" ammo prompt shows only for that type.

**Low health.** The stripes and pulsing heart start at **30 HP or less** (absolute, `LOW_HP_THRESHOLD` in
`src/ui/logic.ts`), the same number audio uses for the heartbeat (REVIEW-M1 m5). Proposed for game-designer:
`player.lowHpThreshold: 30` in balance.json; revision 2 replaces both with the `localLowHealthChanged` bus event.
Damage feedback scales with max HP: a hit of 25 % of max HP or more draws the heavy arc, and 40 % drives the vignette
to full strength.

## 8. Strings used that are not in `en.json` yet (for narrative-designer)

Until these exist, `t()` falls back to the key.

| Key | Proposed text |
|---|---|
| `hud.tide.phase` | `Tide {index}/{count}` |
| `hud.heal.cancel` | `[Q] Cancel` |
| `lobby.matchInProgress` | `Match in progress. You're up next!` |
| `results.bot` | `Bot` |
| `menu.connection.full` | `The island is full. Try again soon.` |
| `menu.connection.version` | `The game was updated. Refresh the page.` |
| `menu.settings.uiScale` | `UI size` |
| `menu.settings.reducedMotion` | `Reduce motion` |
| `menu.settings.quality` | `Graphics quality` |
| `menu.settings.quality.low` | `Low` |
| `menu.settings.quality.medium` | `Medium` |
| `menu.settings.quality.high` | `High` |

## 9. QA checklist (for qa-tester)

**M2a additions**
- [ ] Settings: "Aim mode" Hold / Toggle (default Hold) and "ADS sensitivity" 0.10–3.00 (default 1.00) persist as
      `adsMode` / `adsSensitivity` in `bsp.settings.v1`. Saves from before M2a load as Hold / 1.00.
- [ ] Controls list (Lobby, Pause) shows RMB Aim down sights, C Crouch, Z Lie down, Space Jump / Stand up, 4 / G
      Grenade, Hold LMB Cook. No keycap overlaps its label at 1280×720.
- [ ] Hold RMB with pistol/SMG/shotgun: the crosshair closes into a cream dot. Rifle/LMG: a glowing red dot.
- [ ] DMR: after the zoom-in the full-screen 4x frame (red chevron, mil ticks, cornflower rim) iris-opens in 120 ms;
      sniper: the 8x frame (mil-dots, pink rim). The hip crosshair, prompt and hints hide while scoped. Releasing RMB
      fades it out in 80 ms. Reduced motion: fade only, no iris.
- [ ] Vest and helmet cells: tier pips match the tier, "cur/max" durability, the bar shrinks on hits and goes
      striped at 25 % or less. A break shows "Vest broken!" / "Helmet broken!" and a crossed-out icon for 2.5 s, then
      the dashed empty cell.
- [ ] Stance icon: stand / crouch / prone silhouettes; underline grows during a transition; accent fill when low.
- [ ] Slot 4: pineapple + "×N", dashed and grey at 0. Key 4 with 0 grenades shows "No grenades".
- [ ] Grenade in hand: "[LMB] Hold to cook" under the crosshair. Cooking: an orange ring that empties with a
      tenths countdown; at 1.0 s or less it turns red, thicker and pulsing.
- [ ] A live grenade within blast radius + 2 m shows a pineapple warning: under the crosshair when ahead, on the
      screen edge with a pointer otherwise; it grows as it gets closer and is visible through walls.
- [ ] Prompt on armor: "[E] Pick up Lifeguard Vest | ◆◆◇ Lv.2 31/55" ("Upgrade to" when a lower tier is worn);
      same-or-lower tier shows the blocked "Your vest is as good or better" with the lock glyph. Grenades at max
      carry: "Grenade pouch full!".
- [ ] Refusal toasts: C/Z under the hut roof → "No room to stand up"; in deep water → "Too deep here".
- [ ] Hit markers: vest hit = dashed blue ring, helmet hit = blue cap arc, break = shards.
- [ ] Kill feed: grenade kills show the pineapple and a `feed.grenade.*` line; your own grenade shows
      `feed.grenadeSelf.*` and the death card reads "Your own grenade got you".

**M1**

- [ ] Title: an empty or whitespace-only name shows the error and does not call `onJoin`. A valid name is trimmed,
      stored, and pre-filled after reload. Enter submits.
- [ ] Settings: values are clamped, persisted under `bsp.settings.v1`, and survive reload. `onSettingsChanged` fires
      once at startup and on each change. Esc and backdrop clicks close the panel, and focus returns.
- [ ] Settings: Graphics quality Low / Medium / High (arrow keys move within the group). The choice persists as
      `quality` in `bsp.settings.v1`; old saves without it load as Medium. The selected option has a tick, not only a
      fill.
- [ ] UI sounds: hover, click (mouse and keyboard) and slider drags each call `playUiSound` once; nothing on touch
      hover; disabled buttons are silent. The gear button and Resume button also click.
- [ ] Connecting → Lobby after welcome. Kill the server: "Lost at sea" + Rejoin works. A server `full` shows the full
      message.
- [ ] Lobby: the count and seat pips update, the countdown bubble pops each second, and "Bots will fill" is visible.
      At 1280×720 and UI size 150 % the bubble is centred and never clipped (including mid-pop); 10 fits inside it.
      At 0 the status reads the "Go!" line, not "starts in 0".
- [ ] Playing without pointer lock shows "Click to play". Clicking locks the pointer. Esc shows "Resume" plus Settings.
- [ ] HUD: HP and armor bars track `hud.local`, with a flash and a lagging ghost on damage and no ghost on heal. Low HP
      shows stripes at 30 HP or less (not at 31), at the same moment the audio heartbeat starts.
- [ ] Slots 1/2/3 show the active slot (raised + ▼). Mag counts and empty slots are dashed.
- [ ] Ammo shows `mag / reserve`, `∞` on fists and "Out of ammo!" at 0/0. The reload bar and ring fill. Healing
      shows the ring + "Healing…" + cancel hint.
- [ ] The crosshair widens while moving or jumping and hides while dropping or dead.
- [ ] Hit markers: body is white, head is yellow + crown, kill is a red long X. The vest-break ring appears.
- [ ] Damage arcs point at the attacker and keep pointing at the source as you turn. Tide arcs are dashed blue.
- [ ] Tide chip: "Tide rising in m:ss" while waiting, striped urgent style + clock while shrinking, and the final style.
      The outside-zone banner + arrow + vignette show only while outside.
- [ ] Minimap: coastline, POI names, current ring (solid) + next ring (dashed), self arrow matching facing.
- [ ] Kill feed: at most 5 entries, expiring after 6 s. Variant text matches the cause. Own kills and own death are
      marked.
- [ ] Pickup prompt: "Pick up", "Swap for" (both slots full) or "Grab N"; a vest at full armor is shown blocked.
      Toasts appear on pickup. At the carry limit (heals, or the active weapon's ammo) the prompt reads "Pockets full!"
      with the lock glyph.
- [ ] Refusals: Q with no heals / at full HP, E at the carry limit or on a weaker vest, R with no reserve each show
      one short dashed toast with a warn glyph. Spamming the key keeps one toast. An empty trigger pull shows none.
- [ ] Death card → Spectate → spectate bar with name / HP bar / "[Space] Next castaway". Without pressing Spectate the
      card holds for `match.deathScreenSeconds`. Headshot kills use the headshot feed variant.
- [ ] The browser tab title reads "Last One Dry".
- [ ] Results: win or loss banner variant, placement, kills, standings with the BOT tag and your row marked, next-match
      countdown. Play again shows the lobby.
- [ ] Reduced motion (OS setting or toggle): no bob, shake, pulse or slide. Hit markers still visible.
- [ ] UI size 80 % / 150 % at 1280×720 and 3440×1440: no overlap, and the HUD is clamped on ultrawide.
- [ ] Clicks pass through the HUD to the canvas everywhere except panels and buttons.

## 10. Files

| File | Purpose |
|---|---|
| `src/ui/Ui.ts` | `Ui implements IUi`: screen state machine, bus subscriptions, persistence |
| `src/ui/hud.ts` | In-match HUD component |
| `src/ui/screens.ts` | Title, Connect, Lobby, Play/Pause, Death, Results, Settings, controls list |
| `src/ui/feed.ts` | Kill feed, banner/hint message slots |
| `src/ui/minimap.ts` | Canvas minimap |
| `src/ui/icons.ts` | Shape + colour item glyphs; M2a SVG icons (armor tiers, grenade) |
| `src/ui/ads.ts` | M2a: centre sight reticles (iron, red dot) and the full-screen scope overlay (4x, 8x) |
| `src/ui/dom.ts` | DOM builders and diffing helpers |
| `src/ui/logic.ts` | Pure helpers (tested) |
| `src/ui/settings.ts` | Settings / prefs parse, clamp and storage (tested) |
| `src/ui/ui.css` | All styles |
| `src/ui/logic.test.ts`, `src/ui/settings.test.ts` | Vitest (node) |

## 11. M2a "Arsenal & Stance" (ARCHITECTURE §14 ui-ux-designer, STYLE.md §17–18)

### Bottom-left vitals
```
┌──────────────────────────────────┐
│ ♥ HEALTH ██████████████░░░   74  │
│ ┌────────────┐┌────────────┐┌──┐ │   vest / helmet cell: SVG icon over 1–3 pips │ "cur/max" over a bar
│ │[vest] 31/55││[helm]  9/30││🧍│ │   empty: dashed cell, grey tier-1 silhouette, "Vest" / "Helmet"
│ │◆◆◇  ▬▬▬░░ ││◆◇◇  ▬░░░░ ││▁▁│ │   broken (2.5 s): icon 40 % + ink slash, "Broken"
│ └────────────┘└────────────┘└──┘ │   stance: silhouette, accent when crouch/prone, underline = transition
└──────────────────────────────────┘
```
`armor` / `maxArmor` and the armor bar are gone. Durability text is `hud.gear.durability` with `ceil(durability)`.

### Centre
```
                  (over-shoulder ADS)          (scoped, full screen)
      ╷              ·  iron: cream dot        ████████████████████████
   ─  ·  ─           ◉  red dot: glow + ring   ███╭──────────────╮█████
      ╵                                        ██│   ───┼┼ ^ ┼┼───  │███  4x: chevron + mil ticks
   ╭──────╮  cook ring (fuse left)            ██│        ≡        │███  8x: mil-dot crosshair
   │  ·   │  [0.8 Release to throw]           ███╰──────────────╯█████  rim: 4x cornflower, 8x pink
   ╰──────╯                                    ████████████████████████
     (🍍)  danger icon when ahead; at the screen edge with a pointer otherwise
   [🪖 [E] Pick up Diving Helmet │ ◆◆◆ Lv.3 41/60]
```
- `logic.adsReticle(HudView.ads)`: no sight → hip crosshair. iron / red_dot → the hip crosshair's gap and opacity
  scale by `1 − cameraBlend` while the sight dot fades in by `cameraBlend`. Scopes → the same small dot while
  zooming, then the scope frame once `scoped`. Values are quantised to 1/50 so diffed writes stay rare.
- The scope frame is a sibling under the Ui root (below every HUD panel, above the canvas), full viewport (not the
  2.2:1 HUD box). One lens element with a 150vmax box-shadow paints the outside, so the iris is transform-only.
  While scoped, the pickup prompt and hints hide; feed, toasts, slots and vitals stay.
- Cook ring: `HudLocalView.cook`, radius just outside the reload ring; red, thicker and pulsing at ≤ 1000 ms
  (`COOK_URGENT_MS`). Countdown rounds up to tenths.
- Danger: `logic.dangerPlacement` — inside 85 % of the horizontal half-FOV the icon goes under the crosshair at the
  projected x; otherwise on an ellipse 64 px inside the HUD box. Scale 1 → 1.35 from 6 m to 0 m (presentation only;
  see requests).

### Slots
Four slots: 1–2 guns, 3 fists, 4 grenade (`item.grenade.type`, `hud.grenade.count`). The ammo panel shows "×N"
while the grenade is held.

### Settings
Mouse sensitivity · Invert Y · **Aim mode** (Hold / Toggle segmented, `menu.settings.mode.*`) · **ADS sensitivity**
(0.10–3.00, step 0.05) · Volume · Graphics quality · UI size · Reduce motion.

### Refusal toasts (ARCHITECTURE §14 table)
`betterArmor` → `hud.vest.better` / `hud.helmet.better` by the prompt item (fallback `hud.armor.better`);
`inventoryFull` on a grenade → `hud.grenade.full`; `noGrenades` → `hud.grenade.none`; `noHeadroom` →
`hud.stance.noRoom`; `tooDeep` → `hud.stance.tooDeep` (falls back to `hud.stance.proneWater` if missing).

### Open requests
- tech-lead / game-developer: `interactPromptChanged.maxDurability: number | null` (items.<id>.durability), so the
  armor prompt can always show "31/55". Until then the Ui learns the max from pieces it has worn, else shows "31".
- tech-lead / game-developer: `HudGrenadeDangerView.fuseRemainingMs` (HudView has no server clock), so the danger
  icon can blink faster near detonation. Distance-based scaling is used meanwhile.
- tech-lead / game-developer: `HudView.adsBlocked: 'sprinting' | 'reloading' | 'healing' | null` (RMB held but
  blocked), to show `hud.ads.*`. Not shown until then.
- narrative-designer: `menu.controls.cycle.key` "Wheel", `menu.controls.cycle.label` "Cycle weapons" (the controls
  list adds the row automatically once both exist).

## 12. Rooms & waiting room (M2b Addendum 2, design spec; build in Phase C after the tech-lead contract)

Replaces the single shared lobby (§1 flow, §2 "Lobby" wireframe) with a room browser and per-room waiting rooms.
The M2b map vote (maps.md §1) and the flight-route preview (drop addendum, 2b-C15) now live in the waiting room.
Everything below is UX; message names and server rules belong to tech-lead / network-engineer / game-designer.

### 12.1 Flow
```
 page load ──► Title (name) ──Play──► Connecting ──welcome──► Room browser ◄──────────────┐
   │ ?room=CODE (valid)                                       │  │  │                       │
   └► Title shows "Joining room ABCDE" chip ─Play─► join by code ┘  │  │                     │ Leave / kicked /
                                                   (fail → browser,  │  │                     │ room closed
                                                    code prefilled   │  │                     │
                                                    + inline error)  │  │                     │
             click a row ────────────────────────────────────────────┘  │                     │
             Join by code ──────────────────────────────────────────────┤                     │
             Create room ─► Create dialog ─Create──────────────────────►│                     │
                                                                         ▼                     │
                    ┌──────────────────────── Waiting room (lobby phase) ─────────────────────┤
                    │   host Start / auto-start (game-designer)                               │
                    ▼                                                                         │
             Countdown (still the waiting room: big map card + flight route + vote lock)      │
                    ▼                                                                         │
             Match: aboard carrier ► jump ► fall ► fight  (HUD §2, aboard HUD 2b-C15)          │
                    ▼                                                                         │
             Death card ► spectate ► Results ──Play again / timer──► Waiting room (same room) ─┘

 Joining a room whose match is running: Waiting room shows briefly → spectate camera on the running match with
 the "you're in the next match" chip → Results → Waiting room. Never dropped into a running match.
 Connection lost (anywhere after Title): Connection-lost screen ► Rejoin = reconnect + join the same room code;
 if the room is gone → Room browser + "The room closed" toast.
```
`selectScreen` gains the room location: `title | connecting | connectionLost | browser | room | match | results`
(`lobby` becomes `room`). `match` is chosen only when the local player is in the running match or spectating it.
Results "Play again" (`results.playAgain`) dismisses results early and shows the waiting room; when the results timer
ends the client is there anyway.

### 12.2 Room browser
```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ╔═[towel stripe]═════════════════════════════════════════════════════════════╗               │
│ ║ Pick a beach                                   [⟳ Refresh]   [+ Create room]║               │
│ ║                                                                            ║               │
│ ║ Have a code?  ┌──────────┐ [ Join ]                                        ║               │
│ ║               │ A B C D E│   ⚠ Codes skip 0, O, 1, I and L   (inline error)║               │
│ ║               └──────────┘                                                 ║               │
│ ║ ┌──────────────────────────────────────────────────────────────────────┐ ║               │
│ ║ │ ROOM                    MAP            PLAYERS   STATUS               │ ║  header row     │
│ ║ │▸Mango's room            ◆ Island       3/8       ● Waiting            │ ║  row = button   │
│ ║ │ Snack Attack            ▣ Office       8/8 FULL  ● Waiting      🔒    │ ║  full: dashed,  │
│ ║ │ Late-night splash       ◈ Vote         5/12      ▶ In match 3:12  👁   │ ║  lock glyph     │
│ ║ │ Desk Wars               ▣ Office       2/8       ◔ Starting           │ ║  in match: eye  │
│ ║ └──────────────────────────────────────────────────────────────────────┘ ║  glyph + notice │
│ ║  Bots fill the empty spots.                                  ◂ Back      ║               │
│ ╚════════════════════════════════════════════════════════════════════════════╝               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Rows** are real `<button>`s in a `role="list"`; the whole row is the hit target (≥ 2.6em tall). Order is the
  server's (proposed: waiting before in-match, then most humans). Map uses the short names `lobby.vote.island` /
  `lobby.vote.office` / `room.map.vote` plus a shape glyph (◆ island, ▣ office, ◈ vote). Status uses glyph + text:
  ● Waiting, ◔ Starting (countdown), ▶ In match m:ss (client ticks the elapsed time between list updates), ▶ Wrapping up
  (results).
- **Full rooms** are listed but disabled (`aria-disabled`, dashed, lock glyph, "FULL" tag, click = `browser.error.full`
  toast). **In-match rooms** are joinable; a second line under the row on hover/focus reads `browser.notice.inMatch`.
- **Loading** (before the first list): 3 skeleton rows with a shimmer (static with reduced motion) and
  `browser.loading`. **Empty** state:
  ```
  ║ ┌──────────────────────────────────────────────┐ ║
  ║ │      (beach umbrella glyph)                  │ ║
  ║ │   No open rooms yet. Start one!              │ ║
  ║ │            [+ Create room]                   │ ║   primary, gets focus
  ║ └──────────────────────────────────────────────┘ ║
  ```
- **Refresh** asks for a fresh list (the list also live-updates, throttled by the server). The button spins for at
  least 400 ms and is disabled for 1 s after a press. **Create room** is disabled with `browser.error.roomLimit` as
  its tooltip/sub-label when `canCreate` is false.
- **Join by code field**: `inputmode="text"`, `autocapitalize="characters"`, `autocomplete="off"`,
  `spellcheck="false"`, `maxlength` 7 (spaces and dashes are allowed while typing and stripped). Text is upper-cased
  as you type and shown letter-spaced in a monospace-ish display font.
  - Client validation on Join/Enter (pure, tested `normalizeRoomCode`): empty → no-op; wrong length →
    `browser.code.error.length`; a character outside the alphabet → `browser.code.error.chars` (names the excluded
    characters, since a player who types O or 0 needs to know why).
  - Server errors arrive as `roomJoinFailed` and show inline under the field (same style as the name error:
    warn glyph, dashed red border, short shake): `notFound` → `browser.error.notFound {code}`, `full` →
    `browser.error.full`, `closed` → `browser.error.closed`, `rateLimited` → `browser.error.rateLimited`.
  - A room that is mid-match is **not an error**: the join succeeds and the waiting room shows the
    `lobby.matchInProgress` chip while you spectate.
  - While a join is in flight the Join button shows a spinner and the field is read-only (`pending: 'join'`).
- **Back** returns to the Title (to change name; this disconnects).

### 12.3 Create-room dialog (also the host's "Room settings" dialog)
```
            ╔══════════════════════════════════════╗
            ║ New room                             ║   "Room settings" when editing
            ║ Room name                            ║
            ║ ┌──────────────────────────────────┐ ║   default "{name}'s room", maxlength = limits.roomNameMax
            ║ │ Mango's room                     │ ║   sanitised like names (control chars, trim)
            ║ └──────────────────────────────────┘ ║   ⚠ Give your room a name   (empty after trim)
            ║ Who can join                         ║
            ║ [✓ Public ] [ Private (code only) ]  ║   segmented radio (ui-seg), tick + fill
            ║ Map                                  ║
            ║ [◆ Island] [▣ Office] [✓◈ Vote]      ║   pinned by server: all disabled + "Pinned by server"
            ║ Max players  ──────●────  8          ║   range limits.maxHumansMin..Max
            ║ ☑ Fill with bots                     ║   only if game-designer adds the toggle
            ║                [ Cancel ] [ Create ] ║   Create shows a spinner while pending
            ╚══════════════════════════════════════╝
```
- `role="dialog"`, `aria-modal`, focus starts in the name field, Tab is trapped, Esc / backdrop = Cancel, focus
  returns to the opener. Enter in the name field submits.
- Server refusal (`roomCreateFailed`): `roomLimit` / `rateLimited` / `badSettings` show inline above the buttons;
  the dialog stays open with the values kept.
- Editing (host, waiting room, `lobby` phase only): same dialog, title `room.settings.title`, button
  `room.settings.save`; Max players cannot go below the current human count (the slider minimum moves up).

### 12.4 Waiting room
Left-aligned panel so the island/office orbit camera stays visible (same as the M1 lobby), plus a map card on the
right.
```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ╔═[stripe]═══════════════════════════╗                    ╔══════════════════════════════╗   │
│ ║ Mango's room            [Private]  ║                    ║ Vote for the next map        ║   │
│ ║ ROOM CODE                          ║                    ║ ┌────────┐┌────────┐┌───────┐║   │
│ ║ ┌──────────────┐ [⧉ Copy] [🔗 Link]║                    ║ │◆ Island││▣ Office││? Random│║   │
│ ║ │ K 7 M Q 2    │   ✓ Copied!       ║                    ║ │Votes: 2││Votes: 1││Votes:0 │║   │
│ ║ └──────────────┘                   ║                    ║ │✓ Your  ││        ││        │║   │
│ ║ 3/8 players · 2/3 ready            ║                    ║ │  vote  ││        ││        │║   │
│ ║ ┌────────────────────────────────┐ ║                    ║ └────────┘└────────┘└───────┘║   │
│ ║ │ 👑 Mango (you)        ✓ Ready  │ ║                    ║ No votes? The maps take turns║   │
│ ║ │    Pat                ✓ Ready  │ ║  [×] host only     ╚══════════════════════════════╝   │
│ ║ │    Sue                ○ Not ready [×]                  (fixed map instead: map card with   │
│ ║ │    ·· bot seats ×5 (dashed) ··  │ ║                     name, tagline, small minimap,       │
│ ║ └────────────────────────────────┘ ║                     "Map: Mangomoon Isle")              │
│ ║ Bots will fill the empty spots     ║                                                        │
│ ║ ── host ──────────────────────────  ║                                                        │
│ ║ [ ⚙ Room settings ]  [ ▶ Start match ]                                                      │
│ ║ ── non-host ──────────────────────  ║                                                        │
│ ║ ⏳ Waiting for host…  [ ✓ I'm ready ]║                                                       │
│ ║ Controls [WASD] Move …  (compact)  ║                                                        │
│ ║ [⟵ Leave room]           ⚙ Settings║                                                        │
│ ╚════════════════════════════════════╝                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Code**: 5 characters in a 2.4em display font with letter-spacing, on cream with an ink outline (copyable text,
  `user-select: all`). **Copy** writes the code with `navigator.clipboard.writeText` (inside the click gesture); the
  button flips to "✓ Copied!" for 1.5 s and a polite live region says it. Failure (no clipboard permission) selects
  the code text and shows `room.code.copyFailed`. **Link** copies `location.origin + pathname + ?room=CODE`.
- **Player list** (`<ul>`): humans in join order (host first is not forced; the crown marks the host). Each row:
  crown glyph + `room.host` sr-text for the host, the name (`(you)` = `room.you`), and the ready state as glyph + text
  (✓ `room.ready` filled accent chip / ○ `room.notReady` dashed chip; never colour alone). Members spectating the
  running match get an eye glyph + `room.watching`. Below, one dashed "bot seat" pip per seat bots will fill
  (reuses the M1 seat pips).
- **Kick** (host only, if the server supports it): a small [×] per non-host row, `aria-label` `room.kick.aria {name}`.
  Two-step: the first press turns it into "Kick?" for 3 s, the second press kicks.
- **Ready**: non-hosts and the host have a toggle button (`aria-pressed`): `room.readyToggle` / `room.unready`. The
  count line `room.readyCount` shows ready/total humans.
- **Host controls**: Start (`room.start`, primary; disabled with the reason as sub-label when `canStart` is false),
  Room settings (opens §12.3). Non-hosts see `room.waitingHost` with a slow-pulsing hourglass glyph (static with
  reduced motion). Auto-start (if game-designer adds it) shows `room.autoStart.allReady` / `room.autoStart.timer`
  with seconds, for everyone, under the list.
- **Map panel**: `mapMode` fixed → map card: `map.<id>.name`, `map.<id>.tagline`, a small minimap render,
  `lobby.map`. `mapMode` vote → the M2b vote panel (`lobby.vote.*`): three buttons (radio semantics,
  `aria-pressed`), live `lobby.vote.count`, your choice = tick + `lobby.vote.yours` + thick border,
  `lobby.vote.rotate` when no votes. Server pin → panel disabled + `lobby.map.pinned`.
- **Leave** (`room.leave`) is immediate during `lobby` / `results`. During countdown it asks once
  (`room.leave.confirm`, two-step like Kick), since leaving forfeits the match seat. Leaving focuses the browser's
  code field.
- **Spectating a running match** (joined mid-match): the waiting-room panel is replaced by the match HUD in
  spectate mode with a top chip `lobby.matchInProgress` + `room.name` and a [Leave room] button in the pause overlay.

### 12.5 Countdown, flight-route preview and match start (seen from the waiting room)
```
│ ╔═ compact room panel ═══╗        ╔═══════════════ map card (grows to ~45vmin) ═══════════════╗ │
│ ║ Mango's room  K7MQ2    ║        ║  Next map: The Open Plan            Parcel Pal · Delivery  ║ │
│ ║ 👑 Mango ✓  Pat ✓ Sue ○║        ║  ┌──────────────────────────────────┐   drone              ║ │
│ ║                        ║        ║  │   minimap (office walls/desks)   │                      ║ │
│ ║        ( 7 )           ║        ║  │  ╌╌╌╌╌╌╌╌✈╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌►   │  dashed route, carrier║ │
│ ║  Match starts in 7     ║        ║  │                                  │  icon at the start,   ║ │
│ ║ [⟵ Leave room]         ║        ║  └──────────────────────────────────┘  arrow = heading     ║ │
│ ╚════════════════════════╝        ║  Flight path                                               ║ │
│                                   ╚════════════════════════════════════════════════════════════╝ │
```
- On `countdown` the panel compacts (list collapses to one line of name chips, code stays small, host controls and
  Ready hide) and the map card grows. The countdown bubble (M1 lobby bubble, pops each second) and
  `lobby.countdown` sit in the panel.
- Vote rooms: until the lock the vote panel stays live; at the lock the panel flips to the map card with the
  banner `lobby.vote.locked {name}` (or `lobby.vote.lockedRandom`), announced via the banner slot.
- The route appears as soon as the client has it (route in match state, 2b-C12): dashed line across the minimap,
  the carrier icon (seaplane / drone silhouette) at the entry edge with a heading arrow, label `hud.minimap.route`
  and `map.<id>.carrier` · `map.<id>.carrier.type`. Before the map is resolved the card shows the route only once
  the map is known. If the client is still building the map at the drop: chip `lobby.map.loading` with a spinner.
- At `playing`: the waiting room fades out (160 ms, none with reduced motion), the Click-to-play overlay appears
  if the pointer is not locked, then the aboard HUD (2b-C15) with `announcer.flight.<map>.takeoff`.

### 12.6 Keyboard and accessibility
- Everything is reachable with Tab in visual order. Browser: code field → Join → Refresh → Create → rows → Back.
  Rows also support ↑/↓ (roving tabindex) and Enter/Space to join. Waiting room: Copy → Link → (Kick buttons) →
  Ready / Start → Settings → Leave.
- On arriving: browser focuses the code field (or Create in the empty state); waiting room focuses Ready (non-host)
  or Start (host); a dialog focuses its first field; errors keep focus in the field with `aria-invalid` +
  `aria-describedby`.
- Live regions: the room count changes are announced politely at most once per 5 s ("{count} rooms");
  member joins/leaves, host changes, copy result and countdown (at 10, 5, 3, 2, 1) are polite; errors use
  `role="alert"`.
- Non-colour cues: host = crown glyph + sr text; ready = tick vs hollow circle + text; full = lock + dashed + tag;
  in match = eye/play glyph + text; selected vote/settings = tick + thick border; disabled = dashed + sub-label.
- Contrast: same tokens as §4 (ink on sand 12.6, cream on ink glass 8.6+). The code display is ink on cream (13+).
- Reduced motion: no shimmer, no pulse, no shake, no panel grow animation (instant layout swap).
- Single-key shortcuts are not used in menus (they would clash with typing names and codes).

### 12.7 Mobile and narrow widths (≤ 600 px, and touch later)
- Browser: header actions wrap under the title; the code field + Join go full width at the top; the table becomes
  stacked cards (name on line 1; map glyph + name, players, status chips on line 2); Create becomes a sticky bottom
  button. Rows stay ≥ 44 px.
- Waiting room: single column: code card → map card / vote (3 buttons in a row, icons over text) → player list →
  sticky bottom bar with Ready/Start and Leave. The compact controls list hides (as today ≤ 900 px).
- Dialog: full-screen sheet, buttons sticky at the bottom; `env(safe-area-inset-*)` respected.
- Code input uses `inputmode="text"` with `autocapitalize="characters"` so mobile keyboards start in caps.

### 12.8 Toasts and notices
Room toasts use the existing toast stack (§2), bottom-right; on the browser screen they show top-centre. Refusals
and losses use the warn style (dashed + warn glyph), news uses the plain style.

| Moment | Source | Text | Style / where |
|---|---|---|---|
| Disconnected | `connectionStatus` | existing Connection-lost screen; Rejoin rejoins the same code | screen |
| Kicked | `roomLeft {reason:'kicked'}` | `room.toast.kicked` | warn, browser |
| Room closed (rejoin / race) | `roomLeft {reason:'closed'}` or `roomJoinFailed closed` | `room.toast.closed` | warn, browser |
| Host migrated | `roomHostChanged` | `room.toast.youHost` (you) / `room.toast.hostMigrated {name}` | plain; you also get focus moved to Start |
| Player joined / left | `roomMemberChanged` | `room.toast.joined {name}` / `room.toast.left {name}` | plain, waiting room only, throttled (max 1 per 2 s, then "+N") |
| Host changed settings | `roomSettingsChanged` | `room.toast.settings` | plain |
| Create / join refused | `roomCreateFailed` / `roomJoinFailed` | inline errors (§12.2–12.3) | inline |

### 12.9 Deep link `?room=CODE`
- Parsed once at load with the same `normalizeRoomCode` (case-insensitive, spaces/dashes stripped). Valid → the
  Title shows a chip `browser.deepLink {code}` with a small [×] to cancel; Play then connects and joins by code
  without stopping at the browser. Invalid → ignored, and the browser shows `browser.deepLink.invalid` once.
- On join failure: browser with the code prefilled in the field and the inline error.
- While in a room the URL is kept in sync with `history.replaceState` (`?room=CODE`, other params such as `?map=`
  kept), so a reload rejoins the same room; leaving removes the param. `?map=` still pre-selects your vote when you
  join a vote room (maps.md rule 2).

### 12.10 View model needed from the client (for the tech-lead to put in contracts.ts)
Additions to `HudView` (built by ClientGame from lobby messages; continuous state, so not events):
```ts
/** M2b rooms. Map ids are MapData ids ('island01' | 'office'). */
export type RoomId = string;
export type RoomMapMode = MapId | 'vote';                 // MapId = 'island01' | 'office'
export type MapVoteOption = MapId | 'random';

export interface HudView {
  // ...existing fields; `phase`, `countdownSecondsLeft`, `resultsSecondsLeft`, `lobbyCount`, `targetPlayers`
  // now describe the local player's ROOM (lobby phase when in the browser).
  rooms: RoomsView;
}

export interface RoomsView {
  /** Where the server has this client. 'none' before welcome. */
  location: 'none' | 'browser' | 'room';
  browser: RoomBrowserView | null;   // non-null iff location === 'browser'
  room: RoomView | null;             // non-null iff location === 'room'
  /** A lobby request in flight (button spinners / read-only fields). Cleared by its reply event. */
  pending: 'create' | 'join' | 'leave' | 'start' | 'settings' | null;
}

export interface RoomBrowserView {
  /** false until the first list arrives (skeleton rows). */
  loaded: boolean;
  /** Public rooms only, in server order. */
  rooms: RoomListEntryView[];
  /** false when the server is at MAX_ROOMS (Create disabled). */
  canCreate: boolean;
  limits: RoomLimitsView;
}

export interface RoomListEntryView {
  id: RoomId;
  name: string;                       // already sanitised by the server
  mapMode: RoomMapMode;
  /** Map of the running/locked match, else null. */
  mapId: MapId | null;
  humans: number;
  maxHumans: number;
  status: 'waiting' | 'countdown' | 'playing' | 'results';
  /** Whole seconds since the match started (client-ticked between updates); null unless 'playing'. */
  elapsedSeconds: number | null;
}

export interface RoomLimitsView {
  roomNameMax: number;
  maxHumansMin: number;
  maxHumansMax: number;
  maxHumansDefault: number;
  codeLength: number;                 // 5
  codeAlphabet: string;               // e.g. '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  /** Server MAP env pin, or null. */
  pinnedMapId: MapId | null;
  /** Present only if game-designer adds the "fill with bots" toggle. */
  botsFillToggle: boolean;
}

export interface RoomView {
  id: RoomId;
  code: string;                       // upper case, codeLength chars
  name: string;
  isPublic: boolean;
  mapMode: RoomMapMode;
  maxHumans: number;
  botsFill?: boolean;                 // only with the toggle
  hostId: PlayerId;
  isLocalHost: boolean;
  /** Humans in join order (oldest first). */
  members: RoomMemberView[];
  /** Bot seats that will be filled at start (dashed pips). */
  botSeats: number;
  localReady: boolean;
  /** Local player joined mid-match and is watching the running match. */
  localSpectating: boolean;
  /** Host may press Start now (host && phase 'lobby' && >= 1 human). */
  canStart: boolean;
  /** Auto-start (game-designer), else null. */
  autoStart: { reason: 'allReady' | 'timer'; secondsLeft: number } | null;
  /** null when mapMode is a fixed map. */
  vote: MapVoteView | null;
  /** Resolved map for the next/current match: fixed map, or the vote result after the lock; null before. */
  map: { id: MapId; via: 'fixed' | 'vote' | 'random' | 'rotation' | 'pinned' } | null;
  /** The client has not finished building `map` (loading chip). */
  mapLoading: boolean;
}

export interface RoomMemberView {
  id: PlayerId;
  name: string;
  isHost: boolean;
  isLocal: boolean;
  ready: boolean;
  /** In the running match (alive or dead) vs waiting/spectating for the next one. */
  inMatch: boolean;
  spectating: boolean;
}

export interface MapVoteView {
  /** Always the three options in this order: island01, office, random. */
  options: { option: MapVoteOption; count: number }[];
  mine: MapVoteOption | null;
  /** Voting closed for this match (mapVoteLockSeconds before the drop, or pinned). */
  locked: boolean;
  pinned: boolean;
}
```
Flight route for the countdown preview (2b-C15; listed here so it lands in the same contract round):
`HudMinimapView.route: { from: Vec2; to: Vec2; carrier: { pos: Vec2; heading: number } | null } | null`, set from
the moment the client knows the route (countdown) until the carrier leaves.

New `UiCallbacks` (Ui → ClientGame intents; every one is ignored if not valid in the current state):
```ts
onJoin(name: string): void;                          // unchanged name; now lands in the browser
onRefreshRooms?(): void;
onCreateRoom?(s: { name: string; isPublic: boolean; mapMode: RoomMapMode; maxHumans: number; botsFill?: boolean }): void;
onJoinRoom?(target: { id: RoomId } | { code: string }): void;   // code already normalised
onLeaveRoom?(): void;
onSetRoomSettings?(patch: Partial<{ name: string; isPublic: boolean; mapMode: RoomMapMode; maxHumans: number; botsFill: boolean }>): void;
onStartMatch?(): void;
onSetReady?(ready: boolean): void;
onVote?(option: MapVoteOption): void;
onKick?(playerId: PlayerId): void;                   // only if the server supports kick
```
`onPlayAgain` keeps its meaning (dismiss results → waiting room).

### 12.11 GameEvents expected (discrete moments only)
```ts
roomJoined: { roomId: RoomId; code: string; asHost: boolean; spectating: boolean };
roomJoinFailed: { reason: 'notFound' | 'full' | 'closed' | 'rateLimited' | 'badCode'; code: string | null };
roomCreateFailed: { reason: 'roomLimit' | 'rateLimited' | 'badSettings' };
roomLeft: { reason: 'left' | 'kicked' | 'closed' };
roomHostChanged: { hostId: PlayerId; hostName: string; isLocal: boolean };
roomMemberChanged: { playerId: PlayerId; name: string; change: 'joined' | 'left' };
roomSettingsChanged: { byHost: true };               // waiting-room toast only
mapVoteLocked: { mapId: MapId; via: 'vote' | 'random' | 'rotation' | 'pinned' };
```
Existing events keep working per room: `matchPhaseChanged`, `countdown`, `matchEnded`, `connectionStatus`.

### 12.12 String keys
**Existing, reused:** `menu.play`, `menu.connecting`, `menu.connection.*`, `lobby.botsFill`, `lobby.countdown`,
`lobby.matchInProgress`, `lobby.map`, `lobby.map.pinned`, `lobby.vote.title`, `lobby.vote.cast`,
`lobby.vote.island`, `lobby.vote.office`, `lobby.vote.random`, `lobby.vote.count`, `lobby.vote.yours`,
`lobby.vote.rotate`, `map.<id>.name|tagline|carrier|carrier.type`, `hud.minimap.route`, `results.playAgain`,
`results.nextMatch`, `menu.settings.open`, `announcer.flight.<map>.*`.
Note: vote options are map ids (`island01`) but the keys are `lobby.vote.island`; Ui maps `island01 → island`
explicitly (no key derived from the id).

**Missing (narrative-designer), proposed text:**

| Key | Proposed text |
|---|---|
| `browser.title` | Pick a beach |
| `browser.loading` | Looking for rooms… |
| `browser.empty` | No open rooms yet. Start one! |
| `browser.count` | {count} rooms |
| `browser.refresh` | Refresh |
| `browser.create` | Create room |
| `browser.back` | Back |
| `browser.col.name` | Room |
| `browser.col.map` | Map |
| `browser.col.players` | Players |
| `browser.col.status` | Status |
| `browser.players` | {count}/{max} |
| `browser.full` | Full |
| `browser.status.waiting` | Waiting |
| `browser.status.countdown` | Starting |
| `browser.status.playing` | In match {time} |
| `browser.status.results` | Wrapping up |
| `browser.row.aria` | Join {name}: {map}, {count} of {max} players, {status} |
| `browser.notice.inMatch` | Match in progress. You'll watch, then play the next one. |
| `browser.code.label` | Have a code? |
| `browser.code.placeholder` | ABCDE |
| `browser.code.join` | Join |
| `browser.code.error.length` | Room codes are {length} characters. |
| `browser.code.error.chars` | Room codes never use 0, O, 1, I or L. |
| `browser.error.notFound` | No room with code {code}. |
| `browser.error.full` | That room is full. |
| `browser.error.closed` | That room just closed. |
| `browser.error.rateLimited` | Easy there! Try again in a moment. |
| `browser.error.roomLimit` | Every beach is busy. Join a room instead. |
| `browser.error.badSettings` | Those room settings didn't work. Check them and try again. |
| `browser.deepLink` | Joining room {code} |
| `browser.deepLink.cancel` | Don't join |
| `browser.deepLink.invalid` | That room link looks broken. |
| `room.create.title` | New room |
| `room.create.name` | Room name |
| `room.create.nameDefault` | {name}'s room |
| `room.create.nameInvalid` | Give your room a name. |
| `room.create.visibility` | Who can join |
| `room.create.public` | Public |
| `room.create.private` | Private (code only) |
| `room.create.map` | Map |
| `room.create.maxHumans` | Max players |
| `room.create.bots` | Fill with bots (only if the toggle ships) |
| `room.create.submit` | Create |
| `room.create.cancel` | Cancel |
| `room.settings.title` | Room settings |
| `room.settings.save` | Save |
| `room.map.vote` | Vote |
| `room.public` | Public |
| `room.private` | Private |
| `room.code.label` | Room code |
| `room.code.copy` | Copy |
| `room.code.copied` | Copied! |
| `room.code.copyFailed` | Couldn't copy. Select the code instead. |
| `room.link.copy` | Copy invite link |
| `room.players` | {count}/{max} players |
| `room.readyCount` | {ready}/{count} ready |
| `room.host` | Host |
| `room.you` | (you) |
| `room.ready` | Ready |
| `room.notReady` | Not ready |
| `room.watching` | Watching |
| `room.readyToggle` | I'm ready |
| `room.unready` | Not ready yet |
| `room.start` | Start match |
| `room.start.needHuman` | Needs at least one player |
| `room.waitingHost` | Waiting for host… |
| `room.autoStart.allReady` | Everyone's ready! Starting in {seconds} |
| `room.autoStart.timer` | Auto-start in {seconds} |
| `room.kick` | Kick |
| `room.kick.confirm` | Kick? |
| `room.kick.aria` | Kick {name} |
| `room.leave` | Leave room |
| `room.leave.confirm` | Leave? You'll miss this match. |
| `room.toast.kicked` | The host removed you from the room. |
| `room.toast.closed` | The room closed. |
| `room.toast.hostMigrated` | {name} is the host now. |
| `room.toast.youHost` | You're the host now! |
| `room.toast.joined` | {name} joined |
| `room.toast.left` | {name} left |
| `room.toast.more` | +{count} more |
| `room.toast.settings` | The host changed the room settings. |
| `lobby.vote.locked` | Next map: {name} |
| `lobby.vote.lockedRandom` | Next map: {name} (random) |
| `lobby.map.loading` | Loading map… |

`lobby.title` ("Beach Lobby") and `lobby.players` are no longer used once rooms ship (the room name and
`room.players` replace them); narrative-designer may keep or delete them.

### 12.13 QA checklist additions (rooms)
- [ ] Title → Play → browser (loading skeleton → list or empty state). Create → dialog → waiting room as host with
      a 5-character code; Copy and Link work (and fail gracefully without clipboard permission).
- [ ] Join by code: lower case and dashes accepted; "0", "O", "1", "I", "L" rejected with the alphabet message; wrong
      length message; unknown code, full room and closed room show inline errors; a mid-match room joins and
      spectates, then lands in the waiting room after results.
- [ ] Private rooms never appear in a second client's list; joinable by code.
- [ ] Waiting room: crown on the host, ready tick toggles for everyone, Start only for the host, "Waiting for host…"
      for others; host leaves → oldest human gets the crown and the "You're the host now!" toast.
- [ ] Vote room: live tallies, your vote ticked, lock banner "Next map: …"; fixed-map room shows the map card.
- [ ] Countdown: compact panel, big map card with the dashed route and carrier icon; match starts in the plane.
- [ ] Results → Play again (or timer) → same waiting room, same code. Leave → browser, URL `?room=` removed.
- [ ] `?room=CODE` → Title chip → Play joins directly; bad link → ignored with a notice; reload inside a room rejoins.
- [ ] Kicked / room closed toasts; disconnect → Connection lost → Rejoin returns to the same room.
- [ ] Keyboard only: every action reachable; arrows move between rows; dialogs trap focus and Esc closes; screen
      reader reads host, ready and full states as text. 360 px wide: stacked cards, sticky bottom actions.

## 13. First person (M2b Addendum 3, design spec; build in Phase C)

On foot, freefall and parachute are first person (FP) from the sim eye point; the viewmodel (chibi arms + held
item) is rendered by graphics-engineer in its own pass. Third person remains for the carrier orbit, the death cam
and (optionally) results. There is no 3P toggle on foot. This section changes what §2, §11 and the M2a crosshair
rules say for the on-foot case.

### 13.1 Crosshair and reticles
| State | Centre of screen (Ui) | Notes |
|---|---|---|
| FP hip fire, gun | True centre reticle: 4 ticks + 4 px dot; gap = `spreadToPx(crosshairSpreadDeg, cameraFovDeg, viewportH)` | The camera is at the eye = hitscan origin, so the reticle is exact. `cameraFovDeg` must be the **vertical** FOV actually rendered (after the user's FOV setting and ADS zoom). The gap still grows with move/jump/stance exactly like the sim cone. |
| FP hip, fists | dot only (ticks hidden) | no spread to show |
| FP hip, grenade in hand | dot only; cook ring + "[LMB] Hold to cook" as in §11 | arc preview is the renderer's |
| FP ADS iron / red_dot | **nothing** (hip reticle fades out by `cameraBlend`, no Ui dot) | The viewmodel's own sight is the aim: the rear/front sight or the optic's red dot (render, STYLE §17 colours) lands on the centre. The M2a `SightReticle` is not shown in FP. |
| FP ADS scope, zooming in | hip reticle fades by `cameraBlend`, no dot | viewmodel raises the scope |
| FP scoped | full-screen scope overlay (§11, unchanged); viewmodel hidden by render | |
| Freefall / chute | no reticle (as `dropping` today) | `hud.drop` / chute prompts |
| Spectating, FP | 4 px centre dot only, 60 % opacity | we do not know the target's spread; the dot just marks where they look |
| Spectating, chase / aboard orbit / death cam | none | |

Logic change (`adsReticle`): it takes the camera view. In `firstPerson`, `dot` is always null and the hip
reticle's opacity and gap scale by `1 − cameraBlend` for every sight; scoped behaviour is unchanged. The 3P
behaviour from §11 stays for any future 3P aiming. Hit markers, the reload/heal ring, cook ring and damage arcs stay
centred; damage arcs keep using the camera yaw (now the eye yaw).

### 13.2 HUD layout with a viewmodel
The viewmodel fills roughly the lower-right quadrant (hands and gun from about x 45–95 %, y 55–100 %), and moves to
the centre in ADS. So the bottom centre is no longer free:
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ kill feed                                    banner                  [9 alive][Kills 2]  │
│                                                                          minimap        │
│                                                                          tide chip      │
│                                  ╷                                                       │
│                               ─  ·  ─        (hit marker, rings, danger icons)          │
│                                  ╵                                                       │
│                    [🪖 [E] Pick up Diving Helmet │ ◆◆◆ Lv.3 41/60]       toasts          │
│ (i) Press C to crouch…                       ╲▁▁▁ viewmodel ▁▁▁▁▁╱     ①DMR ②LMG ③ ④×2   │
│ ┌ vitals ──────────────┐                    ╱   (arms + gun)     ╲   ┌────────────────┐  │
│ │ ♥ ███████ 74         │                   ╱                       ╲ │        8 / 40  │  │
│ │ [vest][helm][stance] │                                             │ [Q] heals      │  │
│ └──────────────────────┘                                             └────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Slots** move from bottom centre into the bottom-right column, as a compact row directly above the ammo panel:
  keycap + icon + mag/count for every slot, the type name only on the active slot (it widens). Same active/empty/
  grenade cues as §11. This keeps the weapon silhouette clear, and puts "which gun" and "how much ammo" in one
  glance.
- **Ammo panel** stays bottom-right; it sits over the gun's lower edge, which is fine because the panel is opaque
  sand with an ink outline (no transparency over a busy model).
- **Hints** move from bottom centre to the bottom-left, directly above the vitals panel (left-aligned chip).
- **Toasts** move up so they clear the slot row (bottom ≈ 13em instead of 9.5em).
- **Pickup prompt** stays centred under the crosshair (ink-glass chip, readable over the viewmodel).
- **Spectate bar** stays bottom centre (no viewmodel while spectating in chase; in FP spectate the target's
  viewmodel is not drawn, per the brief only the local player has arms).
- **ADS:** corner panels stay; nothing moves. The prompt and hints still hide when scoped (§11).
- **Narrow (≤ 900 px):** slot names hide (icons + numbers only).
- **Touch (later):** the right thumb zone is now the slot row + ammo; touch fire/ADS buttons go above them.

### 13.3 Remaining third-person views
- **Aboard the carrier (orbit):** no reticle, no slots/ammo/vitals (as `dropping`). Shown: aboard HUD from
  2b-C15 (`hud.carrier.jump` prompt under the centre, `hud.carrier.aboard`, `hud.carrier.doorsIn` /
  `hud.carrier.eject` timer chip top-centre), the minimap with the route and the carrier icon, kill feed, alive
  count. Click-to-play still appears if the pointer is not locked (mouse look orbits).
- **Jump → freefall:** a hard cut to FP (the renderer may blend); the Ui swaps the aboard HUD for the drop prompts
  on the same frame (`hud.drop`, `hud.chute.auto`, `hud.chute.open`).
- **Death cam (short orbit around your body or the killer):** the death card moves from screen centre to the
  lower third (bottom-centre, max 24em wide, slides up 160 ms; none with reduced motion) so the orbit stays visible.
  Content is unchanged (cause, placement, kills, Spectate). Vitals/slots/ammo already hide when dead.
- **Spectating:** FP by default. The spectate bar gains a view chip: `[V]` keycap + `hud.spectate.firstPerson` or
  `hud.spectate.chase` (shape cue: eye glyph for FP, camera glyph for chase). A one-time `hint.spectateView` shows the
  first time you spectate.
- **Results:** overlay unchanged; the background camera is whatever ClientGame picks.

### 13.4 Settings
```
║ Mouse sensitivity  ───●─────  1.00 ║
║ Field of view      ────●────   80° ║  70–100, step 1; value via menu.settings.fov.value
║ ☑ Head bob                         ║  "Off while Reduce motion is on" sub-label when forced off
║ ☐ Invert Y                         ║
║ Aim mode [✓Hold] [Toggle]          ║
║ ADS sensitivity    ──●──────  1.00 ║
║ Volume …  Graphics quality …  UI size …  ☐ Reduce motion                        ║
```
- **FOV:** stored as `Settings.fovDeg` = horizontal FOV at a 16:9 reference (Hor+). ClientGame converts it to the
  vertical FOV for the actual aspect, so ultrawide gets more side view, not a squashed picture. Live preview while
  dragging (`input` event), persisted on change. Default `DEFAULT_FP_FOV_DEG` (80) in `src/shared/contracts.ts`, a
  shared constant (Ui does not read balance).
- **Head bob:** `Settings.headBob` is the **effective** value sent to ClientGame. The user's explicit choice is
  stored as a UI pref (`headBobChoice: 'auto' | 'on' | 'off'`, default `auto`). `auto` = on, except off while
  reduced motion is in effect (OS or the Reduce motion toggle); the checkbox then shows unticked with the sub-label
  `menu.settings.headBob.reduced`. Ticking it explicitly turns bob on even with reduced motion. Migration: saves
  without the fields load as FOV default and `auto`.
- **Controls list:** add `spectateView` (V). It shows in the Pause overlay and the waiting room's compact list;
  `jumpPlane` (Space / F) is added too (already in en.json).

### 13.5 Data needed
Contract additions (tech-lead), on top of §12.10:
```ts
export interface HudView {
  /** Which camera the player is looking through this frame. 'firstPerson' also covers FP spectating. */
  cameraView: 'firstPerson' | 'chase' | 'orbit';
  spectate: { /* existing fields */ view: 'firstPerson' | 'chase' } | null;
  // cameraFovDeg (existing, optional) becomes REQUIRED and is the vertical FOV actually rendered this frame.
}
export interface HudLocalView {
  /** 2b-C15 drop state (if not already in the drop contract): aboard / freefall / chute / landed. */
  dropPhase: 'aboard' | 'freefall' | 'chute' | null;
}
export interface Settings {
  /** Horizontal FOV at a 16:9 reference, degrees, FP_FOV_MIN..FP_FOV_MAX. Absent = FP_FOV_DEFAULT. */
  fovDeg?: number;
  /** Effective head bob (Ui resolves reduced motion). Absent = true. */
  headBob?: boolean;
}
// contracts.ts (as built): FP_FOV_MIN_DEG = 70, FP_FOV_MAX_DEG = 100, DEFAULT_FP_FOV_DEG = 80 (no balance key)
```
`AdsView` is unchanged. Ui-only: `UiPrefs.headBobChoice`.

### 13.6 String keys
**Existing, reused:** `menu.settings.fov`, `menu.settings.headBob`, `menu.controls.spectateView.key|label`,
`menu.controls.jumpPlane.key|label`, `hud.spectate.firstPerson`, `hud.spectate.chase`, `hud.spectate.next`,
`hud.carrier.*`, `hud.chute.*`, `hud.drop`.

**Missing (narrative-designer):**
| Key | Proposed text |
|---|---|
| `menu.settings.fov.value` | {deg}° |
| `menu.settings.headBob.reduced` | Off while Reduce motion is on |
| `hint.spectateView` | Press V to switch to a chase cam. |

### 13.7 QA checklist additions (first person)
- [ ] FP hip: the reticle is centred, grows with movement/jump and shrinks crouched/prone; bullets land inside it.
- [ ] FP ADS iron/red dot: no Ui reticle; the viewmodel sight sits on the centre. Scope: overlay as before.
- [ ] FOV slider 70–100 changes the view live and persists; ultrawide shows more to the sides. The crosshair gap
      matches the spread at 70 and at 100.
- [ ] Head bob: default on; turning on Reduce motion (OS or toggle) turns it off and shows the sub-label; ticking it
      again forces it on.
- [ ] Slots and ammo sit bottom-right above/in the ammo panel and never cover the gun's sight in hip or ADS; hints
      sit above the vitals; toasts clear the slot row. Check at 1280×720, 1920×1080, 3440×1440 and UI size 150 %.
- [ ] Aboard: no reticle or slots; jump prompt, aboard count and timer visible. Jump cuts to FP freefall prompts.
- [ ] Death cam: death card in the lower third, orbit visible above it.
- [ ] Spectate: FP by default with a dim centre dot; V toggles to chase (chip text and glyph change); the V hint shows
      once.

## 14. M2b as built (Phase C, ARCHITECTURE §15.8)

### Files
- `src/ui/rooms.ts`: `RoomBrowser`, `RoomDialog` (create and host settings), `WaitingRoom` (members, crown, ready ticks,
  code + Copy + invite link, vote panel or map card with a small minimap and the flight route, host Start / Cancel /
  settings, kick two-step, auto-start line, countdown bubble), `MenuToasts`.
- `src/ui/roomLogic.ts` (pure, `roomLogic.test.ts`): code check, deep links, URL sync, labels, Start state, toast throttle.
- `src/ui/drop.ts`: aboard / freefall / chute HUD (`logic.dropHudModel`, `logic.flightCue`).
- `src/ui/minimap.ts`: `AnyMapData`; indoor = floor zones, plateaus (floor kit entries with colliders, footprint
  >= 25 m², height >= 3 m), floor-standing walls (glass light cyan), zone colours per theme, route + eject marker +
  carrier icon (pre-flight: where the route enters the map frame, `logic.routeEntryPoint`).
- Pure additions in `logic.ts` (`m2b.test.ts`): `selectScreen` with rooms, `zoneKey`, themed `tideStatus`, FP
  `adsReticle`, `reticleMode`, `dangerBlink`, `fitRectProjection`.

### Behaviour notes
- Screens: `title | connecting | connectionLost | browser | room | match | results` (+ legacy `lobby` while
  `HudView.rooms` is absent). The room phase leads; the World phase only fills a lagging room update.
- Host has no ready toggle (rooms.md: the host counts as ready); the host row shows the crown and a "Host" tag.
- Edit-settings dialog closes on Save (there is no per-request failure event); Create stays open with a spinner until
  `roomJoined` or `roomCreateFailed`.
- Browser "Back" returns to the Title without disconnecting (no disconnect intent exists); Play sends `onJoin` again.
- Head bob: one checkbox; ticking it to what `auto` would show stores `auto` (`headBobChoiceFor`).
- First person: slots sit above the ammo panel (name on the active slot only), hints above the vitals, toasts at
  13em; FP ADS shows no Ui dot; fists / grenade show the dot only; FP spectate shows a 60 % dot.
- BUG-009: gear cells are `minmax(0, 1fr)`, the vitals panel is 17em at small sizes, and the label ellipsises as a
  last resort.

### Strings still missing (guarded with `hasKey` fallbacks)
| Key | Proposed text | Fallback today |
|---|---|---|
| `room.cancel` | Cancel start | `room.create.cancel` |
| `room.start.needTwoWithoutBots` | Needs 2 players without bots | no sub-label |
| `hud.drop.altitude` | {height} m | bar without a number |
| `browser.error.kicked` | You were removed from that room. Try again later. | `room.toast.kicked` |
| `browser.error.busy` | The server is busy. Try again in a moment. | `browser.error.roomLimit` |

### QA additions
- [ ] ?room= chip on the Title, × cancels it; Play joins directly; reload inside a room keeps ?room= and rejoins.
- [ ] Aboard: timer chip (doors / auto-eject, striped at <= 5 s), "N still aboard", dashed jump prompt until doors
      open; freefall: steer prompt, "[Space] Open chute" while allowed, altitude bar with the deploy mark.
- [ ] Office minimap: walls (glass lighter), desks, rooms by floor colour; route and carrier on both maps.
- [ ] Zone chip, outside banner, announcer and hint follow the theme (tide / lights out / sprinklers).
- [ ] Danger icon blinks faster under 2 s and gets a double ring in the last second (also with reduced motion).
- [ ] 960×540: "Helmet" fits its cell (BUG-009).

## 15. M2c "Fresh Every Match & Bigger Arsenal"
Design spec in `docs/ui/M2c.md` (item levels and the level badge, melee slot, throwable slot cycling, RPG, smoke
visibility, per-match layout on the minimap, look line and layout code, string keys, contract requests, acceptance
criteria M2C-UI-01..32). It supersedes the "Loot tier" row in §4: the ground shows the item's level, not the spot tier.
