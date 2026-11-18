# UI / UX: Last One Dry (M1)

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
│ ┌──────────────────────────┐  ①          ②         ③          ┌──────────────────────┐   │
│ │ ♥ HEALTH ███████████ 100 │ [● Pistol] [▲ SMG ]  [○ Fists]    │            12 / 48   │   │
│ │ ⛨ ARMOR  ██████░░░░░  25 │ [   12   ] [  30  ]    ▼ active   │ [Q] [+Bandage 2]     │   │
│ └──────────────────────────┘                                   │     [⊞Medkit 1]      │   │
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
| Weapons / items | family colour | Shape per item: pistol ●, SMG ▲, shotgun ■, rifle ◆, fists ○ ring; ammo light ●, heavy ◆, shell ■; bandage ✚, medkit ⊞, vest shield. The type name is always shown as text. |
| Active weapon slot | accent fill | Raised and scaled up, a thicker outline, a ▼ pointer under the slot |
| Empty slot | — | Dashed outline plus the "Empty" label |
| Hit marker body / head / kill | white / yellow / red | Tick length grows (head < kill), the head adds a diamond "crown", the kill uses thicker ticks and a longer show time. Armor break adds a dashed ring. |
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
- Kill feed groups: `zone` → `feed.zone.*`; `fall` → `feed.fall.*`; no killer or no weapon → `feed.generic.*`;
  `fists` → `feed.melee.*`; headshot → `feed.headshot.*`; otherwise `feed.kill.*`.
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
| `playerDamaged.armorBefore` | armor-break ring on the hit marker | last armor seen for that victim |
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
| `src/ui/icons.ts` | Shape + colour item glyphs |
| `src/ui/dom.ts` | DOM builders and diffing helpers |
| `src/ui/logic.ts` | Pure helpers (tested) |
| `src/ui/settings.ts` | Settings / prefs parse, clamp and storage (tested) |
| `src/ui/ui.css` | All styles |
| `src/ui/logic.test.ts`, `src/ui/settings.test.ts` | Vitest (node) |
