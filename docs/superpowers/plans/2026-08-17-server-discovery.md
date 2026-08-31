# Server Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach a server at `http://stage-utility.local/` instead of hunting for
the address DHCP handed it.

**Architecture:** No mDNS code runs in the app. The installer asks for a name and
writes it to `avahi-daemon.conf` on Linux or `scutil` on macOS, so the platform's
own responder does the advertising. Where multicast is blocked, a `find` command
reuses the UDP discovery responder already shipped for kiosk enrolment.

**Tech Stack:** POSIX shell, `avahi-daemon`, `scutil`, existing
`main/services/kiosk-discovery.ts` codec, `node:dgram`.

**Spec:** `docs/superpowers/specs/2026-08-17-server-discovery-design.md`

## Global Constraints

- No emojis anywhere — UI, code, comments, commit messages.
- **No mDNS responder runs inside the app.** Sharing UDP 5353 with a system
  daemon is documented to make `<hostname>.local` stop resolving over IPv4 —
  the exact failure this feature exists to prevent.
- The **system hostname is never changed.** Only what avahi advertises changes.
- Default name is exactly `stage-utility`. Names must match
  `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
- Windows is out of scope. It resolves `.local` but has no responder to register
  with, and requiring Apple Bonjour is not acceptable.
- **Linux and macOS share one code path.** `install.sh` runs on both; only the
  backend that stores the name differs. Setting it is never a manual step.
- Every new `catch` rethrows or returns the failure. A `catch` that only logs is
  a defect.
- Kill a test server by **port**, never `pkill -f`.
- Run `npm run lint && npm run type-check && npm test && npm run build` before
  every commit.

## File Structure

| File | Responsibility |
|---|---|
| `main/services/mdns-name.ts` | Pure: validate a name, build the avahi config line. |
| `scripts/lib/advertised-name.sh` | Sourced: validate, detect platform, read/write the name, check for a clash. The ONLY place either backend is touched. |
| `scripts/install.sh` | Prompt, then call the helper. |
| `scripts/stage-utility-name` | Change the advertised name later, as root. |
| `scripts/stage-utility-find` | Broadcast a probe, print what answers. |
| `main/services/routes/system-routes.ts` | Report reachable addresses. |

---

### Task 1: Name rules

**Files:**
- Create: `main/services/mdns-name.ts`
- Test: `main/services/mdns-name.test.ts`

**Interfaces:**
- Produces: `isValidMdnsName(name: string): boolean`,
  `avahiHostNameLine(name: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isValidMdnsName, avahiHostNameLine } from "./mdns-name.js";

// This string is written into a config file as root and broadcast to a network.
// Both are reasons to be strict about it.
describe("what may be advertised", () => {
  test("the default is valid", () => {
    assert.equal(isValidMdnsName("stage-utility"), true);
  });

  test("plain names and digits are fine", () => {
    for (const ok of ["foh", "stage2", "stage-foh-2"]) {
      assert.equal(isValidMdnsName(ok), true, `${ok} was rejected`);
    }
  });

  test("anything that could break the config file or the label is refused", () => {
    for (const bad of [
      "", "-lead", "trail-", "Stage-Utility", "has space", "has.dot",
      "has_underscore", "a".repeat(64),
      "x\nhost-name=evil",      // a newline would inject a second directive
      "x=y", "#comment",
    ]) {
      assert.equal(isValidMdnsName(bad), false, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("the config line is exactly what avahi expects", () => {
    assert.equal(avahiHostNameLine("stage-utility"), "host-name=stage-utility");
  });

  test("an invalid name cannot produce a config line at all", () => {
    assert.throws(() => avahiHostNameLine("x\nhost-name=evil"), /invalid/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/mdns-name.test.ts`
Expected: FAIL, `Cannot find module './mdns-name.js'`.

- [ ] **Step 3: Implement**

```ts
// The one name this server answers to, and the single line that sets it.
//
// Strict on purpose: the string is written into a root-owned config file and
// broadcast to a network. A newline in it would inject a second directive.

/** A DNS label: lowercase, digits and hyphens, not leading or trailing. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidMdnsName(name: string): boolean {
  return LABEL.test(name);
}

/** The avahi-daemon.conf directive. Throws rather than emit an unsafe line. */
export function avahiHostNameLine(name: string): string {
  if (!isValidMdnsName(name)) throw new Error(`invalid mDNS name: ${JSON.stringify(name)}`);
  return `host-name=${name}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/mdns-name.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the injection guard**

Change `LABEL` to `/^[a-z0-9-]+$/` — which still looks reasonable — and re-run.
The newline case must still fail because `.` and `\n` are excluded; confirm which
cases go red and that the injection one is among them. Restore.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/mdns-name.ts main/services/mdns-name.test.ts
git commit -m "feat(discovery): name rules for what a server advertises

Strict because the string is written into a root-owned config file and shouted
at a network: a newline would inject a second avahi directive. avahiHostNameLine
throws rather than emit an unsafe line, so no caller can bypass the check.

Guard proven: loosening the pattern makes the injection case go red."
```

---

### Task 2: One name helper, two backends

**Files:**
- Create: `scripts/lib/advertised-name.sh`

**Interfaces:**
- Produces, for `install.sh` and `stage-utility-name` to source:
  - `an_validate <name>` — 0 if the name is a legal DNS label
  - `an_platform` — prints `linux`, `macos`, or `unsupported`
  - `an_current` — prints the name currently advertised, or empty
  - `an_holder <name>` — prints the address already answering for `<name>.local`, or empty
  - `an_set <name>` — writes it and reloads the responder; non-zero on failure

Both platforms set the **advertised** name and leave the **system** hostname
alone. That parallel is why one helper covers both:

| | Advertised | System hostname |
|---|---|---|
| Linux | `avahi-daemon.conf` `host-name=` | untouched |
| macOS | `scutil --set LocalHostName` | `HostName` untouched |

- [ ] **Step 1: Write it**

```sh
# The advertised name, on whichever platform this is.
#
# Sourced by install.sh and stage-utility-name so the directive is written in
# exactly one place. Two copies of "how to set the name" is how the two drift,
# and this one is written as root into a network config.

# A DNS label: lowercase, digits, hyphens, not leading or trailing. Strict
# because a newline would inject a second avahi directive.
an_validate() {
  printf '%s' "$1" | grep -qE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
}

an_platform() {
  case "$(uname -s)" in
    Linux)  command -v avahi-daemon >/dev/null 2>&1 && echo linux || echo unsupported ;;
    Darwin) echo macos ;;
    *)      echo unsupported ;;
  esac
}

an_current() {
  case "$(an_platform)" in
    linux) sed -n 's/^[[:space:]]*host-name=//p' /etc/avahi/avahi-daemon.conf 2>/dev/null | tail -1 ;;
    macos) scutil --get LocalHostName 2>/dev/null ;;
  esac
}

# Who already answers for this name, if anyone. Empty when it is free — or when
# the tool is missing, which is not the same thing and must not read as a clash.
an_holder() {
  case "$(an_platform)" in
    linux)
      command -v avahi-resolve >/dev/null 2>&1 || return 0
      avahi-resolve -4 -n "$1.local" 2>/dev/null | awk '{print $2}'
      ;;
    macos)
      command -v dns-sd >/dev/null 2>&1 || return 0
      # dns-sd never exits on its own, so it is bounded and its first hit taken.
      (dns-sd -G v4 "$1.local" & pid=$!; sleep 2; kill "$pid" 2>/dev/null) 2>/dev/null \
        | awk '/'"$1"'\.local/ {print $6; exit}'
      ;;
  esac
}

an_set() {
  an_validate "$1" || { echo "error: invalid name: $1" >&2; return 1; }
  case "$(an_platform)" in
    linux)
      conf=/etc/avahi/avahi-daemon.conf
      # Replace ours if present, insert if not. NEVER append blindly: avahi takes
      # the LAST host-name line, so a second write would leave a stale directive
      # above the live one and make the file lie about what is advertised.
      if grep -qE '^[[:space:]]*host-name=' "$conf"; then
        sed -i.bak "s|^[[:space:]]*host-name=.*|host-name=$1|" "$conf"
      else
        sed -i.bak "/^\[server\]/a\\
host-name=$1" "$conf"
      fi
      rm -f "$conf.bak"
      systemctl reload-or-restart avahi-daemon
      ;;
    macos)
      # LocalHostName is the Bonjour name. ComputerName (the display name) and
      # HostName (the system one) are deliberately not touched.
      scutil --set LocalHostName "$1"
      ;;
    *)
      echo "error: no mDNS responder to register with on this platform" >&2
      return 1
      ;;
  esac
}
```

- [ ] **Step 2: Verify the parsing on this machine, without writing**

```bash
. scripts/lib/advertised-name.sh
an_platform                      # macos on a Mac, linux on a Pi
an_current                       # the name currently advertised
an_validate stage-utility && echo ok
an_validate 'x
host-name=evil' && echo "BAD: injection accepted" || echo "injection refused"
an_holder stage-utility          # empty, or the address of whoever holds it
```

`an_set` is not run here — it changes a real machine. It is exercised in Task 3
against a box you are willing to change.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/advertised-name.sh
git commit -m "feat(discovery): one helper for the advertised name, two backends

Linux writes avahi-daemon.conf, macOS calls scutil --set LocalHostName. Both set
the ADVERTISED name and leave the system hostname alone — on macOS that means
LocalHostName only, never ComputerName or HostName.

Sourced by install.sh and stage-utility-name so the directive is written in
exactly one place. The Linux write replaces rather than appends: avahi takes the
LAST host-name line, so appending twice would leave the file lying about what is
advertised.

A missing avahi-resolve or dns-sd returns empty, which is 'unknown' and must not
read as 'clash'."
```

---

### Task 3: The installer asks, on both platforms

**Files:**
- Modify: `scripts/install.sh`

**Interfaces:**
- Consumes: `an_validate`, `an_platform`, `an_holder`, `an_set` from
  `scripts/lib/advertised-name.sh`.

- [ ] **Step 1: Prompt, before the systemd branch**

Place this **above** the `if ! command -v systemctl` early exit at line 116 —
otherwise macOS returns before ever reaching it, which is exactly the bug that
made this look Linux-only in the first place.

```sh
. "$(dirname "$0")/lib/advertised-name.sh"

ADVERTISE_NAME="${ADVERTISE_NAME:-stage-utility}"
if [ -z "${NO_ADVERTISE:-}" ] && [ "$(an_platform)" != "unsupported" ]; then
  if [ -t 0 ] && [ -z "${NAME_GIVEN:-}" ]; then
    printf 'Advertise this machine as "%s.local"? [Y/n] ' "$ADVERTISE_NAME"
    read -r reply
    case "$reply" in [Nn]*) NO_ADVERTISE=1 ;; esac
    if [ -z "${NO_ADVERTISE:-}" ]; then
      printf 'Name [%s]: ' "$ADVERTISE_NAME"
      read -r typed
      [ -n "$typed" ] && ADVERTISE_NAME="$typed"
    fi
  fi
fi

if [ -z "${NO_ADVERTISE:-}" ] && [ "$(an_platform)" != "unsupported" ]; then
  an_validate "$ADVERTISE_NAME" || die "not a usable name: ${ADVERTISE_NAME}"
  holder="$(an_holder "$ADVERTISE_NAME")"
  # Checked BEFORE writing. Left alone, avahi renumbers a clash to -2: a name
  # nobody chose and nobody can predict. A clash found now costs a question.
  if [ -n "$holder" ] && [ "$holder" != "$(an_own_address)" ]; then
    die "${ADVERTISE_NAME}.local already answers at ${holder}. Re-run with --name <other>."
  fi
  an_set "$ADVERTISE_NAME" || die "could not set the advertised name"
  log "Advertising as ${ADVERTISE_NAME}.local"
fi
```

Add `an_own_address` to the helper — the machine's first non-loopback IPv4, via
`hostname -I` on Linux and `ipconfig getifaddr en0` with an `ifconfig` fallback
on macOS — so re-running the installer on the machine that already holds the
name is not mistaken for a clash.

- [ ] **Step 2: Parse the flags**

`--name <name>` sets `ADVERTISE_NAME` and `NAME_GIVEN=1`; `--no-advertise` sets
`NO_ADVERTISE=1`. Both go in the existing argument loop beside `--user`.

- [ ] **Step 3: Fix the closing output**

It names `settings-window.html`, retired in the app-shell work. Replace, and
print the advertised URL when there is one:

```sh
log "  Stage Utility : http://${ADVERTISE_NAME}.local/  (or http://${LAN_IP}/)"
log "  Settings      : http://${ADVERTISE_NAME}.local/settings"
```

- [ ] **Step 4: Verify on Linux**

```bash
sudo ./scripts/install.sh --name stage-test
hostname                                             # unchanged
grep -c '^host-name=' /etc/avahi/avahi-daemon.conf   # exactly 1
avahi-resolve -n stage-test.local
sudo ./scripts/install.sh --name stage-test          # twice
grep -c '^host-name=' /etc/avahi/avahi-daemon.conf   # still exactly 1
```

- [ ] **Step 5: Verify on macOS**

```bash
scutil --get LocalHostName            # note it, to restore afterwards
sudo ./scripts/install.sh --name stage-test
scutil --get LocalHostName            # stage-test
scutil --get HostName                 # STILL UNSET — the narrow lever was used
dns-sd -G v4 stage-test.local         # resolves
sudo scutil --set LocalHostName <the original>   # restore
```

The `HostName` assertion is the point of the macOS run: it proves the installer
took the advertised-name lever rather than renaming the machine.

- [ ] **Step 6: Verify the refusal**

With `stage-test.local` live on one box, run the installer on a **second**
machine with `--name stage-test`. It must exit non-zero, name the holder's
address, and leave that machine's config untouched.

- [ ] **Step 7: Commit**

```bash
git add scripts/install.sh scripts/lib/advertised-name.sh
git commit -m "feat(discovery): the installer asks for a name, on Linux and macOS

The prompt sits ABOVE the systemd early-exit. Below it, macOS returns before
reaching the prompt — which is the bug that made install.sh look Linux-only.

Sets the ADVERTISED name on both platforms and never the system hostname; the
macOS run asserts scutil --get HostName is still unset, which is what proves the
narrow lever was used.

Refuses a name already answering on the LAN rather than letting the responder
silently renumber it, and ignores the machine's own address so re-running the
installer is not mistaken for a clash.

Also corrects the closing output, which pointed at the retired
settings-window.html.

Verified on both platforms, including installing twice for idempotence and a
second machine for the refusal."
```

---

### Task 4: Rename without reinstalling

**Files:**
- Create: `scripts/stage-utility-name`
- Modify: `scripts/install.sh` (install it to `/usr/local/sbin`)

**Interfaces:**
- Consumes: `an_validate`, `an_current`, `an_set` from
  `scripts/lib/advertised-name.sh`.

- [ ] **Step 1: Write it**

A root-run script that sources the helper and holds **no platform knowledge of
its own** — that all lives in the helper, so this works on macOS the day it works
on Linux. With no argument it prints the current name; with one it validates and
sets, then prints the new URL.

```sh
#!/bin/sh
# Change the name this machine is advertised under.
#
# Not a setting in the app. The service runs as an unprivileged user
# (SERVICE_USER, the installing account), so it cannot edit avahi's config — and
# handing a web-facing process the means to rewrite root-owned network
# configuration is a worse trade than typing one command.
set -eu
. /usr/local/lib/stage-utility/advertised-name.sh

if [ $# -eq 0 ]; then
  cur="$(an_current)"
  [ -n "$cur" ] && echo "${cur}.local" || echo "not advertised"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "error: needs root" >&2; exit 1; }
an_validate "$1" || { echo "error: not a usable name: $1" >&2; exit 1; }
an_set "$1"
echo "Now advertised at http://$1.local/"
```

`install.sh` copies the helper to `/usr/local/lib/stage-utility/` and the script
to `/usr/local/sbin/`, so the sourced path exists on an installed machine.

- [ ] **Step 2: Verify on Linux**

```bash
sudo stage-utility-name stage-foh
avahi-resolve -n stage-foh.local
stage-utility-name                                    # prints stage-foh.local
sudo stage-utility-name 'x
host-name=evil'                                       # refused
grep -c '^host-name=' /etc/avahi/avahi-daemon.conf    # still exactly 1
```

- [ ] **Step 3: Verify on macOS**

```bash
scutil --get LocalHostName          # note it, to restore afterwards
sudo stage-utility-name stage-foh
scutil --get LocalHostName          # stage-foh
scutil --get HostName               # still unset
stage-utility-name                  # prints stage-foh.local
sudo scutil --set LocalHostName <the original>
```

- [ ] **Step 4: Print it in the Homebrew caveats**

A brew install is the documented macOS route for a laptop, and brew never runs
`sudo`, so it cannot set the name itself. Add to the formula's caveats:

```
To reach this machine by name on the network:
  sudo stage-utility-name stage-utility
```

One named command, not a trip through System Settings — and the same command
used to rename later on either platform. This is the only place the name is not
set for you, and the caveats say so.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage-utility-name scripts/install.sh
git commit -m "feat(discovery): stage-utility-name changes the advertised name

Holds no platform knowledge of its own — it sources the same helper install.sh
uses, so Linux and macOS behave identically and the directive is written in one
place.

Not a setting in the app: the service runs unprivileged and cannot edit avahi's
config, and handing a web-facing process the means to rewrite root-owned network
configuration is the wrong trade.

Brew never runs sudo, so a Homebrew install prints this command in its caveats —
the one place the name is not set for you.

Verified on both platforms: renames and resolves, prints the current name with no
argument, refuses an injection attempt with the config untouched."
```

---

### Task 5: Find a server where multicast is blocked

**Files:**
- Create: `scripts/stage-utility-find`
- Test: `main/services/discovery-find.test.ts`

**Interfaces:**
- Consumes: `encodeProbe`, `decodeReply` from `main/services/kiosk-discovery.js`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as dgram from "node:dgram";

import { findServers } from "./discovery-find.js";
import { encodeReply } from "./kiosk-discovery.js";

// Broadcast, not multicast — which is the whole point: event networks that block
// multicast kill mDNS and leave this working.
describe("finding servers by broadcast", () => {
  test("collects every server that answers within the window", async () => {
    const fake = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((r) => fake.bind(0, "127.0.0.1", r));
    const { port } = fake.address() as { port: number };
    fake.on("message", (_m, rinfo) => {
      fake.send(encodeReply({ serverId: "s1", name: "FOH", url: "http://127.0.0.1:8788" }),
        rinfo.port, rinfo.address);
    });

    const found = await findServers({ port, host: "127.0.0.1", waitMs: 400 });
    fake.close();
    assert.deepEqual(found.map((f) => f.name), ["FOH"]);
  });

  test("no answer is an empty list, not a hang or a throw", async () => {
    const found = await findServers({ port: 59999, host: "127.0.0.1", waitMs: 200 });
    assert.deepEqual(found, []);
  });

  test("rubbish on the port is ignored", async () => {
    const fake = dgram.createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((r) => fake.bind(0, "127.0.0.1", r));
    const { port } = fake.address() as { port: number };
    fake.on("message", (_m, rinfo) => fake.send(Buffer.from("not json"), rinfo.port, rinfo.address));
    const found = await findServers({ port, host: "127.0.0.1", waitMs: 300 });
    fake.close();
    assert.deepEqual(found, []);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, `Cannot find module './discovery-find.js'`.

- [ ] **Step 3: Implement**

Create `main/services/discovery-find.ts` exporting
`findServers(opts: { port?: number; host?: string; waitMs?: number }):
Promise<{ serverId: string; name: string; url: string }[]>`. It sends one
`encodeProbe` datagram, collects `decodeReply` results until `waitMs` elapses,
deduplicates by `serverId`, and always resolves — never rejects on a timeout,
because "nothing answered" is an answer.

Then `scripts/stage-utility-find` is a thin node wrapper printing one line per
server: `FOH  http://192.168.1.50  (s1)`.

- [ ] **Step 4: Run the tests**

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify against the real responder**

Start a server with `kioskDiscovery` enabled on a copied data dir and a spare
port, run the finder, confirm it prints that server.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/discovery-find.ts main/services/discovery-find.test.ts scripts/stage-utility-find
git commit -m "feat(discovery): stage-utility-find locates servers by broadcast

Reuses the kiosk discovery codec rather than a second wire format. Broadcast,
not multicast, which is the point: event networks that block multicast kill mDNS
and leave this working — the network that caused this whole feature.

Never rejects on a timeout: nothing answering is an answer, and a finder that
throws is a finder people stop trusting."
```

---

### Task 6: The server says where it is

**Files:**
- Modify: `main/services/routes/system-routes.ts`
- Modify: the Advanced settings section

- [ ] **Step 1: Report the addresses**

Extend the existing version/system endpoint with `addresses: string[]` — the
advertised `.local` URL when `avahi-daemon.conf` names one, and the LAN URL.
Read the config file rather than storing a duplicate: the file is the truth, and
a copy in settings would go stale the first time somebody ran
`stage-utility-name`.

Reading it must not throw where the file is absent — macOS and Windows have no
`avahi-daemon.conf`, and that is not an error.

- [ ] **Step 2: Show it**

Render the list in Advanced under a "This server is reachable at" heading, each
entry copyable, with a line naming `stage-utility-name` as the way to change it.

- [ ] **Step 3: Verify**

On a Linux box with a name set, confirm both URLs appear and both load the app
from another machine. On macOS, confirm only the LAN URL appears and nothing
throws.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git commit -m "feat(discovery): the server says where it is reachable

Read from avahi-daemon.conf rather than duplicated into settings — the file is
the truth, and a copy would go stale the first time somebody ran
stage-utility-name. A missing config file is not an error; macOS and Windows do
not have one."
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/ops/finding-the-server.md`
- Modify: `docs/ops/install-and-config.md`

- [ ] **Step 1: Write it**

Cover: the default name and how to change it; that the system hostname is not
touched; that `.local` needs multicast and `stage-utility-find` is the fallback;
that Windows resolves `.local` but cannot advertise, so a Windows server is
reached by address; and — plainly — that bare `ping stage-utility` without the
suffix depends on the router registering DHCP names and is not promised.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: finding a Stage Utility server on the network"
```

---

## Self-review

**Spec coverage.** Use the system responder → Tasks 2 and 3, and the constraint
that forbids an in-app one. Linux via `avahi-daemon.conf` and macOS via `scutil`
→ Task 2. Installer asks, on both → Task 3. Refuses a taken name → Task 3.
System hostname left alone, asserted on both platforms → Task 3 steps 4 and 5.
Rename later as root → Task 4. Homebrew caveat → Task 4 step 3b. Windows
deferred → Global Constraints and Task 6. UDP fallback → Task 5. Server reports
its addresses → Task 6. `settings-window.html` correction → Task 3. Bare `ping`
not promised → Task 7.

**Corrected during review:** an earlier draft called `install.sh` Linux-only and
deferred macOS to a manual step. It is not — it runs on macOS, builds, and exits
early at the systemd check. The prompt therefore sits above that early exit and
both platforms are handled by one code path (Tasks 2 and 3).

**Known gap accepted:** a **Homebrew** install cannot set the name itself. Brew
never runs `sudo` and `scutil --set LocalHostName` requires root, so the
formula's caveats print `sudo stage-utility-name stage-utility` (Task 4 step 4). One
named command, and the only place the name is not set for you.

**Type consistency.** `an_validate`, `an_platform`, `an_current`, `an_holder`,
`an_own_address` and `an_set` are defined in Task 2 and are the only names used
by Tasks 3 and 4. `findServers(opts)` matches its test and the wrapper.

**Numbering note:** the helper task renumbered everything after it. The headings
in this file are authoritative.
