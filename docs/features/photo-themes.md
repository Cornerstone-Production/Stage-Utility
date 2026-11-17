# Photo themes

Themed mic slot photos for a service: one prompt ("Christmas lights, keep the face
exactly the same") turns each person's Planning Center photo into a themed one,
a person approves each, and that service's screens show the approved photos.
The edits are made by OpenAI's image model, paid for with an OpenAI API key.

Planning Center is never changed: the original photo is read, never written back.
Nothing reaches a screen until someone has looked at it and approved it, because
an edit can change a face.

## Connecting OpenAI

Theme photos needs an **OpenAI API key**, saved on the server (`PUT /api/openai/key`).
The key is a credential like a Planning Center secret: it is kept encrypted in
`secrets.bin`, sent only to OpenAI in the request's `Authorization` header, never
logged, never sent to a browser (the app shows `sk-…3f2a`, its last four
characters), and never in a config backup. **Test** (`POST /api/openai/test`) lists
OpenAI's models with the key, which costs nothing, and says whether it works.

Edits are billed to the key's OpenAI organization at OpenAI's API rates. A ChatGPT
Business, Pro or similar plan includes monthly API credits that pay for them when:

- the subscription is at least 7 days old,
- the same email owns the subscription and the API organization, and
- the key is a project key in that organization (credits are tied to the
  organization, not to a key).

Plus, Go and Free plans include no API credits, and Enterprise is not eligible.
Credits expire monthly; once they are used up, normal API billing applies, or edits
fail with **Out of API credits** until the plan renews or credits are bought.
OpenAI may require the organization to be verified before it allows image models;
until then an edit fails with *OpenAI refused access to image edits*.

Signing in with a ChatGPT account instead of a key is not offered: OpenAI does not
let a plan sign-in pay for image edits.

### The connection's state

`GET /api/openai` answers `{method, hint, state, reason, checkedAt}`:

| `state` | |
|---|---|
| `not-connected` | no key saved |
| `unchecked` | a key is saved and has not been used or tested since |
| `connected` | the last test or edit with it worked |
| `invalid-key` | OpenAI rejected it. Generating is refused until a new key is saved |
| `out-of-credits` | it works, but the last edit was refused for credits. Listing models cannot see credits, so a test leaves this standing until an edit works |
| `forbidden` | OpenAI refused it access to image edits |
| `unreachable` | the last call could not reach OpenAI, or did not answer in time |

## Themes

A theme is a name, a prompt, and at most one photo per person. Make it once and use
it on as many services as you like: a person with an approved photo in the theme
gets it on every service that uses the theme, at no further cost.

Editing a theme's prompt changes it for every service using the theme. Photos
already made stay until they are redone; the theme reports `promptChanged` until
everyone is redone (Generate with `mode: "all"`) or the photos are kept as they are
(`keep-prompt`).

## A service's photos

A plan uses at most one theme (`PATCH /api/photo-themes/plans/:planId`). The
people it is made for are the people the plan's boards put in a slot: every board
a screen or a slots widget shows, at that plan, against that plan's roster.

**Generate** (`POST …/plans/:planId/generate`) sends to OpenAI only the people with
no photo in the theme, or whose last attempt failed; anyone who already has one is
reused at no cost, and someone with no Planning Center photo (or one served from
anywhere but Planning Center) is skipped. Edits go
two at a time. Each comes back **ready to review**, and is shown on screens only
once **approved** (one at a time, or every ready one made for the plan).

**Redo** makes one person's photo again. Their approved photo stays on screens
until the new one is approved, and the new one replaces it: a person never has two
photos in one theme.

**Made from an older photo.** Each edit records which Planning Center photo it was
made from. When the person's Planning Center photo has changed since, their
approved photo says so (`stale`). Redo makes a new one; **Keep** accepts the old
one, until their photo changes again.

**Move** and **Copy** put a person's approved photo into another theme, replacing
any photo they have there; Move takes it out of this one. **Remove** takes a person
out of a theme, and every service using it shows their original again. Deleting a
theme does that for everyone in it.

### When an edit fails

A failed edit keeps its reason on the person, and the next Generate tries them again.

| Reason | |
|---|---|
| OpenAI rejected the API key | the key is wrong or revoked. The rest of the run fails without being sent |
| Out of API credits | the organization's credits are used up. The rest of the run fails without being sent |
| Rate limited by OpenAI | the queue waits as long as OpenAI asks (at most a minute) and tries twice more before failing |
| Refused under OpenAI's content policy | OpenAI's moderation refused the photo or the prompt |
| OpenAI refused access to image edits | the organization may need verifying for image models |
| Could not reach OpenAI · OpenAI did not answer in time | the network, or OpenAI, did not answer |
| Could not read their Planning Center photo | the original could not be fetched through the [photo cache](../integrations/planning-center.md#photos) |

## What screens show

A plan using a theme has an **Original | Themed** switch (`show`). Choosing a theme
sets it to Themed, and so does an approval on a plan set to Original that has no
themed photo showing yet.

While a plan is set to Themed, a person's **approved** photo in its theme replaces
their Planning Center photo wherever a slot draws them for that plan: the slots
screens, slots widgets and the slot editor's preview of that plan. A photo waiting
for review, a person with no photo in the theme, another plan and a service type's
default board all show the original. A slot's `photoUrl` names a themed photo as
`photo-theme:<file>`, which `/photos` serves from the server's own store. An
approved photo whose file is missing from `photo-theme-images/` (a book restored
without its images) is not drawn: that person shows their original until redone.

## What is kept, and for how long

| | |
|---|---|
| `photo-themes.json` | themes, prompts, approvals and each plan's theme and switch: the operator's work, restored from a [backup](../ops/reliability.md#backups) |
| `photo-theme-images/` | the edits, named by content hash, carried by a backup |
| `secrets.bin` | the API key, never in a backup |

A theme's photos are kept until three calendar months after the last service date
that used it (or the day the theme was made, if later), as dates in the app's
[time zone](../ops/install-and-config.md#time-zone). Using the theme on a later service
pushes the date out; nothing moves it back. The theme lists it as `keptUntil`.
A daily sweep removes the photos of a theme past its date, and forgets the theme
choice of plans more than three months past, with a `[photo-theme]` line for each.
The theme itself and its prompt stay. A theme used by a plan with no known
service date is not swept.

**What OpenAI keeps.** Each original photo and prompt is sent to OpenAI to be
edited. By default OpenAI keeps abuse-monitoring logs of API use for up to 30 days;
zero data retention is available only with OpenAI's prior approval, set up under the
organization's data controls. Images flagged in OpenAI's safety scanning are
retained for review even under zero data retention.

## Logging

On [`/log`](../ops/updates-and-logs.md) under `[photo-theme]`: each generate run's
summary (made, failed, reused at no cost, skipped), each failed edit with its
reason, a rate limit and the wait, the connection starting to fail, a key saved or
removed, theme creation and deletion, the retention sweep's removals,
and an edit that finished after its person was removed and was not kept.
