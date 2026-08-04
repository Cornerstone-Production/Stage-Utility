# Homebrew

On macOS and Linux, Stage Utility can be installed and kept running by Homebrew
instead of the [one-line installer](install-and-config.md#install).

```bash
brew tap Cornerstone-Production/stage-utility
brew install stage-utility
brew services start stage-utility
```

Then open `http://localhost:8788/`. Configuration and history live in
`$(brew --prefix)/var/stage-utility`, outside the keg, so `brew upgrade` never
touches them.

| | |
|---|---|
| `brew services start stage-utility` | run it now and at login |
| `brew services stop stage-utility` | stop it |
| `brew services info stage-utility` | is it running, and where are the logs |

To move to a newer release, see [Upgrading from the terminal](#upgrading-from-the-terminal)
below — `brew upgrade` on its own leaves the service stopped.

The formula installs a prebuilt archive that already contains its own Node
runtime, so it depends on nothing and compiles nothing.

## Which to use

The one-line installer registers a **system** service that starts at boot,
before anyone logs in, and can serve on port 80. That is what a stage machine or
a Pi wants.

Homebrew runs it as a **user** agent that starts at login, on port 8788 only.
That suits a laptop or a workstation where the app is one of several things you
run, and where `brew upgrade` alongside everything else is convenient.

## Upgrading from the terminal

**`brew upgrade` does not restart the service.** It stops it, swaps the keg, and
prints a caveat telling you to restart it yourself. Homebrew says so in its own
output:

```
To restart stage-utility-beta after an upgrade:
  brew services restart cornerstone-production/stage-utility/stage-utility-beta
```

So an upgrade on its own leaves the app **stopped**, with nothing on port 8788 and
no error to tell you. Two more things can go wrong on macOS after that:

- `brew services start` can fail with **`Bootstrap failed: 5: Input/output error`**
  when the old launchd label is still registered. Clear it with
  `launchctl bootout "gui/$(id -u)/homebrew.mxcl.<formula>"` and start again.
- launchd may **park** the start when it is issued outside a foreground session —
  `launchctl print` shows `runs = 0` with `pended nondemand spawn = speculative`.
  brew reports success and nothing runs. `launchctl kickstart -k -p
  "gui/$(id -u)/homebrew.mxcl.<formula>"` forces it.

Doing it by hand, that is:

```bash
brew upgrade stage-utility
brew services restart stage-utility
curl -fsS http://127.0.0.1:8788/api/version   # confirm it actually came back
```

The last line is not optional. Brew reporting success is not evidence that
anything is listening.

### `scripts/stage-upgrade`

The repo ships a script that does all of the above, recovers from both failures,
and polls until the server answers rather than trusting brew:

```bash
scripts/stage-upgrade                 # beta track
scripts/stage-upgrade stage-utility   # stable track
```

Copy it somewhere on your `PATH` to use it by name. It exits non-zero and names
what to check if the server never comes back, and it leaves the service alone if
`brew upgrade` itself fails. Set `STAGE_UTILITY_PORT` if you do not serve on 8788.

On Linux, `brew services` uses systemd and the two launchd recovery steps are
skipped; the upgrade, restart and health check work the same.

**Or use the in-app updater**, which has none of these problems — see below.

## In-app updates

**Settings → Advanced → Updates** works here, and so does switching tracks. The
app never writes into the keg: it runs `brew update && brew upgrade` for you, so
Homebrew stays the source of truth and `brew info` keeps telling the truth.

It also restarts the service properly afterwards, clearing a stale launchd label
first and forcing the spawn after — the two steps a plain `brew upgrade` skips.
This is the one place that reliably can: on macOS the server itself runs as a
`gui/<uid>` launchd agent, so the updater it spawns is already inside that
session and may bootstrap into it. A `post_install` hook in the formula cannot —
it runs detached and launchd refuses with `5: Input/output error` — which is why
the terminal path needs the extra step and this one does not.

Switching tracks swaps which formula is installed, because brew has no notion of
a channel within one formula:

| Track | Formula |
|---|---|
| main | `stage-utility` |
| beta | `stage-utility-beta` |

The app resolves the target formula **before** uninstalling the current one, so a
formula that cannot be found fails while the machine still has a working install.
Uninstalling stops the background agent, so the switch finishes by starting the
new formula's service explicitly.

**Your data survives a switch.** Config, history and secrets live in
`$(brew --prefix)/var/stage-utility`, outside the keg, and `brew uninstall`
removes the keg only.

If a switch fails partway — after the uninstall but before the install — the
machine is left with nothing installed and one `brew install stage-utility`
puts it back. That window is the price of brew owning the keg; installing both
formulae at once is not an option, since they collide on the same binary name.

## The tap

The formula is generated from each release by
`scripts/update-homebrew-formula.mjs` and published to
[`Cornerstone-Production/homebrew-stage-utility`](https://github.com/Cornerstone-Production/homebrew-stage-utility).
It is not in `homebrew-core`, which requires a level of general notability this
project does not have.

Edit `packaging/homebrew/stage-utility.rb` in this repository, never the copy in
the tap — the tap is overwritten on every release.
