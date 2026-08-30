# Releases & distribution

How a version number is decided, what a release contains, and how a server gets one.

## Versioning

Releases are cut automatically from Conventional Commits by
`.github/workflows/release.yml`.

| Push to | Produces |
|---|---|
| `beta` | a prerelease `X.Y.Z-beta.N`, tagged and published as a GitHub prerelease |
| `main` | the release `X.Y.Z`, tagged and published as the latest GitHub release |

A push containing only `docs`/`chore`/`refactor`/`test`/`ci`/`build` produces **no
release**, so documentation churn does not mint versions.

Otherwise the level is the highest severity among every commit since the last
**stable** release — one `feat` among twenty `docs` makes it a minor. Measuring from
the last stable rather than the last tag is what lets a beta line accumulate:

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

Nothing is ever force-pushed. Deployments track these branches, and a rewrite breaks
their updater.

## Tracks

Two update tracks, selectable in **Settings → Advanced → Update track**:

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

The runtime ships inside the archive, so a server needs neither Node, nor npm, nor a
build toolchain — installed or to update. About 35 MB compressed, 115 MB on disk, of
which the runtime is nearly all.

This is possible because the server's entire third-party surface is three pure-JS
packages (`fflate`, `read-excel-file`, `write-excel-file`) and no native modules. The
rest of `dependencies` is interface code, compiled into `build/` by Vite. There is no
compilation step per platform.

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
it follows is recorded in the data directory on every update (falling back to
the Homebrew formula name, then to whether the version is a prerelease), so a
beta box that takes a stable release stays on beta.

A packaged install keeps each release in its own directory and moves a pointer:

```
/opt/stage-utility/
  releases/1.9.2/
  releases/1.9.3/
  current -> releases/1.9.3
```

The pointer moves only after a verified extraction, so an update cannot land
half-applied, and the previous release stays on disk to return to.
