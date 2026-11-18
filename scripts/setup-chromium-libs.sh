#!/usr/bin/env bash
# No-sudo workaround for Playwright's Chromium on Debian/Ubuntu machines that lack a few shared libraries
# (libatk, libatk-bridge, libXcomposite, libXdamage, libXrandr, libatspi).
#
# Downloads the .deb packages with `apt-get download` (no root needed), unpacks them with `dpkg-deb -x` into
# .cache/chromium-libs/ (gitignored) and prints the LD_LIBRARY_PATH to use. `npm run e2e:local` picks it up
# automatically. If you have sudo, `sudo npx playwright install-deps chromium` is the simpler fix.
#
# Usage: npm run setup:chromium-libs            (or: bash scripts/setup-chromium-libs.sh [extra-package ...])
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.cache/chromium-libs"
DEBS="$OUT/debs"
FS="$OUT/root"

# Ubuntu 24.04+ / Debian 13+ use the t64 package names; older releases use the plain names.
PKGS_T64=(libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 libxdamage1 libxrandr2 libatspi2.0-0t64)
PKGS_OLD=(libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxrandr2 libatspi2.0-0)

for tool in apt-get dpkg-deb dpkg; do
  command -v "$tool" >/dev/null || { echo "error: '$tool' not found. This script is for Debian/Ubuntu." >&2; exit 1; }
done

rm -rf "$DEBS" "$FS"
mkdir -p "$DEBS" "$FS"

download() {
  (cd "$DEBS" && apt-get download "$@") >/dev/null 2>&1
}

if download "${PKGS_T64[@]}" "$@"; then
  echo "Downloaded: ${PKGS_T64[*]} $*"
elif download "${PKGS_OLD[@]}" "$@"; then
  echo "Downloaded: ${PKGS_OLD[*]} $*"
else
  echo "error: apt-get download failed. Run 'apt-get update' (or ask an admin) and retry," >&2
  echo "       or install the system deps with: sudo npx playwright install-deps chromium" >&2
  exit 1
fi

for deb in "$DEBS"/*.deb; do
  dpkg-deb -x "$deb" "$FS"
done

MULTIARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || gcc -print-multiarch 2>/dev/null || echo x86_64-linux-gnu)"
LIBDIR="$FS/usr/lib/$MULTIARCH"
if [ ! -d "$LIBDIR" ]; then
  echo "error: expected $LIBDIR after unpacking" >&2
  exit 1
fi
echo "$LIBDIR" > "$OUT/LD_LIBRARY_PATH"

echo
echo "Libraries unpacked into $LIBDIR"
echo "Run E2E with:  npm run e2e:local"
echo "or manually:   LD_LIBRARY_PATH=\"$LIBDIR\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\" npx playwright test"
