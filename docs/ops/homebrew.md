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
| `brew update && brew upgrade stage-utility` | move to the newest release |
| `brew services info stage-utility` | is it running, and where are the logs |

The formula installs a prebuilt archive that already contains its own Node
runtime, so it depends on nothing and compiles nothing.

## Which to use

The one-line installer registers a **system** service that starts at boot,
before anyone logs in, and can serve on port 80. That is what a stage machine or
a Pi wants.

Homebrew runs it as a **user** agent that starts at login, on port 8788 only.
That suits a laptop or a workstation where the app is one of several things you
run, and where `brew upgrade` alongside everything else is convenient.

## In-app updates

**Settings → Advanced → Updates** works here, and so does switching tracks. The
app never writes into the keg: it runs `brew update && brew upgrade` for you, so
Homebrew stays the source of truth and `brew info` keeps telling the truth.

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
