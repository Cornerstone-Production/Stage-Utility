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
- Every new `catch` rethrows or returns the failure. A `catch` that only logs is
  a defect.
- Kill a test server by **port**, never `pkill -f`.
- Run `npm run lint && npm run type-check && npm test && npm run build` before
  every commit.

## File Structure

| File | Responsibility |
|---|---|
| `main/services/mdns-name.ts` | Pure: validate a name, build the avahi config line. |
| `scripts/install.sh` | Prompt, conflict check, write the config, reload avahi. |
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

### Task 2: The installer asks, and checks

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Add the flags and the prompt**

Parse `--name <name>` and `--no-advertise`. When neither is given and the shell
is interactive, prompt:

```sh
# Asked, not assumed: this changes what a machine announces to a network. The
# default is the answer almost everybody wants, so Enter is enough.
ADVERTISE_NAME="${ADVERTISE_NAME:-stage-utility}"
if [ -z "$NO_ADVERTISE" ] && [ -t 0 ]; then
  printf 'Advertise this machine on the network as "%s.local"? [Y/n] ' "$ADVERTISE_NAME"
  read -r reply
  case "$reply" in [Nn]*) NO_ADVERTISE=1 ;; esac
  if [ -z "$NO_ADVERTISE" ]; then
    printf 'Name [%s]: ' "$ADVERTISE_NAME"
    read -r typed
    [ -n "$typed" ] && ADVERTISE_NAME="$typed"
  fi
fi
```

- [ ] **Step 2: Refuse a name already on the LAN**

```sh
# Checked BEFORE writing. Left to itself avahi renumbers a clash to
# stage-utility-2.local — a name nobody chose and nobody can predict. A clash
# that surfaces now costs a question; one that surfaces later costs an afternoon.
if command -v avahi-resolve >/dev/null 2>&1; then
  holder="$(avahi-resolve -4 -n "${ADVERTISE_NAME}.local" 2>/dev/null | awk '{print $2}')"
  if [ -n "$holder" ] && [ "$holder" != "$(hostname -I 2>/dev/null | awk '{print $1}')" ]; then
    echo "error: ${ADVERTISE_NAME}.local is already answering at ${holder}." >&2
    echo "       Re-run with --name <something-else>." >&2
    exit 1
  fi
fi
```

- [ ] **Step 3: Write the config idempotently**

```sh
# Replace our own line if it is there, append if not. Never duplicate the
# directive: avahi takes the LAST one, so a second write would leave a stale
# line above the live one and make the file lie about what is advertised.
CONF=/etc/avahi/avahi-daemon.conf
if grep -qE '^[[:space:]]*host-name=' "$CONF"; then
  sed -i "s|^[[:space:]]*host-name=.*|host-name=${ADVERTISE_NAME}|" "$CONF"
else
  sed -i "/^\[server\]/a host-name=${ADVERTISE_NAME}" "$CONF"
fi
systemctl reload-or-restart avahi-daemon
```

Validate `ADVERTISE_NAME` against the same pattern as Task 1 before this runs;
the shell equivalent is
`printf '%s' "$ADVERTISE_NAME" | grep -qE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`.

- [ ] **Step 4: Fix the closing output**

The final report names `settings-window.html`, retired in the app-shell work.
Replace with the current settings path and add the advertised URL:

```sh
log "  Stage Utility : http://${ADVERTISE_NAME}.local/  (or http://${LAN_IP}/)"
log "  Settings      : http://${ADVERTISE_NAME}.local/settings"
```

- [ ] **Step 5: Verify on a real Linux box**

```bash
sudo ./scripts/install.sh --name stage-test
hostname                                  # unchanged — the system name is not ours to take
grep host-name /etc/avahi/avahi-daemon.conf
avahi-resolve -n stage-test.local         # returns this machine's address
sudo ./scripts/install.sh --name stage-test   # twice: exactly one host-name line
grep -c '^host-name=' /etc/avahi/avahi-daemon.conf   # must be 1
```

From a second machine: `ping stage-test.local` and open
`http://stage-test.local/`.

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(discovery): the installer asks for a name and advertises it

Sets avahi's advertised name, NOT the system hostname — the machine's identity
is not ours to take, and avahi keeps the addresses correct across DHCP on its
own. No responder runs in the app: sharing 5353 with avahi is documented to make
<hostname>.local stop resolving over IPv4.

Refuses a name already answering on the LAN rather than letting avahi silently
renumber it to -2. The write is idempotent — avahi takes the LAST host-name
line, so appending twice would leave the file lying about what is advertised.

Also corrects the closing output, which pointed at the retired
settings-window.html.

Verified on a real box: name resolves from a second machine, system hostname
unchanged, installing twice leaves exactly one directive."
```

---

### Task 3: Rename without reinstalling

**Files:**
- Create: `scripts/stage-utility-name`
- Modify: `scripts/install.sh` (install it to `/usr/local/sbin`)

- [ ] **Step 1: Write it**

A root-run script taking one argument, reusing the validation and the idempotent
write from Task 2. Factor those into a sourced helper rather than copying them —
the same directive written two different ways is how the two drift apart.

Print the new URL on success.

- [ ] **Step 2: Note why this is not in Settings**

Header comment:

```sh
# Not a setting in the app. The service runs as an unprivileged user
# (SERVICE_USER, the installing account), so it cannot edit avahi's config —
# and giving a web-facing process the means to rewrite root-owned network
# configuration would be a worse trade than typing one command.
```

- [ ] **Step 3: Verify**

```bash
sudo stage-utility-name stage-foh
avahi-resolve -n stage-foh.local
sudo stage-utility-name 'x
host-name=evil'          # refused, config untouched
grep -c '^host-name=' /etc/avahi/avahi-daemon.conf   # still 1
```

- [ ] **Step 4: Commit**

```bash
git add scripts/stage-utility-name scripts/install.sh
git commit -m "feat(discovery): stage-utility-name changes the advertised name

Shares the validation and the idempotent write with install.sh through a sourced
helper rather than a second copy — the same directive written two ways is how
they drift.

Not a setting in the app: the service runs unprivileged and cannot edit avahi's
config, and handing a web-facing process the means to rewrite root-owned network
configuration is the wrong trade.

Verified: renames and resolves; an injection attempt is refused with the file
untouched."
```

---

### Task 4: Find a server where multicast is blocked

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
server: `FOH  http://192.168.16.61  (s1)`.

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

### Task 5: The server says where it is

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

### Task 6: Documentation

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
that forbids an in-app one. Linux via `avahi-daemon.conf` → Task 2. Installer
asks → Task 2. Refuses a taken name → Task 2. Rename later as root → Task 3.
Windows deferred → Global Constraints and Task 6. UDP fallback → Task 4. Server
reports its addresses → Task 5. `settings-window.html` correction → Task 2.
Bare `ping` not promised → Task 6.

**Known gap accepted:** macOS `scutil --set LocalHostName` has no task. The spec
offers it, but `install.sh` is Linux-only and a macOS server is installed by
other means; it is documented in Task 6 as a one-line manual step rather than
automated against an installer that does not exist. Raise this if a macOS
installer is in scope.

**Type consistency.** `isValidMdnsName` and `avahiHostNameLine` from Task 1 are
the same names used in Tasks 2 and 3. `findServers(opts)` in Task 4 matches its
test and the wrapper.
