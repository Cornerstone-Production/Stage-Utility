// Which calendars and tags a calendar View draws.
//
// Why the options are read live and why a stored choice PCO no longer offers is
// kept and marked: see pco-options.ts, which both live pickers share.
//
// NOTHING CHOSEN MEANS EVERYTHING, which is the opposite of the checklist's
// rule. A checklist that fills itself with every note on the plan is noise; a
// calendar view showing nothing is simply broken, and a View exists before
// anyone has opened its settings.

import { useEffect, useState } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  MultiSelect,
  toast,
  type MultiSelectOption,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import { optionsFor as pcoOptions } from "./pco-options";
import { errorMessage } from "@main/services/errors";
import type { CalendarSelection, CalendarSourceDTO, CalendarTagDTO } from "@main/types/calendar";
import type { View } from "@main/types/stage";

interface Sources {
  calendars: CalendarSourceDTO[];
  tags: CalendarTagDTO[];
}

/** A calendar or a tag as PCO offers it. A stored choice is the same, minus the
 *  group, which is why `chosen` widens to this rather than the other way round. */
interface CalendarOption {
  id: string;
  name: string;
  groupName?: string;
}

/**
 * What PCO offers, plus any stored choice it no longer does, marked.
 *
 * Planning Center filters by ID and ids are unreadable, so the stored NAME is
 * what makes a deleted tag say anything at all — it falls back to the id only
 * when there was never a name to keep.
 */
export function optionsFor(
  offered: readonly CalendarOption[],
  chosen: readonly CalendarSelection[],
): MultiSelectOption[] {
  // Explicit, because `chosen` is the narrower CalendarSelection — a stored
  // choice has no group — and inference would take the narrower of the two.
  return pcoOptions<CalendarOption>(offered, chosen, {
    id: (o) => o.id,
    // The group is part of the label rather than a heading, because PCO
    // composes several tags as OR within a group and AND across them — two
    // tags from different groups match far less than an operator expects, and
    // a flat list hides that entirely. A stored choice carries no group.
    label: (o) => (o.groupName ? `${o.groupName} · ${o.name}` : o.name || o.id),
  });
}

/** The stored selections, as the ids MultiSelect works in. */
function idsOf(list: readonly CalendarSelection[] | null | undefined): string[] {
  return (list ?? []).map((s) => s.id);
}

/**
 * Turn the picker's ids back into stored selections.
 *
 * The name comes from the live list where PCO still offers it — so a renamed tag
 * updates its cached label on the next save — and from the existing stored entry
 * otherwise, which is what keeps a deleted tag readable instead of degrading to
 * an id the moment anything else on the view is changed.
 */
export function toSelections(
  ids: readonly string[],
  offered: readonly { id: string; name: string }[],
  existing: readonly CalendarSelection[],
): CalendarSelection[] {
  const liveNames = new Map(offered.map((o) => [o.id, o.name]));
  const storedNames = new Map(existing.map((s) => [s.id, s.name]));
  return ids.map((id) => ({ id, name: liveNames.get(id) ?? storedNames.get(id) ?? "" }));
}

/**
 * Three states, not two.
 *
 * A `Sources | null` said "could not read Planning Center" for the whole of
 * every page load, because null is also what it starts as — an operator opening
 * these settings was told the read had failed before it had been attempted. And
 * a successful read on an install with no credentials returns two empty lists,
 * not an error, which the same message got wrong in the other direction.
 */
type Load = { at: "loading" } | { at: "failed" } | { at: "loaded"; sources: Sources };

export function CalendarSources({ view, pcoConfigured }: { view: View; pcoConfigured: boolean }) {
  const [load, setLoad] = useState<Load>({ at: "loading" });

  const calendars = view.calendarSources ?? [];
  const tags = view.calendarTags ?? [];
  const sources = load.at === "loaded" ? load.sources : null;

  /**
   * What to list, given that "(not in Planning Center)" is a CLAIM.
   *
   * Only a landed read can make it. Until then `sources` is null, and passing an
   * empty list to optionsFor routes every stored choice through the missing
   * branch — so opening either picker during the round trip showed every choice
   * marked as gone, under a description saying the read is still happening. The
   * checklist picker carries the same note, and the same fix.
   */
  const listing = (live: CalendarOption[] | undefined, stored: CalendarSelection[]) =>
    optionsFor(sources ? (live ?? []) : stored, stored);

  useEffect(() => {
    let current = true;
    invoke<Sources>("calendar:sources")
      .then((s) => {
        if (current) setLoad({ at: "loaded", sources: s });
      })
      .catch(() => {
        if (current) setLoad({ at: "failed" });
      });
    return () => {
      current = false;
    };
  }, []);

  const save = (nextCalendars: CalendarSelection[], nextTags: CalendarSelection[]) => {
    // REPORTED, not dropped. A rejected save leaves the picker showing a choice
    // the server does not have, which the next broadcast silently undoes — the
    // operator sees their tick appear and then vanish for no stated reason.
    void invoke("views:setCalendarFilters", {
      id: view.id,
      calendarSources: nextCalendars,
      calendarTags: nextTags,
    }).catch((e: unknown) => toast.error(`Could not save what this calendar shows: ${errorMessage(e)}`));
  };

  const status =
    load.at === "loading"
      ? " Reading the calendars from Planning Center…"
      : load.at === "failed"
        ? " Could not read the calendars from Planning Center."
        : !pcoConfigured
          ? " Planning Center is not connected yet, so there is nothing to choose from."
          : "";

  return (
    <FieldSet>
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>What this calendar shows</FieldLabel>
            <FieldDescription>
              Filtering is how a month stays readable — an unfiltered day can hold a dozen
              bookings, most of them somebody else&rsquo;s. Choose nothing and every event on every
              calendar is drawn.
              {status}
            </FieldDescription>
          </FieldContent>
        </Field>

        {/* data-field names the two pickers apart. They are otherwise identical
            controls whose only distinguishing text is a SUMMARY that changes
            with the selection, so nothing stable identifies one of them. */}
        <Field data-field="calendars">
          <FieldContent>
            <FieldLabel>Calendars</FieldLabel>
            <FieldDescription>
              Which of the organisation&rsquo;s calendars to read. Rooms and resources booked
              against an event usually appear on the main calendar too, so this alone does not
              thin a busy month out — tags do.
            </FieldDescription>
          </FieldContent>
          <MultiSelect
            options={listing(sources?.calendars, calendars)}
            selected={idsOf(calendars)}
            onChange={(next) => save(toSelections(next, sources?.calendars ?? [], calendars), tags)}
            placeholder="All calendars"
          />
        </Field>

        <Field data-field="tags">
          <FieldContent>
            <FieldLabel>Tags</FieldLabel>
            <FieldDescription>
              A department&rsquo;s tag is what makes this a wall display rather than a wall of
              text. Planning Center matches several tags from the same group as &ldquo;any of
              these&rdquo;, and tags from different groups as &ldquo;all of these&rdquo;, so the
              group is shown before each name.
            </FieldDescription>
          </FieldContent>
          <MultiSelect
            options={listing(sources?.tags, tags)}
            selected={idsOf(tags)}
            onChange={(next) => save(calendars, toSelections(next, sources?.tags ?? [], tags))}
            placeholder="All tags"
          />
        </Field>

        {calendars.length === 0 && tags.length === 0 && (
          <Field orientation="vertical">
            <FieldContent>
              <FieldDescription>
                Nothing chosen, so this view draws the whole calendar. That is deliberate: a
                calendar with no filter is busy, while a calendar with nothing on it looks broken.
              </FieldDescription>
            </FieldContent>
          </Field>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
