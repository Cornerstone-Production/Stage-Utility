# Packaging & Public Release — Design

**Goal.** Someone who has never used a terminal seriously can install Stage Utility on
Linux, macOS, or Windows with one pasted line, and update it from inside the app.
The repository becomes public without leaking anything or misrepresenting its licence.

**Status.** Design. No implementation yet.

---

## 1. What the code allows

The findings below are what make this tractable; they were measured, not assumed.

**The server's entire third-party surface is three pure-JS packages** — `fflate`,
`read-excel-file`, `write-excel-file`. Everything else in `dependencies` (React,
Radix, TanStack, dnd-kit, pdfjs) is frontend, compiled into `build/` by Vite and
never imported by `main/` or `server.ts`.

**There are no native modules on the server path.** The one native package in the
tree, `@napi-rs/canvas`, arrives as an optional dependency of `pdfjs-dist` and is
reachable only from the renderer, where the browser's own canvas is used. So there
is no node-gyp step, no prebuild matrix, and no per-platform compilation.

**Payload budget:**

| Component | Size |
|---|---|
| `build/` (compiled frontend) | 3.6 MB |
| `public/` | 0.4 MB |
| bundled server JS | ~1 MB |
| Node runtime | ~110 MB |
| **installed** | **~115 MB** |
| **compressed download** | **~35 MB** |

**What the server reads at runtime:** `build/renderer/`, `public/`, `package.json`
(for the version), and — only in a git checkout — `scripts/update.*` plus `git`
itself. Nothing else ties it to a source tree.

---

## 2. Approach

**A one-line installer that downloads prebuilt artifacts.** Native `.deb`/`.pkg`/`.msi`
installers are a later, optional layer on the same pipeline.

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/install.sh | sudo bash
```
```powershell
irm https://raw.githubusercontent.com/<org>/<repo>/main/install.ps1 | iex
```

### Why not the alternatives

**Native installers first.** They are the nicest experience, but on macOS and Windows
an unsigned installer is worse than no installer: Gatekeeper hard-blocks an unsigned
`.pkg`, and SmartScreen warns on an unsigned `.exe`. Signing costs ~$300/year
recurring (Apple Developer $99 + a Windows OV certificate). A piped script is never
quarantined — the quarantine attribute is set by browsers on downloaded bundles — so
this route needs no signing at all. Native installers stay available later, using the
same artifacts, if the signing cost is ever justified.

**Node single-executable (SEA).** Buys nothing here: it still embeds the whole
runtime, so the size is identical, and its availability depends on how Node itself was
compiled — on a Homebrew Node it reports `Single executable application is disabled`.
Shipping the official Node binary beside a bundled JS file is smaller in concept,
debuggable, and cannot break this way.

**Electron / Tauri.** Wrong shape. This is a headless LAN server with a web UI, not a
desktop application; they would add a window nobody wants and roughly double the size.

**Docker.** Offered as a Linux extra, never the main path. The app talks to gear on the
LAN — OSC over UDP, Shure/Sennheiser TCP, ProPresenter — and binds port 80. That
requires `--network host`, which exists only on Linux. Under Docker Desktop for macOS
and Windows everything sits behind a NAT, so LAN discovery and UDP feedback break.

---

## 3. Artifacts

One tarball per platform, built in CI and attached to the GitHub release:

```
stage-utility-<version>-<os>-<arch>.tar.gz
  node                     official Node runtime for this platform
  server.mjs               esbuild bundle of server.ts + main/
  build/renderer/**        compiled frontend
  public/**
  VERSION                  the release tag, read at runtime
SHA256SUMS                 checksums for every artifact
```

**Targets:** `linux-x64`, `linux-arm64` (Pi 4/5), `darwin-arm64`, `darwin-x64`,
`win-x64`. Node publishes official builds for all of them.

Bundling the runtime rather than downloading it at install time keeps the install to a
single network fetch, pins the Node version the release was tested against, and means
a box needs neither npm nor a build toolchain — ever.

---

## 4. Install layout

Versioned directories with a pointer, so an update is a swap and a rollback is a swap
back:

```
/opt/stage-utility/            (Linux)
  releases/
    1.9.2/
    1.9.3/
  current -> releases/1.9.3
```

| Platform | Program dir | Data dir | Service |
|---|---|---|---|
| Linux | `/opt/stage-utility` | `/var/lib/stage-utility` | systemd unit |
| macOS | `/usr/local/stage-utility` | `~/Library/Application Support/stage-utility` | launchd plist |
| Windows | `C:\Program Files\Stage Utility` | `%ProgramData%\stage-utility` | service via WinSW |

Node cannot be a Windows service on its own. WinSW is the maintained wrapper for this
and replaces the current NSSM instruction.

Windows has no dependable unprivileged symlink; use a directory junction, or record the
active version in a file the service launcher reads.

The installer must keep the existing data-directory migration behaviour intact — an
upgrade from a git checkout has to find its existing config, not start empty.

---

## 5. Updates

The in-app updater keeps its entire UI and lifecycle. Only the transport changes, and
the abstraction is already right: it resolves *the newest release on my track*, which
maps exactly onto GitHub releases (prerelease → `beta`, release → `main`).

| | git checkout (today) | packaged (new) |
|---|---|---|
| discover | `git tag --merged origin/<branch>` | GitHub Releases API |
| compare | `release-tags.ts` | `release-tags.ts` (unchanged) |
| fetch | `git merge --ff-only <tag>` | download asset, verify SHA256 |
| install | `npm ci` + `npm run build` | extract to `releases/<v>`, flip pointer |
| restart | kill; service manager relaunches | unchanged |

`updater.ts` already detects `isGitRepo` and degrades, so both kinds coexist behind one
code path and one UI. The tested version comparator is reused as-is.

Two properties fall out of this:

- **Updates get much faster and need no toolchain.** No install, no bundle — download
  and swap. A packaged box never runs npm.
- **Updates become atomic.** Today a failed build leaves the checkout already
  fast-forwarded but unbuilt. A pointer that only moves after a verified extraction
  cannot land half-applied, and the previous release stays on disk to roll back to.

Updates need no elevation, because the service account owns the program directory.

---

## 6. CI

Extend `.github/workflows/release.yml`. It already tags only after lint, type-check,
tests and build all pass; artifact building hangs off that same gate.

```
tag pushed
  └─ matrix: linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64 | win-x64
       bundle server → fetch Node → assemble tree → tar.gz → checksum
  └─ attach artifacts + SHA256SUMS to the GitHub release
```

The installer scripts resolve the newest release for their track through the same API
the updater uses, so there is one definition of "latest" across install and update.

---

## 7. Public release

Blocking:

- [x] **`LICENSE`** — added (GPL-3.0). `package.json` declared `GPL-3.0-or-later` with
      no licence file present, so the grant was never actually made and redistribution
      was not permitted.
- [ ] **Secret scan over all history** — gitleaks or trufflehog across all 708 commits.
      A pattern scan came back clean and no `.env`, `secrets.bin`, or key file was ever
      tracked, but that is not a substitute for a real scan.
- [ ] **Outstanding high-severity dependabot alert** — triage and fix at the root.
- [ ] **Merge `beta` → `main`** — main sits at v1.0.0, beta at v1.9.2-beta.3: 331
      commits, 196 user-facing. The first public impression should not be a year stale.
      Cuts v1.9.2 as the first real stable release.

Not blocking:

- [ ] README install section rewritten around the one-liner.
- [ ] `SECURITY.md`; `CONTRIBUTING.md` pointing at `docs/contributing.md`.
- [ ] Branch protection on `main`.

**Visibility is per-repository on GitHub — a private `beta` alongside a public `main`
is not possible**, on any plan. Splitting into two repositories would also mean every
deployment needs credentials to reach its update track, which is a real operational
cost for a cosmetic gain. `beta` becomes public with everything else.

`.git` is 134 MB against a 3 MB source tree, because build output was committed at some
point. Leave it: shrinking it means rewriting history, and deployments track these
branches — a force-push breaks their updater.

---

## 8. Phasing

Each phase stands alone and is worth shipping on its own.

1. **Public-ready.** Licence, secret scan, dependabot, docs. No packaging work.
2. **Artifacts.** Bundle + CI matrix + checksums attached to releases. Nothing consumes
   them yet, so nothing can regress.
3. **Installer, Linux.** `install.sh` for x64 and arm64 — the platform actually
   deployed today, and the one needing no signing decision.
4. **Artifact updater.** Teach `updater.ts` the packaged path. Now installs made in
   phase 3 can update themselves.
5. **macOS and Windows installers.** Same artifacts, different service registration.
6. **Optional later.** Native `.deb`/`.pkg`/`.msi`, and Docker for Linux servers.

`beta` → `main` should happen during phase 1, before the repository is public.

---

## 9. Open questions

- **Licence.** GPL-3.0 is kept and now actually granted. AGPL's advantage is largely
  theoretical here — the app must sit on the LAN to reach the gear, so it cannot
  meaningfully be run as a hosted service. Apache-2.0 would attract more vendor
  adoption at the cost of copyleft. Worth settling now: one other contributor holds
  copyright on 11 commits today, and after the repository is public a change needs
  agreement from everyone who has contributed.
- **32-bit Pi.** Is `linux-armv7` needed, or are all deployments 64-bit? It is one more
  matrix entry, not a design change.
- **Signing.** Deferred, not rejected. If native installers are ever wanted, this comes
  back at ~$300/year.
