# ADR 0003: Low-health signal, typed bot tuning, graphics status (Contract revision 1b)

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ADR 0002](0002-m1-netcode-and-boundary-clarifications.md), [ARCHITECTURE.md](../tech/ARCHITECTURE.md)
  §7, §9, §12, [REVIEW-M1.md](../tech/REVIEW-M1.md) m5, m8

## Context
- Review m5: the HUD stripes and the audio heartbeat each hard-coded their own "low health" number. The review
  planned `clientFeel.lowHpFraction` plus a `localLowHealthChanged` bus event for revision 2. Since then,
  game-designer chose an absolute key, `player.lowHpThreshold`. Ui (`src/ui/logic.ts`) and audio
  (`AudioEngine.resolveLowHealthHp`) both already use the rule `hp > 0 && hp <= threshold`, with 30 as the fallback.
- Audio read that key by importing `BALANCE` directly. Only composition roots may import `BALANCE`
  (ARCHITECTURE §9).
- The bot pacing rework added about 35 balance keys (`bots.*`, `bots.personalities`, and loot scores in `bots.ai`)
  that `bots.ts` read through `as unknown as Record<string, unknown>` casts, so `validateBalance` did not check them.

## Decision
1. **Ui gets the threshold as a number on the HUD view:** `HudLocalView.lowHpThreshold?: number`. A boolean would
   also work, but a number keeps one shared rule, `alive && hp > 0 && hp <= lowHpThreshold`, which matches the
   existing `isLowHp(hp, threshold)` and audio's director. It also lets Ui scale the effect's intensity later
   without another contract change. The producer is `hudBuilder`, which copies `balance.player.lowHpThreshold`
   and leaves the field out when the key is absent.
2. **Audio gets the same number by injection, not from the HUD view.** `main.ts` passes
   `new AudioEngine(bus, { lowHealthHp: BALANCE.player.lowHpThreshold })` through the existing
   `AudioEngineOptions`. Audio's direct `BALANCE` import, through `resolveLowHealthHp`, **is acceptable for M1
   only as a fallback**, the same interim pattern as Renderer revision 1 #10. Production gets the same validated
   number on both paths, so stripes and heartbeat cannot disagree. audio-designer should remove the import and fall
   back to `AUDIO_TUNING.lowHealthHp` before M2. Lint (REVIEW M2) will then enforce the rule with no exception.
3. **The planned revision 2 `localLowHealthChanged` event and `clientFeel.lowHpFraction` are dropped.** One
   balance number plus two injections is enough. Add an event only if a third consumer appears.
4. **All bot tuning keys are typed and validated as optional.** `BotPacingBalance` covers the top-level `bots.*`
   keys and `bots.personalities` (`BotPersonalityBalance` per `BotPersonalityId`). `BotAiBalance` gains the loot
   scores. Key names match `BotTuning` and `BOT_AI` in `bots.ts` exactly, so the casts there can go.
   `validateBalance` rejects non-numbers and unknown personality names, because a misspelt `agressive` would
   otherwise fall back to the defaults without any error. Keys that start with `_` are allowed as comments.
   `BotPersonalityId` and `BOT_PERSONALITY_IDS` move to `src/shared/types.ts`. `bots.ts` can alias them.
5. **WebGL context health is a polled renderer status, bridged by `main.ts`.** The Renderer now restores GPU
   state on `webglcontextrestored` (review M4), but a context that never comes back still leaves a black screen
   while the match keeps running. The fix is `IRenderer.getGraphicsStatus?(): GraphicsStatus` (`'ok' | 'restoring' |
   'failed'`). It reports `'failed'` once `CONTEXT_RESTORE_TIMEOUT_MS` (constants.ts, 5000) passes with no restore.
   `main.ts` polls it after `render()` each frame and calls `IUi.setGraphicsStatus?(status)` only when it changes.
   On `'failed'`, Ui shows a blocking "graphics reset, please reload" overlay with a Reload button. Renderer and Ui
   never import each other (§3 dependency rule). Both methods are optional, so either side can land first.
   Alternatives: a bus event (rejected because only ClientGame emits on the bus), or a `HudView` field (rejected
   because ClientGame does not know about the renderer).

## Consequences
- Ui and audio stop hard-coding 30 as soon as game-designer adds `player.lowHpThreshold`. Their fallbacks only
  apply while the key is absent.
- Tests that inject a non-default `Balance` into ClientGame also need to pass `lowHealthHp` to AudioEngine if they
  care about the heartbeat. That is acceptable, because the two are never constructed together in unit tests.
- The bot keys stay optional, so game-designer can add them in any order. A typo in a value fails fast at startup
  and in `balance.test.ts`.

## Alternatives considered
- `HudLocalView.lowHp: boolean`. This is simpler for Ui, but audio would still need the number, so the
  comparison would live in two places anyway. It also rules out scaling the effect by intensity.
- Audio reads `HudView`. Rejected: audio gets bus events and the listener pose, not the HUD view, and adding that
  dependency only for this is not worth it.
- Making the bot keys required. Rejected for now because game-designer is still adding them. Revisit at M2 once
  the numbers settle.
