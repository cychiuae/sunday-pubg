# Beach Survival PvP

A 3D browser game: players are stranded on a tropical island, gather and craft to survive, and fight each other until one remains.

## Studio team (`.claude/agents/`)

| Agent | Role | Owns |
|---|---|---|
| `producer` | Planning, task breakdown, scope | `docs/PRODUCTION.md` |
| `game-designer` | Mechanics, rules, balance | `docs/design/GDD.md`, `docs/design/systems/`, `docs/design/balance.json` |
| `level-designer` | Island layout, spawns, loot placement | `docs/design/levels/`, `src/game/levels/` |
| `narrative-designer` | Lore, names, all player-facing text | `docs/narrative/`, `src/content/strings/` |
| `graphics-designer` | Art direction, models, textures, icons | `docs/art/`, `public/assets/`, `src/render/procedural/` |
| `ui-ux-designer` | HUD, menus, UX flows, accessibility | `docs/ui/`, `src/ui/` |
| `audio-designer` | SFX, music, Web Audio system | `docs/audio/`, `src/audio/`, `public/assets/audio/` |
| `tech-lead` | Architecture, ADRs, schemas, code review | `docs/tech/ARCHITECTURE.md`, `docs/adr/`, `src/shared/` types |
| `game-developer` | Gameplay code and simulation | `src/game/`, `src/shared/sim/` |
| `graphics-engineer` | Rendering, shaders, VFX, performance | `src/render/`, `docs/tech/RENDERING.md` |
| `network-engineer` | Authoritative server, netcode | `server/`, `src/net/`, `src/shared/protocol/` |
| `build-engineer` | Tooling, asset pipeline, CI, deploy | root config, `scripts/`, `.github/` |
| `qa-tester` | Verification, automated tests, bug reports | `tests/`, `docs/qa/` |
| `playtester` | Fun, feel, and balance feedback (read-only) | none |

## Pipeline for a feature
1. `producer` breaks the feature into tasks.
2. Design: `game-designer`, `level-designer`, `narrative-designer`, `graphics-designer`, `ui-ux-designer`, and `audio-designer` write the specs.
3. Technical design: `tech-lead` writes an ADR or schema if the feature needs one.
4. Build: `game-developer`, `graphics-engineer`, `network-engineer`, and `build-engineer` implement it. Run independent tasks in parallel.
5. Verify: `qa-tester` checks it against the acceptance criteria, then `tech-lead` reviews the code.
6. Tune: `playtester` gives feedback, and `game-designer` adjusts the balance.

## Shared rules
- Only edit files you own. To change another area, ask the owning agent or note it in your reply.
- Gameplay numbers live in `docs/design/balance.json` and player-facing text lives in `src/content/strings/en.json`. Never hard-code either.
- Simulation (`src/shared/sim/`) never imports rendering, DOM, or audio code. Systems communicate through events.
- Use only original or clearly licensed (CC0) assets, and record their sources in `docs/art/CREDITS.md`.
- Default stack, until the `tech-lead` records a change in an ADR: TypeScript, Vite, Three.js, a Node WebSocket server, Vitest, and Playwright.
