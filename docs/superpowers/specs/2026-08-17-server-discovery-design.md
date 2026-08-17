# Finding a Stage Utility server on the network

**Goal.** Reach a server by name — `http://stage-utility.local/` — instead of
hunting for the IP that DHCP happened to hand it.

**Why.** A Pi deployed at an event came up on an unknown network with an unknown
address, and there was no way to find it from a laptop standing next to it.

## The principle

**Use the platform's own mDNS responder wherever one exists. Embed one only
where there is none.**

This is not a preference. Running a second responder on UDP 5353 beside a system
daemon is a known way to break the thing being built — Homebridge documents the
symptom as `<hostname>.local` ceasing to resolve over IPv4 while the address
still works, because the system delivers IPv4 mDNS traffic to only one listener.
Their recommendation on Linux is Avahi, the system daemon.

## Where each platform lands

Every platform Stage Utility runs on is already a capable mDNS **client**.
Windows resolves `.local` hostnames from 10 1903 onward, macOS and Linux with
`nss-mdns` have for far longer. So finding a server works from any machine
regardless of what that machine can advertise. Only a machine acting as a
*server* needs a responder.

| Server platform | Responder | How the name is set |
|---|---|---|
| Raspberry Pi, Ubuntu | `avahi-daemon`, already installed and running | `host-name` in `avahi-daemon.conf` |
| macOS | `mDNSResponder`, part of the OS | `scutil --set LocalHostName` |
| Windows | **none** — Windows resolves `.local` but does not answer for itself | deferred; see below |

### Linux

`avahi-daemon.conf` has a `[server] host-name` setting whose documented
behaviour is to "set the host name avahi-daemon tries to register on the LAN. If
omitted defaults to the system host name."

So the installer writes `host-name=stage-utility` and reloads avahi. The
machine's own hostname is untouched — only what it announces changes — and
avahi keeps the advertised addresses correct across DHCP changes on its own.
Nothing new runs, and nothing contends for 5353.

Setting the *system* hostname was considered and rejected: it changes the
machine's identity for every other purpose, and on a Proxmox guest that is
someone else's naming convention to own.

### macOS

`scutil --set LocalHostName stage-utility` is the OS's supported way to change
the advertised `.local` name, and is what the Sharing preference pane writes.
Offered by the installer, not assumed.

### Windows — deferred

Windows has no system responder to register with, and requiring users to install
Apple's Bonjour is not acceptable. A Windows server is reachable by IP and by
the discovery command below.

Windows is also the one platform where embedding a responder is *safe*, since
there is no system daemon to contend with. That is the shape of the follow-up if
a Windows server ever needs a name: an embedded responder on Windows only,
justified precisely by the absence that rules it out elsewhere.

## Choosing the name

The installer **asks for the name**, defaulting to `stage-utility`, and prints
the URL that will result. It changes what a machine announces to a network,
which is not a thing to do silently even when it is the thing the operator
wants. `--name` sets it for unattended installs and `--no-advertise` skips it.

Asking rather than assuming is what makes a second server bearable. Left to
itself, avahi resolves a name clash by appending a number, so the second box on
a LAN silently becomes `stage-utility-2.local` — a name nobody chose and nobody
can predict. Being asked means the FOH box can be `stage-foh` and the portable
rig `stage-utility`, decided by the person who knows which is which.

**The installer checks the name before taking it.** If `<name>.local` already
resolves on this LAN, it says which address answered and asks for another rather
than writing a config that avahi will quietly renumber. A clash that surfaces at
install time costs a question; one that surfaces later costs an afternoon.

Renaming afterwards is a root-run command — `stage-utility-name <name>`,
installed beside the existing `stage-upgrade` script — not a setting in the app.
The service runs as an unprivileged user (`SERVICE_USER`, the invoking account),
so the app cannot edit `avahi-daemon.conf` and should not be given the means to.
Settings displays the current advertised name and says where to change it.

## When multicast is blocked

Guest and event networks frequently block multicast, which disables mDNS
entirely — the network the original problem happened on.

The kiosk discovery responder already listens on UDP 8789 and answers a
broadcast probe with the server's id, name and URL. A `stage-utility find`
command sends one probe and prints what answers, reusing the existing codec in
`main/services/kiosk-discovery.ts`. Broadcast is not multicast, so this works
where mDNS does not.

## Saying where the server is

The app knows its own addresses and currently keeps that to itself. Settings
gains a line naming every way to reach this server — the `.local` name when one
is advertised, and the LAN address — and the installer prints the same at the
end of a run.

`install.sh`'s closing output also points at `settings-window.html`, which was
retired in the app-shell work. Corrected here because it is the same three
lines.

## What is not promised

Bare `ping stage-utility`, without the suffix, resolves only where the network's
router registers DHCP client names into its own DNS. Many do; an event network
is not one to count on. `stage-utility.local` is the part that is guaranteed
wherever multicast is allowed, and the documentation says so plainly rather than
implying both work.

## Testing

mDNS cannot be meaningfully unit tested; the risk lives in the platform
integration, so that is where the proof goes.

- On a Pi and on Ubuntu: after install, `avahi-resolve -n stage-utility.local`
  returns the machine's address, and `ping stage-utility.local` succeeds from a
  second machine on the same LAN.
- The system hostname is unchanged after install, verified with `hostname`.
- Declining the prompt leaves `avahi-daemon.conf` untouched.
- Installing a **second** server with a name already on the LAN is refused with
  the address of the machine holding it, and no config is written. This is the
  case the design exists for, so it is proven rather than assumed: the failure
  it prevents is a box that silently answers to a name nobody chose.
- `stage-utility-name` changes the advertised name and the new one resolves,
  without a reinstall and without touching the system hostname.
- On a network with multicast blocked, `stage-utility find` still locates the
  server — reusing the discovery tests that already exist for the probe codec.
- The installer's closing output names an address that actually serves a page,
  checked by requesting it.
