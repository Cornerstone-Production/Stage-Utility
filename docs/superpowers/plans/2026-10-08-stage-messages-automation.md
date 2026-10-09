# Stage messages — automation and Companion (PR 3)

Spec: [2026-10-07-stage-messages-design.md](../specs/2026-10-07-stage-messages-design.md),
"Automation and Companion". Builds only on what PR 1 shipped (`messagesService`,
`POST /api/messages`, `POST /api/messages/:id/clear-alert`, `messages:state`);
it does not wait for PR 2. Two pull requests, one per repo, using the names below
exactly so the app's docs and the module agree.

## In the app (`feat/stage-messages-automation`)

### Two automation actions

Both in `AUTOMATION_ACTIONS` (`main/services/automation-actions.ts`), so rules
fire them and an **Action button** on any console runs them.

**`messages.send` — "Send a stage message"**

| Param | Type | |
|---|---|---|
| `to` | `multi-enum`, `optionsFrom: "message-groups"` | Everyone plus each group, by id |
| `text` | `string` | 1–280 characters |
| `alert` | `enum` `no` / `yes`, default `no` | Takes the screens over for 30 seconds |

- A new `optionsFrom` value, `"message-groups"`, resolved wherever the existing
  values are (`displays`, `service-types`, …): Everyone first, then the groups in
  the config's order, labelled by name.
- `run` never throws: a refusal (`MessageRefused` from
  `main/services/message-rules.ts`, e.g. a group deleted since the rule was saved)
  is a returned failure naming the reason. `simulate` answers "would send …"
  without sending.
- `from` is `"Automation"`. The rule's name is not in the action's context; do
  not widen `ActionDef` for it.
- A rule saved with `to` empty or `text` blank shows **Needs setup**, the way
  other required params do.

**`messages.clear-alerts` — "Clear stage message alerts"**

- No params. Ends every running alert (`messagesService.clearAlert` for each entry
  of `state().alerts`), `from` `"Automation"`. Nothing running is a success that
  says so.

### Docs

- `docs/automation.md`: both actions in the actions list, in its voice.
- `docs/integrations/companion.md`: under "What the module exposes", the module's
  messages actions, feedback, variables and presets exactly as listed below;
  under "Network cost", `messages:state` in the channel list and
  `GET /api/messages` in what the module reads on connect.
- `docs/features/stage-messages.md`: a short "From automation and Companion"
  section linking both.

### Logging

The engine already logs each action's result; the messages service already logs
each send and clear. Nothing new beyond what those produce. Say so in the PR.

### Tests

Each proven red: the options resolver lists Everyone then the groups; `send` with
a deleted group returns a failure, not a throw; `simulate` sends nothing; `send`
reaches `messagesService.send` with `from: "Automation"`; `clear-alerts` ends
every running alert and reports none running.

## In the Companion module (`companion-module-cornerstone-stageutility`, branch `feat/stage-messages`, base `beta`)

Reads `messages:state` (add it to the channels the module posts to
`/api/events/subscribe`) and hydrates `GET /api/messages` on connect alongside the
existing endpoints. Talks only to routes PR 1 shipped.

**Actions**

| Id | Label | Options | Does |
|---|---|---|---|
| `message_send` | Send message | Groups (multi-dropdown: Everyone + each group), Text (text input, variables parsed), Alert (checkbox) | `POST /api/messages` `{ to, text, alert, from: "Companion" }` |
| `message_send_quick` | Send quick message | Quick message (dropdown of the quick messages), Groups, Alert | the same |
| `message_clear_alerts` | Clear alerts | none | `POST /api/messages/:id/clear-alert` `{ from: "Companion" }` for each running alert |

Dropdowns follow the state live for groups: a renamed group updates the choices
without reconnecting.

**Resolved by PR 2:** the quick messages are not in `messages:state` in PR 1,
and a change to the quick lists sends no frame there. PR 2 adds `quickMessages`
and `quickReplies` to the state and publishes when either changes. Until it lands,
the module reads `GET /api/messaging` on connect, so an edited quick list reaches
a button on the next reconnect; afterwards it follows the frame.

**Feedback**

| Id | Label | |
|---|---|---|
| `message_alert_running` | Alert running | Boolean; optional Group filter (any group, or one) |

**Variables**

| Id | Value |
|---|---|
| `message_last_text` | The newest message's text |
| `message_last_from` | Who sent it |
| `message_last_to` | Its groups, by name, comma separated ("Everyone" for Everyone) |
| `message_reply_text` | The newest reply to any message today |
| `message_reply_from` | Who sent that reply |
| `message_alert_active` | `true` while any alert runs, else `false` |
| `message_alert_text` | The newest running alert's text, else empty |

Empty strings when there is nothing yet, and after the nightly clear.

**Presets**, category **Messages**: one **Send** button per quick message (to
Everyone, editable after placing), and a **Clear alerts** button wearing the
`message_alert_running` feedback.

**Docs**: `companion/HELP.md` and `README.md`, in their existing voice.

**Release**: no version bump by hand; the module's tag-based release flow does it.
