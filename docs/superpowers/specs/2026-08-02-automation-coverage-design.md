# Automation coverage — triggers and conditions for every feature

**Status:** design, not yet implemented.
**Scope:** phase 1 of a four-phase programme (see Decomposition).

## Goal

Anything the app already knows about should be able to drive an automation rule.
Today the engine watches 21 broadcast channels but exposes 8 triggers, 4
conditions and 5 actions, so most of what the server sees is unreachable from a
rule.

This phase adds **triggers and conditions only**. It introduces no new
transports, touches no device, and cannot make the app do anything it could not
already do — which is what makes it safe to land in one go.

## Decision: one entry per feature, not generic parameterised entries

Two shapes were considered.

A *parameterised* registry would cover whole classes at once — one
"an integration connects" trigger with the integration picked from a dropdown
covers all twelve and every one added later. Roughly four definitions would have
covered most of this phase.

We are **not** doing that. Entries are hand-written per feature, so each can be
worded for its own device ("OBS starts recording", not "integration X changes
state"), documented on its own terms, and given parameters that suit it rather
than a lowest common denominator.

The cost is drift: a new integration has no automation until someone writes its
entries. That is mitigated below rather than accepted.

### Guardrail: a completeness test

`automation-coverage.test.ts` asserts that every integration id known to
`integration-manager` appears in at least one trigger or condition. A new
integration therefore fails CI until its entries exist. The test names the
missing id, so the failure explains itself.

This converts the drift risk from "noticed months later in production" to
"caught on the pull request".

## What each source contributes

Triggers are pure `didFire(prev, next, params, now)` over a broadcast channel, as
today. No engine changes are required — every entry below is a registry addition.

### Integrations

| Source | Channel | Triggers | Conditions |
|---|---|---|---|
| OBS | `obs:status` | recording started/stopped (exist), streaming started/stopped, virtual cam on/off, connection lost | is recording, is connected |
| REAPER | `reaper:status` | recording started/stopped (exist), connection lost | is recording, is connected |
| ProPresenter | `propresenter:instances` | slide changed, presentation changed, an instance dropped | is connected |
| Planning Center | `pco:live` | service started/ended, item reached, item due (all exist) | a service is live, service type is (exist) |
| SenSource | `people:count` | count crossed above/below (exist as `occupancy.*`) | count is above/below |
| Smaart | `spl:history` | SPL crossed above/below, sustained above for N minutes | — |
| Wireless | `wireless:connections-changed`, `slots:devices` | a pack's battery fell below N, RF dropped below N bars, a receiver went offline | — |
| ProdCom | `prodcom:transcript` | a phrase was said (keyword match) | — |
| RossTalk / OSC | `integrations:state-changed` | connection lost/restored | is connected |
| Ross TSL | `integrations:state-changed` | connection lost/restored | is connected |
| Companion | — | none: it calls the app, it is not a source | — |

### The app's own features

| Source | Channel | Triggers | Conditions |
|---|---|---|---|
| Baptism | `baptism:state` | timer started, phase changed, timer finished | phase is |
| Displays | `displays:presence` | a display connected/disconnected, no displays connected | a named display is connected |
| Service timeline | `service-timeline:history` | running over/under plan by N minutes | is over plan |
| Attendance | `attendance:history` | — (covered by `people:count`) | — |
| Updates | `update:status` | an update became available, an update finished | — |

Two notes on the table:

`occupancy.crossed-above` / `crossed-below` already exist and are named for
occupancy. They stay as they are — renaming them would break saved rules for no
gain.

Wireless battery and RF triggers need the per-pack payload on
`slots:devices`. That payload already carries battery and RF per bound channel,
so the trigger parameterises on the slot's mic label rather than a device id,
which is what an operator actually knows.

## Error handling

Unchanged from today, and load-bearing:

- `didFire` MUST return false when `prev` is null. The engine seeds the first
  snapshot per channel and never evaluates it, so a restart mid-service cannot
  fire every new rule at once. The existing test asserts this for every
  registered trigger and will cover the new ones automatically.
- A trigger that throws is caught by the engine and treated as "did not fire".
  A malformed payload must never take the engine down.
- Every new trigger must tolerate a payload missing its fields; the existing
  "malformed payloads" test iterates the whole registry.

## Testing

- Every new trigger gets edge cases in `automation-triggers.test.ts`: fires on
  the transition, does not fire while the condition merely persists, does not
  fire on a null `prev`.
- The completeness test above.
- No integration is contacted by any test — the registry is pure.

## Decomposition — the remaining phases

1. **This spec.** Triggers and conditions everywhere. No new transports.
2. **Actions on transports that already exist.** OBS is cheap: `adapter.request()`
   is already there and only used for `Get*` calls, so start/stop record and
   scene switching are small. REAPER is moderate: the same `fetch` path, plus
   command ids.
3. **In-app verbs.** Baptism start/stop, switching an output's view, and similar
   things the app can do to itself.
4. **Retire the baptism panel** onto (1) and (3).

**Not in scope, and deliberately so:** ProPresenter control. It is read-only
today with no outbound path, so "trigger a slide" means building an API client.
That is integration work, not automation work, and belongs in its own spec.

## The wrinkle phase 4 must solve

The baptism panel supports picking **specific items on the current plan**
(`baptism-triggers-store` is keyed by `planId`). Automation rules are global and
match items by title.

A straight migration would lose the per-plan pick. Options, to be decided when
phase 4 is specced: teach rules an optional plan scope; or accept title matching
only and treat the per-plan pick as a feature that goes away; or keep per-plan
overrides in the baptism store and let a rule defer to them.

Recording it here so phase 4 does not start by rediscovering it.
