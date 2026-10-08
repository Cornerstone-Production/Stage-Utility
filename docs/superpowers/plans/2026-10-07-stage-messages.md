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

**As built, where it differs from the text below.** The state carries
`alerts: StageMessage[]` (every running alert, newest first), not `alert`; the
expiry timer aims at whichever ends first. The messaging config carries a
`version` and PUT answers 409 on a stale one. Deleted groups are stripped by
`stripUnknownOutputGroups`, derived from the outputs, on every PUT and at start;
a strip that fails after the config saved answers 500 `groups-not-cleared`.
Validation lives in `main/services/message-rules.ts`.

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

## PR 2 — On screens (`feat/stage-messages-screens`)

What lands: the **Message composer** and **Messages** widgets, the **alert**
drawn over any screen in the target groups, **replies** from consoles, and the
plumbing that tells a layout which screen it is on. After this PR, stage
messages works end to end from a console.

The mockup is the UI spec for all three surfaces: the composer panel on its left,
the Messages widget and the alert banner on its right. Build them as drawn.

### State: the quick lists ride the channel

The composer needs the quick messages and the Messages widget the quick
replies, live. Add `quickMessages` and `quickReplies` to `MessagesState`, and
publish when either changes (extend `replace()`'s `groupsChanged` to a
`stateChanged` that covers groups and both lists). `rev`, hydration and the
hello burst are unchanged. Register `GET /api/messages` in `SHARED_READ_PATHS`
now that widgets read it.

### Which screen a layout is drawing

- `LayoutRenderCtx` gains `outputId: string | null` and
  `screenGroups: readonly string[] | null`. `null` means "not a screen": an
  in-app console, Home, the editor, a preview. Required on `LayoutRenderer`'s
  props, so no surface can forget them — the `allowHls` pattern.
- `StageView` passes the resolved output's id and `groups` for a real screen
  (displays and panel consoles), and `null`/`null` for a preview (`standingIn`
  is a picture of another screen, not that screen). Every other builder passes
  `null`/`null`: `console-route.tsx`, `home-grid.tsx`, `layout-editor.tsx`,
  `embedded-view.tsx` inherits its parent's.
- `ResolvedOutput.groups` already exists from PR 1.

### The Messages widget (`messages`)

- Config: `{ type: "messages"; groups?: string[] | null }`. `null`/absent
  follows the screen's groups; a list overrides them. On an in-app console
  (`screenGroups === null`) with no list, the widget draws "Choose groups for
  this widget" in the editor and nothing on the console.
- Shows the newest three messages sent to its groups or to Everyone: sender and
  age on a small line, the newest larger, older ones muted, and under each the
  latest reply in green — as the mockup's green room TV draws it. Age is counted
  against the server clock (`useServerNow`).
- On a surface where controls are live (panel, shell), the newest message it
  shows gets the quick replies as buttons, under "Answering: <text>". Where there
  is nothing to answer, it says which groups it can answer for, as the mockup's
  booth console does. A wall display shows no buttons.
- Capabilities: `["readout", "control"]`. Check the "nothing else is a control"
  test and what `control` changes about which views count as consoles; a view
  holding only a Messages widget becoming a console is correct.
- Inspector: a Groups picker (Follow this screen / chosen groups).

### The Message composer widget (`message-composer`)

- Capability `["control"]`. No options (`stylingOnly: true`) unless the mockup
  needs one.
- As drawn: **To** chips (Everyone plus each group; Everyone and groups are
  exclusive, several groups may be picked), **Quick messages** in two columns
  filling the text box, the text box, **Alert: takes over the screen** toggle,
  **Send** (red "Send alert" while Alert is on), the hint line naming how many
  screens it reaches, and **Today**: the thread, newest first, each reply under
  its message, with **Clear alert** on any message whose alert is still running.
- `from`: the output's name on a screen, the console view's name on an in-app
  console, "Home" on Home.
- A failed send keeps the text and the selection, toasts why, and logs through
  `logToServer("messages", …)`.

### Replies — `POST /api/messages/:id/replies`

- Body `{ text, objectId, outputId? }`. `text` 1–60 (`QUICK_REPLY_MAX`); any
  text, though the widget offers only the quick replies.
- The server finds the Messages widget by `objectId` across every view's layout
  (recursing into containers; ids are unique), refusing 404 when there is none
  or it is not a `messages` widget. Its groups are its own list when set, else
  the output's groups when `outputId` names an output, else none.
- 403 unless the message went to Everyone or to one of those groups. The
  message's own `to` decides, never the client.
- `from` is server-derived: the output's name, else the name of the view that
  holds the widget.
- Appends `{ id, at, from, text }` to the message's `replies`, persists,
  publishes, logs `[messages] reply to <id> from <from>: "<text>"`, and logs a
  refusal with its reason. A reply to a message cleared at midnight is a 404.

### The alert

- `MessageAlertOverlay`, rendered by `StageView` as a sibling of the body, after
  blackout's early return (a blacked-out screen stays black), never on a preview.
  It subscribes to `messages:state` on every kiosk screen, whatever the layout or
  view kind.
- It draws the newest entry of `alerts` sent to Everyone or to one of the
  screen's groups, as the mockup's banner: full width along the bottom, "Alert"
  label, the text large, a bar running down to `alertUntil` on the server clock.
  When it ends, the next one sent to this screen (if any) shows.
- A screen in no group still gets alerts sent to Everyone.

### Every per-type table

The code map for adding a widget type: `LAYOUT_OBJECT_TYPES` (sorted),
`CAPABILITIES`, `LAYOUT_OBJECTS` (label, blurb rules, group, config, style),
`ICONS` in `palette.tsx`, the `ObjectBody` switch, `useLayoutData` gating with
`want([...])`, `statusCtx`, and the test tables: object-capabilities,
object-catalog, object-fit, object-look (`BARE` or the carded count),
layout-objects `ADDED_SINCE`, gate-render-parity, layout-data-reads `SOURCES`,
status-ctx `FLAG_FOR` if a `…Known` flag is added, wall-status-unknown for the
"No messages" claim, editor-canvas-contrast. Avoid config keys already in
`card-toggles.ts`.

### Logging

Server: a reply, a refused reply. Browser: a failed send, reply or clear through
`logToServer("messages", …)`.

### Tests

Each guard proven red in the session, said in the commit.

- Reply route: authorised by the widget's own groups, by the output's groups,
  Everyone, refused for a widget not in the group, unknown widget, a widget of
  another type, `from` taken from the server not the body.
- Render ctx: a real screen passes its id and groups; a preview passes null.
- Messages widget: shows only its groups' messages; its own groups override the
  screen's; reply buttons only where controls are live; nothing to answer says
  which groups; the age uses the server clock.
- Composer: sends the selected groups, Everyone exclusive, Alert flips Send,
  quick message fills the box, a failed send keeps the text, Clear alert on a
  running alert only.
- Overlay: draws only alerts sent to the screen's groups or Everyone; not on a
  preview; not over blackout; ends at `alertUntil` by the server clock; the next
  running one follows.
- Driven end to end on a real server (see Verification).

### Docs

`docs/reference/widgets.md` (both widgets, a "Messages" section);
`docs/features/stage-messages.md` (the widgets, alerts on screens, replies, who
may answer); `docs/reference/api.md` (the replies route); `docs/display-urls.md`
(alerts draw over any view on a screen in the group); `docs/features/operator-app.md`
(composer and replies on consoles); `docs/ops/network-traffic.md` if the frame
grows.

### Verification before the PR

Gate, then the real server on 8799 with an empty data dir, in a browser:

1. Groups Green room and Stage; display-1 in Green room showing a layout with a
   Messages widget; display-2 in Stage set to panel mode with a Messages widget;
   a console view with the composer open in the app.
2. Send to Green room from the composer: display-1 shows it; display-2 does not.
3. Send an alert to Stage: display-2's banner shows and runs down; display-1
   shows nothing; after 30 s it is gone without a reload.
4. Reply from display-2 (panel) to the Stage message: the composer's thread
   shows it under the message, labelled display-2's name. A reply to the Green
   room message from display-2 is refused (try it with curl).
5. Blackout display-2 and send an alert to Everyone: display-2 stays black.

## PR 3 — Automation and Companion (outline)

A `Send message` action in `AUTOMATION_ACTIONS` (groups, text, alert), so rules
and Action buttons can send; Companion docs (what the module exposes, network
cost); a PR in `companion-module-cornerstone-stageutility` for the action and the
variables read from `messages:state`.
