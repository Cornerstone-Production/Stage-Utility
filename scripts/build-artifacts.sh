#!/usr/bin/env bash
#
# build-artifacts.sh — assemble one downloadable archive per platform.
#
# Each archive is a complete install: the bundled server, the compiled interface,
# and a Node runtime. A machine that unpacks one needs nothing else — no Node, no
# npm, no build toolchain, not to install and not to update.
#
# Every platform is built HERE, on one runner, because there is nothing to
# cross-compile: the server's only third-party dependencies are pure JavaScript,
# so the per-platform part is just which Node binary gets copied in.
#
#   Usage: scripts/build-artifacts.sh <version> [outdir]
#
set -euo pipefail

VERSION="${1:?usage: build-artifacts.sh <version> [outdir]}"
OUT="${2:-dist}"
NODE_VERSION="${NODE_VERSION:-24.18.1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# platform:node-dist-name:archive-ext-of-the-node-download
PLATFORMS=(
  "linux-x64:node-v${NODE_VERSION}-linux-x64:tar.xz"
  "linux-arm64:node-v${NODE_VERSION}-linux-arm64:tar.xz"
  "darwin-arm64:node-v${NODE_VERSION}-darwin-arm64:tar.gz"
  "darwin-x64:node-v${NODE_VERSION}-darwin-x64:tar.gz"
  "win-x64:node-v${NODE_VERSION}-win-x64:zip"
)

echo "==> building the server bundle and interface"
node scripts/bundle-server.mjs
[ -d build/renderer ] || { echo "build/renderer missing — run npm run build first" >&2; exit 1; }

# One checksum file from nodejs.org covers every download below, so fetch it once
# and verify each runtime against it. An unverified runtime is the last thing that
# should end up inside something people install.
echo "==> fetching Node ${NODE_VERSION} checksums"
curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

for entry in "${PLATFORMS[@]}"; do
  IFS=: read -r plat dist ext <<<"$entry"
  echo "==> $plat"
  archive="${dist}.${ext}"

  curl -fsSL -o "$WORK/$archive" "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  ( cd "$WORK" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c - >/dev/null ) \
    || { echo "checksum failed for $archive" >&2; exit 1; }

  stage="$WORK/stage-$plat"
  mkdir -p "$stage/build"
  cp build/server.mjs "$stage/"
  [ -f build/server.mjs.map ] && cp build/server.mjs.map "$stage/"
  cp -R build/renderer "$stage/build/renderer"
  cp -R public "$stage/public"
  cp LICENSE "$stage/"
  printf '%s\n' "$VERSION" > "$stage/VERSION"

  # Just the runtime. npm, corepack and the headers are build tooling that a
  # packaged install never invokes.
  case "$ext" in
    zip)
      ( cd "$WORK" && unzip -q -o "$archive" "${dist}/node.exe" )
      cp "$WORK/${dist}/node.exe" "$stage/"
      ;;
    *)
      tar -xf "$WORK/$archive" -C "$WORK" "${dist}/bin/node"
      cp "$WORK/${dist}/bin/node" "$stage/"
      chmod +x "$stage/node"
      ;;
  esac

  out="$OUT/stage-utility-${VERSION}-${plat}.tar.gz"
  tar -czf "$out" -C "$stage" .
  echo "    $(basename "$out")  $(du -h "$out" | cut -f1)"
done

echo "==> checksums"
( cd "$OUT" && sha256sum stage-utility-*.tar.gz > SHA256SUMS && cat SHA256SUMS )
