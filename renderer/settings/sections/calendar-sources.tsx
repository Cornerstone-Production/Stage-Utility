// Which calendars and tags a calendar View draws.
//
// The options are read LIVE from Planning Center rather than stored, because a
// tag renamed there has to appear under its new name. A picker built from a
// remembered copy is how somebody ends up choosing an option that matches
// nothing and cannot tell why their calendar is empty.
//
// A stored choice that PCO no longer offers is kept in the list and marked,
// rather than dropped — the same rule the pre-service checklist follows, and for
// the same reason: dropping it would silently unselect the operator's choice and
// widen the filter to everything, with nothing on screen to explain it. The
// difference here is that the STORED NAME is what makes that possible at all.
// PCO filters by id and ids are unreadable, so a choice whose tag has been
// deleted would otherwise show as a hex string or as nothing.
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
  type MultiSelectOption,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import type { CalendarSelection, CalendarSourceDTO, CalendarTagDTO } from "@main/types/calendar";
import type { View } from "@main/types/stage";

interface Sources {
  calendars: CalendarSourceDTO[];
  tags: CalendarTagDTO[];
}

/** What PCO offers, plus any stored choice it no longer does, marked. */
export function optionsFor(
  offered: readonly { id: string; name: string; groupName?: string }[],
  chosen: readonly CalendarSelection[],
): MultiSelectOption[] {
  const live = new Set(offered.map((o) => o.id));
  const missing = chosen.filter((c) => !live.has(c.id));
  return [
    ...offered.map((o) => ({
      value: o.id,
      // The group is part of the label rather than a heading, because PCO
      // composes several tags as OR within a group and AND across them — two
      // tags from different groups match far less than an operator expects, and
      // a flat list hides that entirely.
      label: o.groupName ? `${o.groupName} · ${o.name}` : o.name,
    })),
    ...missing.map((c) => ({
      value: c.id,
      label: `${c.name || c.id} (not in Planning Center)`,
    })),
  ];
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

export function CalendarSources({ view }: { view: View }) {
  const [sources, setSources] = useState<Sources | null>(null);

  const calendars = view.calendarSources ?? [];
  const tags = view.calendarTags ?? [];

  useEffect(() => {
    let current = true;
    invoke<Sources>("calendar:sources")
      .then((s) => {
        if (current) setSources(s);
      })
      // Left null rather than emptied: an empty picker and a picker that could
      // not be loaded look identical, and the description below says which.
      .catch(() => {
        if (current) setSources(null);
      });
    return () => {
      current = false;
    };
  }, []);

  const save = (nextCalendars: CalendarSelection[], nextTags: CalendarSelection[]) => {
    void invoke("views:setCalendarFilters", {
      id: view.id,
      calendarSources: nextCalendars,
      calendarTags: nextTags,
    });
  };

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
              {!sources && " Could not read the calendars from Planning Center."}
            </FieldDescription>
          </FieldContent>
        </Field>

        <Field>
          <FieldContent>
            <FieldLabel>Calendars</FieldLabel>
            <FieldDescription>
              Which of the organisation&rsquo;s calendars to read. Rooms and resources booked
              against an event usually appear on the main calendar too, so this alone does not
              thin a busy month out — tags do.
            </FieldDescription>
          </FieldContent>
          <MultiSelect
            options={optionsFor(sources?.calendars ?? [], calendars)}
            selected={idsOf(calendars)}
            onChange={(next) => save(toSelections(next, sources?.calendars ?? [], calendars), tags)}
            placeholder="All calendars"
          />
        </Field>

        <Field>
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
            options={optionsFor(sources?.tags ?? [], tags)}
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
