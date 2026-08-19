# The screen URL editor becomes a dialog

**Goal.** Editing a screen's URLs happens in a dialog in the middle of the
screen, opened from that screen's three-dot menu, instead of an accordion that
pushes the card open.

**Mockup:** https://claude.ai/code/artifact/8d84782a-dd78-46e9-b788-589580c7f7d5

**Why.** The URLs panel currently expands inside the card, so the card changes
height, the grid reflows, and a thing you edit occasionally is built into a thing
you glance at constantly.

## What changes

`URLs & friendly link` in the three-dot menu opens a dialog instead of toggling
`showSlug`. The dialog holds exactly what the panel held — the permanent URL with
its copy button, and the optional friendly slug — for one screen, named in the
title.

The card loses the expanding section and its height stops changing.

## The one behaviour that must change with it

**The slug saves on an explicit Save, not on blur.**

Today `handleSlugBlur` saves when the field loses focus, and on rejection it
reverts the field and shows the error under it. That is fine in an accordion and
wrong in a dialog: closing the dialog blurs the field, so the save races the
unmount and a rejected slug looks accepted because the dialog is already gone.

The server is the authority on what a slug may be — a reserved word like
`history` does not error, it silently serves that page instead of the display —
so a rejection has to be visible. The dialog therefore:

- saves on **Save**, and on Enter in the field;
- stays open and shows the reason if the server refuses;
- closes only on a successful save, on Cancel, or on Escape;
- treats Cancel and Escape as discard, leaving the stored slug untouched.

The permanent URL is read-only and copyable, as now.

## Not in scope

The friendly-port URL line and the copy-to-clipboard behaviour are unchanged;
they move verbatim. Nothing about slug validation changes on the server.

## Testing

- The dialog opens from the menu, titled with that screen's name, and the card's
  height does not change when it does.
- A slug the server refuses leaves the dialog open with the reason shown, and the
  stored slug unchanged. This is the case the move creates, so it is proven
  rather than assumed: on blur-save the same rejection would have been invisible.
- Escape and Cancel discard an edit without saving it.
- Enter in the field saves, so the dialog does not require a mouse.
- Driven in a browser against a copy of the real config, not only unit-tested:
  a control that renders is not a control that does anything.
