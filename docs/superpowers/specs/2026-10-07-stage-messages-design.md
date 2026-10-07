# Stage messages

**Goal.** A producer sends a short message from a console to one or more groups
of screens. Every screen in those groups shows it; an alert takes over those
screens for 30 seconds; a console in those groups can answer. It replaces
walking to the green room, and it replaces the Notes-in-an-embedded-view
workaround for one-way cues.

**Mockup.** https://claude.ai/artifact/FZfjTDXnioxu3q6QvZ2Yz3 (v2) — driveable:
send to a group, turn on Alert, answer from either console. The mockup is the UI
spec; where this text and the mockup disagree, the mockup wins.

**Decided with Henry, 7 Oct 2026.** Screens belong to groups, and a screen can
be in any number of them. Alerts clear themselves after 30 seconds. Only a
console in a group the message went to can answer it. Messages clear every
night. Planning Center Live chat is out of scope: the public Services API has
no way to read or send chat messages (`Live` exposes only `can_chat` and a
`chat_room_channel` name on Planning Center's private realtime service, and
`/services/v2/chat` returns a sign-in payload for their own client).

## Pieces

| Piece | What it is | Where |
|---|---|---|
| Groups | Named sets of screens: Green room, Stage, Booth. **Everyone** is built in | Settings → Messages; membership on each screen's card on the Screens page |
| Message composer | Pick groups, a quick message or typed text, Alert on or off, Send. The day's thread with replies underneath, and **Clear alert** on a live one | A widget, so it goes on Home, a console or a panel like any other |
| Messages | The newest three messages for the screen's groups, with sender and age, and the latest reply under each. On a console, reply buttons for the newest one | A widget |
| Alert | The message, full width along the bottom of the screen, over whatever the screen shows, with a bar that runs down for 30 seconds | Drawn by every screen in the groups; no widget needed |
| Quick messages, quick replies | Two editable lists | Settings → Messages |

## Who is in which group

- A **screen** (an output) carries `groups: string[]`, edited on its card on the
  Screens page. Absent means no groups; **Everyone** still reaches it.
- A **Messages** widget follows its screen's groups. It has a **Groups**
  setting for when there is no screen to follow: a console in the operator app
  (`/consoles/…`) is not an output. There the widget's own groups apply, and
  with none chosen it says "Choose groups for this widget" in the editor and
  nothing on the console itself. Set on a screen, the widget's own groups
  override the screen's — the escape hatch for one layout shown on screens in
  different rooms.
- **Who may answer** is the same answer: the Messages widget on a panel or an
  in-app console may reply to a message sent to a group that widget follows,
  or to Everyone. A wall display never replies. The server checks it from the
  widget's stored layout and the output's groups, not from what the browser
  claims.

## What a message is

```ts
interface StageMessage {
  id: string;              // server-assigned
  at: number;              // server ms
  to: string[];            // group ids, or ["everyone"]
  text: string;            // 1–280 chars
  alert: boolean;
  alertUntil: number | null; // at + 30_000 when alert, else null
  from: string;            // the sending console's name, "Companion", or "Automation: <rule>"
  replies: { id: string; at: number; from: string; text: string }[];
}
```

The sender is a name, not an account: the app has none. A composer on an output
signs with the output's name; on an in-app console, with the console's view
name; Companion and automation rules sign as themselves.

## Lifetime

- Kept in a **runtime** store (`messages.json`), so a restart mid-service keeps
  the day's thread. Capped at 200 messages; past that the oldest goes, logged
  once per day.
- **Cleared nightly** when the date in the app time zone changes, checked each
  minute against a persisted `lastClearedDate` so a server that was off at
  midnight clears on boot. Never the host clock.
- **Clear alert** ends an alert early; the message stays in the thread.

Groups, quick messages and quick replies are the operator's work: a **config**
store (`messaging.json`), so they travel in config snapshots. Deleting a group
removes it from every screen that had it, after a confirm that names how many.
Messages already sent to it keep its id and show "(deleted group)".

## How it reaches screens

- One **hydrated state channel**, `messages:state`:
  `{ rev, groups, messages, alert }` where `alert` is the live alert or null.
  Written in the hello burst and listed in `HYDRATED_CHANNELS`, so a screen that
  reconnects, and an Ultritouch panel on the poll transport that fell past its
  60-second buffer, both recover the current state. Not inside `StageState`:
  that is ~35 KB fanned out whole on every change.
- The **alert overlay** subscribes on every kiosk screen regardless of layout,
  and is skipped on previews. A blacked-out screen stays black: blackout is a
  deliberate choice for that screen, and an alert does not override it.
- The 30-second countdown runs against the **server clock** (`useServerNow`),
  from the server-stamped `alertUntil`. Pis with wrong clocks still clear on
  time.
- The two widgets subscribe only where they are placed (`want([...])` in
  `useLayoutData`), like every other widget.
- The layout renderer learns which screen it is drawing: a new required
  `outputId` and `screenGroups` on the render context, threaded through
  `LayoutRenderer` and every place that builds a context. Required, so no
  surface can forget it — the `allowHls` pattern.

## API

| | | |
|---|---|---|
| POST | `/api/messages` | Send: `{ to, text, alert?, from? }` |
| POST | `/api/messages/:id/replies` | Answer: `{ text, outputId?, viewId, objectId }`; 403 when that widget does not follow a group the message went to |
| POST | `/api/messages/:id/clear-alert` | End an alert early |
| GET | `/api/messages` | The `messages:state` snapshot |
| GET/PUT | `/api/messaging` | Groups, quick messages, quick replies |
| PATCH | `/api/outputs/:id` | Gains `{ groups: string[] }` |

Ids that come off the wire (group, message) are validated the way
`notes-store.ts` validates object ids, and every store keyed by them is a `Map`.

## Automation and Companion

- A **Send message** action in the automation registry: groups, text, alert. A
  rule can send "Walk now" to Green room when a plan item goes live, and an
  Action button can send a fixed message from any console.
- **Companion** gets it through the same action, plus variables from
  `messages:state`: the newest message, the newest reply and who sent it, and
  whether an alert is live. The module change is its own PR in
  `companion-module-cornerstone-stageutility`.

## Logging

`[messages]` lines, for the decisions and the failures:

- a message sent: groups, alert or not, sender, the text scrubbed and cut to 120
  characters;
- a reply, and a reply refused because the widget is not in the group;
- the nightly clear, with how many it removed;
- the 200 cap dropping messages, once per day.

The browser logs a failed send or reply through `logToServer("messages", …)`,
and the composer keeps the typed text and says why, so a failed send never
reads as sent.

## Build order

Three PRs, each finished and tested before the next; the feature ships to beta
when all three are in.

1. **Groups and messages.** The `messaging.json` config store, Settings →
   Messages (groups, quick messages, quick replies), groups on each Screens
   card, `Output.groups` through the PATCH route, the `messages.json` runtime
   store with the nightly clear and the cap, the routes, `messages:state` in the
   hello burst, `[messages]` logging. Docs: api, data model, logs, network
   traffic.
2. **On screens.** `outputId` and `screenGroups` on the render context; the
   Message composer and Messages widgets; the alert overlay with its
   server-clock countdown; reply buttons on consoles, checked server-side.
   Docs: widgets, display URLs, operator app.
3. **Automation and Companion.** The Send message action; Companion docs; the
   module PR for its action and variables.

## Not in this

- Planning Center Live chat, for the API reason above.
- Messages to a single screen. Make a one-screen group.
- Images, links or formatting in a message.
- Read receipts beyond a reply. A console that has seen a message says so by
  answering it.
