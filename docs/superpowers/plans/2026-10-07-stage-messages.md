# Stage messages — implementation plan

Spec: [2026-10-07-stage-messages-design.md](../specs/2026-10-07-stage-messages-design.md).
Mockup: https://claude.ai/artifact/FZfjTDXnioxu3q6QvZ2Yz3 (v2). The mockup is the UI
spec; where this plan and the mockup disagree, the mockup wins.

Three PRs against `beta`. This plan details PR 1; PR 2 and PR 3 are outlined at the
end and get their own detailed plan once PR 1 is merged, because PR 2 builds on the
shapes PR 1 settles.

Line numbers below are against `origin/beta` at `faa5241` and will drift; find the
named symbol, not the line.

---

## PR 1 — Groups and messages (`feat/stage-messages-groups`)

What lands: groups and quick lists as operator config with a Settings page; each
screen's group membership on the Screens page; a messages service that sends,
ends alerts, keeps the day's thread, clears nightly and caps at 200; the
`messages:state` hydrated channel; `[messages]` logging; docs.

Not in PR 1: any widget, the alert overlay, replies (the reply route needs the
widget to authorise against, so it lands in PR 2), the render-context plumbing,
automation and Companion.

### Types — `main/types/messages.ts` (new)

```ts
export const EVERYONE = "everyone";
export interface MessageGroup { id: string; name: string }
export interface MessagingConfig {
  groups: MessageGroup[];
  quickMessages: string[];
  quickReplies: string[];
}
export interface MessageReply { id: string; at: number; from: string; text: string }
export interface StageMessage {
  id: string;
  at: number;                 // server ms
  to: string[];               // group ids, or [EVERYONE]
  text: string;
  alert: boolean;
  alertUntil: number | null;  // at + ALERT_MS when alert
  clearedAt: number | null;   // set by Clear alert; the alert is over, the message stays
  from: string;
  replies: MessageReply[];
}
export interface MessagesState {
  rev: number;
  groups: MessageGroup[];
  messages: StageMessage[];   // oldest first, today only
  alert: StageMessage | null; // the newest message whose alert is still running
}
export const ALERT_MS = 30_000;
export const MESSAGE_MAX = 280;
export const MESSAGES_CAP = 200;
```

Limits: group name 1–40 chars, at most 20 groups, names unique case-insensitively;
quick messages at most 24, each 1–280; quick replies at most 12, each 1–60; `from`
1–60. Group ids are server-generated `g-` + 8 hex chars and validated on the way
in with `/^g-[0-9a-f]{8}$/` (plus `everyone` where a target is allowed). Message
and reply ids are 16 hex chars. Anything keyed by an id from the wire is a `Map`,
never an object (CodeQL remote-property-injection).

Defaults for a fresh install: no groups; quick messages `Walk now`, `You're on
after this song`, `2 minutes`, `Wrap it up`, `Band back on stage`, `Running 5 min
late`; quick replies `Copy`, `Walking now`, `Need 2 min`.

### Stores

- `main/services/messaging-store.ts`: `new DataStore<MessagingConfig>("messaging.json", DEFAULTS, "config")`.
  `init()`, `get()`, `replace(next)` (validates, returns the removed group ids).
- `main/services/messages-store.ts`:
  `new DataStore<{ lastClearedDate: string | null; messages: StageMessage[] }>("messages.json", …, "runtime")`.
- Both listed in `main/services/stores.ts`; `messaging.json` added to
  `EXPECTED_CONFIG` and `messages.json` to `EXPECTED_RUNTIME` in
  `config-snapshot.test.ts`, each in sorted position, one per line.

### Screens: `Output.groups`

Follow `allowHls` through every layer (`setOutputAllowHls` is the template):

- `Output.groups?: string[]` in `main/types/views.ts`; `ResolvedOutput.groups: string[]`
  (absent → `[]`) copied in `recomputeResolved`.
- `stageController.setOutputGroups(id, groups)`: not-found throws like its
  siblings; every id must exist in the messaging config (throw naming the unknown
  id); deduped; order kept as the config's order. Goes through `commitOutputPatch`.
- `stageController.stripOutputGroups(ids)`: removes deleted groups from every
  output in ONE settings write; returns how many outputs changed.
- PATCH `/api/outputs/:id` accepts `{ groups: string[] }`: extend the
  "nothing valid" check and its 400 text, dispatch beside `allowHls`. Add the
  field to `FIELDS` in `routes/output-patch-unknown-id.test.ts`.
- Renderer: `IpcChannel` `"outputs:setGroups"` + its case in `renderer/lib/api.ts`;
  `handleSetOutputGroups` in `use-stage-settings.ts` (optimistic, like
  `handleSetOutputAllowHls`) and `renderer/settings/types.ts`.
- `outputs-section.tsx`: a **Groups** submenu in the screen's overflow menu, one
  `DropdownMenu.CheckboxItem` per group, and the screen's groups as small chips
  under its name on the card, as in the mockup. With no groups defined, the
  submenu holds one item linking to Settings → Messages.

### Messages service — `main/services/messages-service.ts` (new)

Holds the day's messages in memory, persisted to `messages.json` on every change
(awaited, not fire-and-forget), and owns the `messages:state` channel.

- `send({ to, text, alert, from })`: validates (`to` non-empty, every id an
  existing group or exactly `[EVERYONE]`; text trimmed 1–280; `from` default
  `"Operator"`), stamps `at` from the server clock, `alertUntil = at + ALERT_MS`
  when `alert`. Over 200, drops the oldest. Persists, bumps `rev`, broadcasts,
  logs. Returns the message.
- `clearAlert(id)`: sets `clearedAt` on a message whose alert is running; 404 for
  an unknown id, a no-op (200) for one already over. Broadcasts, logs.
- `state()`: the `MessagesState` snapshot. `alert` is the newest message with
  `alert && clearedAt === null && alertUntil > now`.
- **Alert expiry broadcast.** One timer, armed for the running alert's
  `alertUntil`, re-armed on every send and clear, that broadcasts the state when
  the alert runs out, so `alert` goes back to `null` on screens without a client
  timer. Build it on `main/services/ticker.ts` or keep it a single `setTimeout`
  that is cleared before being re-armed; `.unref()` it.
- **Nightly clear.** A once-a-minute check, plus once at start, comparing
  `zonedDateKey(Date.now())` (`app-timezone.ts`) to the stored `lastClearedDate`.
  When they differ: drop every message, store the new date, persist, broadcast,
  log `[messages] nightly clear removed N message(s)`. A store with
  `lastClearedDate: null` only records today's date. Never the host clock's date.
- **Cap.** Dropping past 200 logs `[messages] over 200 today; dropping the
  oldest` once per day, not once per message.
- `start()` / `stop()`: started from server boot beside the other services,
  stopped in tests.

### Messaging config — group deletion

`PUT /api/messaging` replaces the config. A group whose id disappears is removed
from every screen via `stageController.stripOutputGroups`, and logged
`[messages] group "<name>" deleted; removed from N screen(s)`. Messages already
sent to it are left alone. The `messages:state` channel re-broadcasts, since it
carries `groups`.

### Routes — `main/services/routes/messages-routes.ts` (new, in `ROUTE_MODULES`)

| | | |
|---|---|---|
| GET | `/api/messages` | `MessagesState` |
| POST | `/api/messages` | `{ to, text, alert?, from? }` → 201 + the message; 400 with the reason |
| POST | `/api/messages/:id/clear-alert` | 200 + state; 404 unknown id |
| GET | `/api/messaging` | `MessagingConfig` |
| PUT | `/api/messaging` | `MessagingConfig` → 200 + config; 400 with the reason |

Message and group ids in paths are validated before any lookup. Register
`GET /api/messages` in `SHARED_READ_PATHS` if it pairs with the hydrated channel
the way other state channels do.

### Channel

- `broadcast("messages:state", state)` on every change.
- In `writeHelloBurst()`: `sseWrite(res, "messages:state", messagesService.state())`
  as a quoted literal (the hydrated-channels test scans for it).
- Add `"messages:state"` to `HYDRATED_CHANNELS` in `renderer/lib/sse-channels.ts`.
- Not in `StageState`.

### Settings → Messages

A new settings destination `/settings/messages` in `renderer/app/destinations.tsx`
(`SETTINGS_DESTINATIONS`), component in `renderer/settings/sections/messages-section.tsx`:

- **Groups**: add, rename, delete; delete confirms with how many screens are in
  the group ("Remove Green room? 2 screens are in it.").
- **Quick messages** and **Quick replies**: add, edit, remove, reorder. Model the
  list editor on `history-milestones-panel.tsx`.
- Save through a new `IpcChannel` `"messaging:set"` (PUT) and read through
  `"messaging:get"`; both need a real caller or `api-channels.test.ts` fails.
  Failures toast and keep the edit on screen.
- Update `routes.test.tsx` and `active-page.test.tsx` for the new route.

### Logging

Server, every external value through `scrub()`:

- `[messages] sent to <group names> (alert) by <from>: "<text cut to 120>"`
- `[messages] alert <id> cleared by <from>`. An alert running out is not logged:
  it is routine.
- `[messages] refused: <reason>` for a 400 on send.
- nightly clear, the cap, group deletion as above.

`log-injection.test.ts`: list `messages-service.ts` and `messaging-store.ts` in
`REQUEST_FACING`; the new routes file is walked automatically.

### Tests

Each guard is shown red with its code removed, said in the commit.

- `messaging-store.test.ts`: defaults; validation (each limit, duplicate names,
  bad ids); `replace` returns removed ids.
- `messages-service.test.ts`: send validation; `alert` computed from the server
  clock; clear-alert; expiry broadcast fires once at `alertUntil` (mock timers);
  nightly clear across a date change in a non-UTC app zone, and a UTC host at
  19:00 Chicago does NOT clear; boot with a stale `lastClearedDate` clears;
  cap drops oldest and logs once; persistence round-trip.
- `output-groups.test.ts` and `routes/output-groups-route.test.ts`, modelled on
  the allowHls pair: default `[]`, unknown group id refused, dedupe, no bleed to
  other outputs, `stripOutputGroups` in one write.
- `routes/messages-routes.test.ts`: every route, every 400/404.
- Hello burst carries `messages:state` (hydrated-channels test covers the list).

### Docs (same PR)

- `docs/features/stage-messages.md` (new): what groups are, Settings → Messages,
  putting screens in groups, what a message and an alert do, the nightly clear.
  Widgets and replies are added in PR 2. Linked from the docs index.
- `docs/reference/api.md`: the routes; `groups` on the outputs PATCH row;
  `messages:state` under "Hydrated on connect".
- `docs/reference/data-model.md`: `Output.groups`; the two new stores.
- `docs/ops/updates-and-logs.md`: the `[messages]` tag.
- `docs/ops/network-traffic.md`: the channel, its size and when it changes.

### Verification before the PR

`npm run lint && npm run type-check && npm test && npm run build`, then drive the
real server on port 8799 with an empty data dir
(`STAGE_UTILITY_DATA=/tmp/su-messages STAGE_UTILITY_PORT=8799 STAGE_UTILITY_FRIENDLY_PORT=0 npm run server`),
confirming `/api/version` is this build first:

1. Create two groups in Settings → Messages in a browser; put a screen in both
   from the Screens page; the chips show.
2. `curl` a send to one group and an alert to Everyone; `/api/messages` shows
   both, `alert` set, then `null` after 30 s without any client request.
3. Open `/api/events` and see `messages:state` in the hello burst.
4. Delete a group in the UI; the screen loses it; `/log` shows the line.
5. Restart the server; the day's messages survive.

Kill the server by port when done.

---

## PR 2 — On screens (outline)

`outputId` and `screenGroups` on the render context (required, the `allowHls`
pattern, through `LayoutRenderer` and every context builder); the **Message
composer** widget (control; groups, quick messages, text, Alert, Send, the thread
with replies, Clear alert) and the **Messages** widget (readout plus reply
buttons on panel/shell, its own Groups setting); `POST /api/messages/:id/replies`
authorised from the widget's stored layout and the output's groups; the alert
overlay as a sibling of `StageView`'s body, after blackout's early return so a
blacked-out screen stays black, timed with `useServerNow`; every per-type
table the new widget types touch; docs (widgets, display URLs, operator app,
stage-messages).

## PR 3 — Automation and Companion (outline)

A `Send message` action in `AUTOMATION_ACTIONS` (groups, text, alert), so rules
and Action buttons can send; Companion docs (what the module exposes, network
cost); a PR in `companion-module-cornerstone-stageutility` for the action and the
variables read from `messages:state`.
