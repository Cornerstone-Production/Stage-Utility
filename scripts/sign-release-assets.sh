#!/usr/bin/env bash
# Sign the payloads a machine updates itself from, for a release.
#
#   RELEASE_SIGNING_KEY="$(cat key.pem)" scripts/sign-release-assets.sh <out-dir> <file>...
#   RELEASE_SIGNING_KEY="$(cat key.pem)" scripts/sign-release-assets.sh --check
#
# Writes <out-dir>/<name>.sig for each file: RSA PKCS#1 v1.5 over SHA-256, what
# `openssl dgst -sha256 -sign` makes and what the Mac updater's LibreSSL and the
# Windows updater's .NET RSA verify (main/services/release-signing-key.ts says why
# RSA). Each signature is verified against the public key committed in
# scripts/kiosk/release-signing.pub.pem before this exits 0, so a secret that is
# not that key's private half fails here, not on every machine afterwards.
#
# --check signs and verifies a probe and writes nothing: the release workflow runs
# it before it tags, so a missing or wrong key stops the release before there is a
# version with no signatures.
#
# RELEASE_SIGNING_KEY is the PEM private key, from the GitHub Actions secret of
# that name. It is written to a file only for openssl to read, in a private
# temporary folder that is removed on exit. An empty one fails loudly, and the
# release workflow runs --check before it tags, so a missing key stops a release
# before there is one.
#
# SIGN_TEST_PUBLIC_KEY replaces the committed public key, for the tests only.
set -euo pipefail

PUB="${SIGN_TEST_PUBLIC_KEY:-scripts/kiosk/release-signing.pub.pem}"

fail() {
  echo "::error title=Release signing::$*" >&2
  exit 1
}

[ -n "${RELEASE_SIGNING_KEY:-}" ] ||
  fail "the RELEASE_SIGNING_KEY secret is not set, so this release cannot be signed. Set it to the private half of $PUB (docs/ops/distribution.md, The release signing key)."
openssl pkey -pubin -in "$PUB" -noout >/dev/null 2>&1 ||
  fail "$PUB is not a public key openssl can read (is it still the placeholder?). Commit the public half of RELEASE_SIGNING_KEY there."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
key="$work/key.pem"
( umask 077 && printf '%s\n' "$RELEASE_SIGNING_KEY" >"$key" )
openssl pkey -in "$key" -noout >/dev/null 2>&1 ||
  fail "RELEASE_SIGNING_KEY is not a PEM private key openssl can read."

# Sign one file to one signature, and prove the committed public key verifies it.
sign() { # file sig
  openssl dgst -sha256 -sign "$key" -out "$2" "$1" ||
    fail "could not sign $1."
  openssl dgst -sha256 -verify "$PUB" -signature "$2" "$1" >/dev/null 2>&1 ||
    fail "the signature of $1 does not verify against $PUB: RELEASE_SIGNING_KEY is not the private half of the committed public key."
}

if [ "${1:-}" = --check ]; then
  [ "$#" -eq 1 ] || fail "--check takes no files."
  printf 'release signing probe\n' >"$work/probe"
  sign "$work/probe" "$work/probe.sig"
  echo "RELEASE_SIGNING_KEY is the private half of $PUB."
  exit 0
fi

[ "$#" -ge 2 ] || fail "usage: sign-release-assets.sh <out-dir> <file>... | --check"
out="$1"
shift
mkdir -p "$out"
for file in "$@"; do
  [ -f "$file" ] || fail "$file is not a file, so it cannot be signed."
  sig="$out/$(basename "$file").sig"
  [ ! -e "$sig" ] || fail "$sig exists already: two payloads with the same name."
  sign "$file" "$sig"
  echo "signed $file -> $sig"
done
