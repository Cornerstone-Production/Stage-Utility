#!/usr/bin/env bash
# Download the CEF binary distribution pinned in cef.json, check it, and unpack it.
#
#   helper/macos/fetch-cef.sh            -> the Mac's own architecture
#   helper/macos/fetch-cef.sh x86_64     -> arm64 or x86_64
#
# The archive goes to helper/macos/.cef/downloads/ (gitignored; CEF_CACHE moves the
# whole cache) and is unpacked beside it. `.cef/<arch>` is then a link to the unpacked
# distribution, and the last line printed is its path.
#
# Both checksums in cef.json must match: SHA-1 is what CEF's index publishes, SHA-256
# was taken from a download whose SHA-1 matched it. A mismatch deletes the download and
# fails loudly; nothing is ever unpacked from an archive that was not checked, including
# one already in the cache.
set -euo pipefail
cd "$(dirname "$0")"

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "fetch-cef.sh: unknown architecture \"$ARCH\" (arm64 or x86_64)" >&2; exit 2 ;;
esac

PIN=cef.json
field() { plutil -extract "$1" raw -o - "$PIN"; }
VERSION="$(field version)"
FILE="$(field "arch.$ARCH.file")"
URL="$(field "arch.$ARCH.url")"
SHA1="$(field "arch.$ARCH.sha1")"
SHA256="$(field "arch.$ARCH.sha256")"

CACHE="${CEF_CACHE:-$PWD/.cef}"
DOWNLOADS="$CACHE/downloads"
ARCHIVE="$DOWNLOADS/$FILE"
DIST="$CACHE/${FILE%.tar.bz2}"
STAMP="$DIST/.stage-utility-sha256"
mkdir -p "$DOWNLOADS"

check() {
  local got1 got256
  got1="$(shasum -a 1 "$1" | cut -d' ' -f1)"
  got256="$(shasum -a 256 "$1" | cut -d' ' -f1)"
  if [ "$got1" != "$SHA1" ] || [ "$got256" != "$SHA256" ]; then
    echo "" >&2
    echo "fetch-cef.sh: CHECKSUM MISMATCH for $FILE" >&2
    echo "  sha1   expected $SHA1" >&2
    echo "         got      $got1" >&2
    echo "  sha256 expected $SHA256" >&2
    echo "         got      $got256" >&2
    echo "  The file has been deleted. Nothing was unpacked." >&2
    rm -f "$1"
    exit 1
  fi
}

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$SHA256" ]; then
  echo "CEF $VERSION ($ARCH) already unpacked and checked" >&2
else
  if [ ! -f "$ARCHIVE" ]; then
    echo "downloading $URL" >&2
    curl --fail --location --retry 3 --silent --show-error -o "$ARCHIVE.part" "$URL"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  check "$ARCHIVE"
  echo "checksums match (sha1 $SHA1, sha256 $SHA256)" >&2
  rm -rf "$DIST" "$DIST.unpacking"
  mkdir -p "$DIST.unpacking"
  tar -xjf "$ARCHIVE" -C "$DIST.unpacking" --strip-components 1
  printf '%s' "$SHA256" > "$DIST.unpacking/.stage-utility-sha256"
  mv "$DIST.unpacking" "$DIST"
fi

ln -sfn "$DIST" "$CACHE/$ARCH"
echo "$CACHE/$ARCH"
