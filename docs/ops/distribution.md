# Releases & distribution

How a version number is decided, what a release contains, and how a server gets one.

## Versioning

Releases are cut automatically from Conventional Commits by
`.github/workflows/release.yml`.

| Push to | Produces |
|---|---|
| `beta` | a prerelease `X.Y.Z-beta.N`, tagged and published as a GitHub prerelease |
| `main` | the release `X.Y.Z`, tagged and published as the latest GitHub release |

A push containing only `docs`/`chore`/`refactor`/`test`/`ci`/`build`/`revert` produces
**no release**, so documentation churn does not mint versions.

Otherwise the level is the highest severity among every commit since the last
**stable** release — one `feat` among twenty `docs` makes it a minor. `fix`, `perf`
and `polish` are patch level, so a release of only those is X.Y.Z+1. A `feat`,
`fix`, `perf` or `polish` scoped to the tooling itself (`release`, `ci`, `dx`,
`test`) is left out of that reading, and out of the notes; see
`scripts/release-level.sh`. Measuring from the last stable rather than the last
tag is what lets a beta line accumulate:

```
v1.9.2            last stable release
  fix    -> v1.9.3-beta.1     a patch line opens
  fix    -> v1.9.3-beta.2     refinements ride the same base
  feat   -> v1.10.0-beta.1    a feature raises the line to minor
  fix    -> v1.10.0-beta.2
  main   -> v1.10.0
```

The base version moves only when the pending release changes class; refinements
advance `-beta.N`. The version never decreases — if the beta line already sits above
what the level implies, it stays.

Prereleases ship continuously, one per push to `beta` that carries a releasable
commit. Stable releases are promoted about every two weeks, or sooner for a fix that
cannot wait; see [Release rhythm](../contributing.md#release-rhythm).

Nothing is ever force-pushed. Deployments track these branches, and a rewrite breaks
their updater.

## Tracks

Two update tracks, selectable in **Settings → Advanced → Updates → Update track**:

- **main** — stable releases only.
- **beta** — prereleases *and* stable releases, so a beta server is never held back
  from the release its own prereleases produced.

## What a release contains

Every tag is built by CI into one archive per platform, attached to the GitHub
release:

```
stage-utility-<version>-<os>-<arch>.tar.gz
  node                  the Node runtime this release was tested against
  server.mjs            the bundled server
  build/renderer/**     the compiled interface
  public/**
  VERSION
```

Targets: `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `win-x64`.

When the release's tree has the [Mac output helper](../kiosk-devices.md#installing-the-mac-output-helper)
(`helper/macos/build-app.sh`), it is built too, on two macOS runners side by side, one
per architecture, and the same release carries two more assets:

```
StageUtilityOutput-arm64.zip
StageUtilityOutput-x86_64.zip
```

Each zip holds `StageUtilityOutput.app` (about 145 MB zipped and 330 MB unpacked, nearly all of it Chromium).
They are for the Mac installer, which a server serves from its own cache; the updater
never reads them. Like the archives, they are verified against the SHA-256 `digest`
the releases API lists for the asset; no checksum file is published beside them. A
release made before GitHub began serving asset digests (2025) has none, and its zips
cannot be verified, so a server running one refuses them. A tree without the
build script skips the job and releases as before, and a macOS build that fails or is
cancelled releases without the zips rather than stopping the release (the archives are
built beside it, but publishing waits for it, up to its 60-minute timeout); the run then carries an
error annotation, and Macs whose server runs that version cannot install the helper
until the server updates. The assets are made before
the release is created, because a published release cannot be added to.

The app is compiled fresh for every release, since the version is stamped into it and
the helper's updater compares that. What is cached between release runs is the
compiled CEF wrapper and the cmake and ninja tools, per architecture, keyed on
`helper/macos/cef.json`, `build-tools.txt` and `CEFHost/`; CEF itself is downloaded and
its checksums checked every time. Only release runs on `beta` and `main` write that
cache.

Every release also carries a signature of each payload a machine
[updates itself from](../kiosk-devices.md#signed-updates):

```
kiosk-windows.ps1.sig              the Windows kiosk's launcher, as in scripts/kiosk
StageUtilityOutput-arm64.zip.sig   when the helper was built
StageUtilityOutput-x86_64.zip.sig  when the helper was built
```

Each is RSA-3072, PKCS#1 v1.5 over SHA-256, made by
`scripts/sign-release-assets.sh` in a `sign` job of its own, with the private key in
the `RELEASE_SIGNING_KEY` secret. That job installs and runs nothing from npm: it checks
out the tag, signs the launcher as the tagged blob (`git show v<version>:…`) and the
helper's zips from the helper job's artifact, and verifies each signature against the
committed public key. The artifacts job checks the set again before it attaches it: one
signature per payload, each verifying. No secret, or a secret that is not the committed
key's private half, stops the run before it tags. A signing failure after the tag does
not cost the release: it is published without signatures and the run carries an
error annotation, and every Mac helper and Windows kiosk refuses that release, staying
on the version it has, until a signed one. A partial or mismatched set is never
attached.

## The release signing key

The private key exists only as the GitHub Actions secret `RELEASE_SIGNING_KEY`. The
public half is `scripts/kiosk/release-signing.pub.pem`, the one copy in the tree; the
server serves it to the installers and never has the private half.

The release job checks the secret (`scripts/sign-release-assets.sh --check`) before it
tags, in a step that nothing from npm has run before, so a missing or wrong key stops a
release with nothing pushed, and the `sign` job's signing step signs with it. No other
step, job or workflow-level environment sees it.

To make a key pair (once, on a trusted machine) and set the secret:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out release-signing.key.pem
openssl pkey -in release-signing.key.pem -pubout -out scripts/kiosk/release-signing.pub.pem
gh secret set RELEASE_SIGNING_KEY --repo Cornerstone-Production/Stage-Utility < release-signing.key.pem
```

Commit the public key, then keep the private key offline (a password manager, or
`openssl pkey -aes256` for an encrypted copy) or destroy it: the secret is what CI uses,
and a lost key is replaced, not recovered.

**Rotating it** (a leaked key, or a lost one) is the same three commands, with the new
public key committed in place of the old. Releases from then on are signed with the new
key. A machine keeps the key it was installed with and refuses every release signed
with another, and running its installer again keeps that key too. So once their server
runs the first release with the new key, run the installer on every Mac with
`--replace-signing-key` (`curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh -s -- --replace-signing-key`)
and on every Windows kiosk with `$env:STAGE_REPLACE_SIGNING_KEY = '1'` set first. Until
then they stay on the version they have.

The runtime ships inside the archive, so a server needs neither Node, nor npm, nor a
build toolchain — installed or to update. About 35 MB compressed, 115 MB on disk, of
which the runtime is nearly all.

This is possible because the server's entire third-party surface is three pure-JS
packages (`fflate`, `read-excel-file`, `write-excel-file`) and no native modules. The
rest of `dependencies` is interface code, compiled into `build/` by Vite. There is no
compilation step per platform.

## The release app

`beta` and `main` take pushes and merges from the maintainer and one GitHub App,
and from nobody else. A repository ruleset on both branches requires a pull request
and restricts updates, and its bypass list names only those two. The workflow's own
`GITHUB_TOKEN` cannot be put on that list, so the release job pushes the version-bump
commit and the tag with a token minted from the app, in the step right before the
push. The token is scoped to this repository and to contents, and is revoked when the
job ends. The job's own token is read-only for contents.

The app's private key is a secret of the `release` environment, not of the
repository, and only `beta` and `main` may deploy to that environment. A workflow
pushed to any other branch cannot read the key, and so cannot use it to push past the
ruleset. The release job is the only job that names the environment.

Unlike `GITHUB_TOKEN`, a push made with the app's token starts workflows. The bump
commit's `[skip ci]` is what keeps it from starting Release, CodeQL and the secret
scan a second time.

Setting it up, once:

1. Create a GitHub App owned by the organisation, with no webhook, and one
   repository permission: **Contents: read and write**.
2. Install it on this repository only.
3. Create the `release` environment (Settings → Environments), with deployment
   branches limited to `beta` and `main`.
4. Set the variable and the environment secret the release job reads:
   ```sh
   gh variable set RELEASE_APP_CLIENT_ID --repo Cornerstone-Production/Stage-Utility --body <client id>
   gh secret set RELEASE_APP_PRIVATE_KEY --env release --repo Cornerstone-Production/Stage-Utility < <app>.private-key.pem
   ```
5. Add the ruleset on `refs/heads/beta` and `refs/heads/main`: require a pull request
   (0 approvals), restrict updates, and bypass for the maintainer's account and the app.

Without the variable or the secret, the release job fails at "Mint the release app
token", with nothing tagged or pushed. Without the app on the ruleset's bypass list,
it fails at the push, which reports that it was refused for a reason other than the
branch moving. Either way the fix is the setting, then **Run workflow** on Release.

To rotate the key, generate a new private key in the app's settings, set the secret
again, and delete the old key there.

## Installing

See [install-and-config.md](install-and-config.md). Installers download the archive
for the platform they are running on, verify it, and register it to start on its
own — a systemd unit on Linux, a launchd daemon on macOS, a scheduled task on
Windows.

The expected hash comes from the **releases API**, which publishes a SHA-256 digest
per asset. It has to come from outside the archive: a checksum shipped inside the
file it describes proves nothing, because whoever alters the file alters the
checksum with it. An installer that cannot obtain a digest refuses to install
rather than proceeding unverified.

The kiosk installers and the updaters they leave on a Mac or a Windows PC check one
more thing: the release's signature of the payload, against the key installed with
the updater. See [Signed updates](../kiosk-devices.md#signed-updates).

Installers are distributed as a script rather than a `.pkg` or `.msi` because an
unsigned installer bundle is worse than none: macOS Gatekeeper refuses to open an
unsigned `.pkg`, and Windows SmartScreen warns on an unsigned `.exe`. Signing both
costs roughly $300 a year, recurring. The quarantine attribute that triggers those
checks is applied by browsers to downloaded bundles, so a script fetched with `curl`
is never subject to them. Native installers remain possible later from the same
archives if that cost is ever justified.

## How a server updates itself

**Settings → Advanced → Updates.** The updater resolves the newest release on its
track, and how it gets there depends on how the server was installed:

| | git checkout | packaged install |
|---|---|---|
| discover | tags reachable from the tracked branch | GitHub releases |
| fetch | `git merge --ff-only <tag>` | download the archive, verify SHA256 |
| install | `npm ci` + `npm run build`, only if needed | extract, move the pointer |

Both compare versions with the same semver ordering. Ordering is not delegated to
`git tag --sort=-v:refname`, which ranks a prerelease *above* its own release unless
the repository sets `versionsort.suffix` — it lists `v1.10.0-beta.1` ahead of
`v1.10.0`, which would hand every server a prerelease the moment a stable release
shipped.

A server follows **tags, not the tip of its branch**. A tag is cut only after lint,
type-check, tests and the build have all passed, so a failed build cannot reach a
display. Work that has merged but not yet released is reported as such rather than
counted as an available update, so a track stalled on a red build reads as *waiting*
rather than *up to date*. A branch with no tags falls back to following its tip.

A packaged install discovers releases from the GitHub API — the paged list plus
`releases/latest`, because the list is newest-first regardless of prerelease flag
and a long run of betas can push the newest stable off the first page. The track
it follows is the Homebrew formula name where the install has one, otherwise
whatever was recorded in the data directory on the last update, otherwise
whether the version is a prerelease, so a beta box that takes a stable release
stays on beta.

A packaged install keeps each release in its own directory and moves a pointer:

```
/opt/stage-utility/
  releases/1.9.2/
  releases/1.9.3/
  current -> releases/1.9.3
```

The pointer moves only after a verified extraction, so an update cannot land
half-applied, and the previous release stays on disk to return to.
