#!/usr/bin/env bash
# Runs Playwright E2E. If scripts/setup-chromium-libs.sh has unpacked libraries into .cache/chromium-libs/,
# they are prepended to LD_LIBRARY_PATH so Chromium starts without system-wide installs.
# Extra arguments go to `playwright test`, e.g. `npm run e2e:local -- tests/e2e/boot.spec.ts --headed`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="$ROOT/.cache/chromium-libs/LD_LIBRARY_PATH"

if [ -f "$MARKER" ]; then
  LIBDIR="$(cat "$MARKER")"
  if [ -d "$LIBDIR" ]; then
    export LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    echo "[e2e:local] using Chromium libs from $LIBDIR"
  fi
fi

cd "$ROOT"
exec npx playwright test "$@"
