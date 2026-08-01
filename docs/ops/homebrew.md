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
| `brew upgrade stage-utility` | move to the newest release |
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

A Homebrew install is not a git checkout, so **Settings → Advanced → Updates**
reports the running version but does not apply updates — Homebrew owns the
files. Use `brew upgrade stage-utility`.

## The tap

The formula is generated from each release by
`scripts/update-homebrew-formula.mjs` and published to
[`Cornerstone-Production/homebrew-stage-utility`](https://github.com/Cornerstone-Production/homebrew-stage-utility).
It is not in `homebrew-core`, which requires a level of general notability this
project does not have.

Edit `packaging/homebrew/stage-utility.rb` in this repository, never the copy in
the tap — the tap is overwritten on every release.
