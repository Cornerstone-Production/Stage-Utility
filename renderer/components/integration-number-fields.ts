// integration-number-fields.ts — the two pure functions behind an integration's
// config form.
//
// `initialConfig` decides what the form STARTS with, and `numberFieldValue`
// decides what a number field SHOWS. Between them they are what an operator
// actually sees in the box, and a guard over either one alone missed the bug
// that produced them: a placeholder that is free-form prose became NaN, and NaN
// rendered as a bare 0 that a focus-and-blur then committed as a real setting.
//
// A MODULE, not two exports off a 1100-line component. Both were exported from
// integrations-panel.tsx purely so integration-number-fields.test.tsx could
// reach them — the test file's name has promised this module since it was
// written. Extracting it also lets wireless-connections-panel.tsx import
// `numberFieldValue` instead of carrying the older expression by hand.

import { FORM_MASK } from "@main/services/mask";

/**
 * What NumberInput is handed for one `type: "number"` field.
 *
 * `null` — "no value", which NumberInput renders as an empty box — only for a
 * field whose descriptor declares `unsetHint`, i.e. one where blank IS the
 * setting. For every other number field this answers what the render site's own
 * `typeof value === "number" ? value : Number(value) || 0` answered, so the ten
 * fields that must hold a real number are untouched. One input differs and
 * cannot occur: a NaN, which that expression returned as NaN and this returns as
 * 0. NumberInput drew both as "0", and since the `??`-versus-NaN fix in
 * initialConfig nothing seeds one — integration-number-fields.test.tsx asserts
 * that over every field.
 *
 * Two call sites: the integrations panel's config form, and the wireless
 * panel's, which carried the older expression by hand until this module existed.
 *
 * integration-number-fields.test.tsx runs it beside initialConfig over
 * INTEGRATION_DESCRIPTOR_FIXTURE — the renderer's copy of the shipped
 * descriptors, pinned field-for-field by
 * main/services/integration-descriptor-fixture.test.ts. The two together are
 * what an operator actually sees, and a guard over either one alone missed the
 * bug.
 */
export function numberFieldValue(field: ConfigField, value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  // `value !== ""` as well as the finite check, because Number("") is 0 — the
  // form's own spelling of "unset" would otherwise arrive as a real zero.
  const usable = value !== "" && value != null && Number.isFinite(n);
  if (!usable && field.unsetHint != null) return null;
  return usable ? n : 0;
}

/** The form's starting values for an integration — the saved config, with password
 *  fields masked and unset numbers prefilled from their default/placeholder.
 *  Out of the component so Discard can rebuild exactly the same thing.
 *  integration-number-fields.test.tsx runs it over INTEGRATION_DESCRIPTOR_FIXTURE
 *  (the renderer's copy, pinned to the shipped descriptors by
 *  main/services/integration-descriptor-fixture.test.ts) — a guard that
 *  reimplemented this loop would go green on a bug living in it. */
export function initialConfig(
  descriptor: IntegrationDescriptor,
  state: IntegrationState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of descriptor.configSchema) {
    const raw = state.config[field.key];
    // "oauth-device" (YouTube's connect row) carries the same kind of secret
    // behind its "Paste a token instead" disclosure and is masked the same
    // way — this was the one enumeration of field.type that still read
    // "password" alone after that type was added.
    if ((field.type === "password" || field.type === "oauth-device") && typeof raw === "string" && raw !== "") {
      out[field.key] = FORM_MASK;
    } else if (field.type === "number") {
      // Unset numeric fields (e.g. an API port) prefill the integration's
      // default — field.default if declared, else the numeric placeholder
      // (the shown default) — so the field displays and saves the real port
      // instead of a bare 0. A field with neither seeds "", the form's own
      // spelling of "no value", and NumberInput renders that blank when the
      // descriptor says blank is a real state (see `unsetHint`).
      //
      // Number.isFinite, not `?? undefined`: a placeholder is free-form prose
      // ("500 (lower = snappier, more requests)"), Number() of it is NaN, and
      // `NaN ?? ""` is NaN — `??` only catches null and undefined. That NaN
      // reached the field, where String(NaN) and `Number(value) || 0` both
      // render 0, so two fields whose stored value was genuinely absent showed
      // a bare 0 that a focus-and-blur then committed as a real number.
      const shownDefault = field.placeholder == null || field.placeholder === "" ? NaN : Number(field.placeholder);
      const fallback = field.default ?? (Number.isFinite(shownDefault) ? shownDefault : undefined);
      const rawNum = raw == null || raw === "" ? NaN : Number(raw);
      out[field.key] = Number.isFinite(rawNum) && rawNum > 0 ? rawNum : (fallback ?? "");
    } else {
      out[field.key] = raw ?? field.default ?? "";
    }
  }
  return out;
}
