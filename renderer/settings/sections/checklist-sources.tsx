// Which of a plan's notes become the pre-service checklist.
//
// Why the options are read live and why a stored name PCO no longer offers is
// kept and marked: see pco-options.ts, which both live pickers share. Here the
// cost of dropping one is a checklist that goes silently empty — the same
// failure the ScriptView preset code documents from the other direction.
//
// NOTHING CHOSEN MEANS THE CHECKLIST IS OFF, the opposite of the calendar
// picker's rule: a list that filled itself with every note on the plan is noise.

import { useEffect, useState } from "react";

import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  MultiSelect,
  toast,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import { optionsFor as pcoOptions } from "./pco-options";
import { errorMessage } from "@main/services/errors";
import type { SectionProps } from "../types";

interface Sources {
  categories: string[];
  teams: string[];
}

/** Options for one picker. The NAME is the stored value here, so it is both the
 *  id MultiSelect works in and the label the operator reads. */
const optionsFor = (offered: readonly string[], chosen: readonly string[]) =>
  pcoOptions(offered, chosen, { id: (s) => s, label: (s) => s });

/**
 * Three states, not two.
 *
 * A `Sources | null` said "could not read Planning Center" for the whole of
 * every page load, because null is also what it starts as — an operator opening
 * Plan settings was told the read had failed before it had been attempted. The
 * calendar picker documents the same bug and carries the same union.
 */
type Load =
  | { at: "loading" }
  | { at: "failed"; serviceTypeId: string }
  | { at: "loaded"; serviceTypeId: string; sources: Sources };

export function ChecklistSources({
  stageState,
  handlers,
}: Pick<SectionProps, "stageState" | "handlers">) {
  const [result, setResult] = useState<Load>({ at: "loading" });

  const categories = stageState.checklistNoteCategories ?? [];
  const teams = stageState.checklistNoteTeams ?? [];
  const serviceTypeId = stageState.serviceTypeId;

  // Re-read when the service type changes: categories belong to a service type,
  // so the options for a Weekend plan are not the options for an Events night.
  useEffect(() => {
    if (!serviceTypeId) return;
    let current = true;
    invoke<Sources>("checklist:sources")
      .then((s) => { if (current) setResult({ at: "loaded", serviceTypeId, sources: s }); })
      // Failed is its own state, not the absence of one: an empty picker, a
      // picker still loading and a picker that could not be loaded look
      // identical, and the description below is what says which.
      .catch(() => { if (current) setResult({ at: "failed", serviceTypeId }); });
    return () => { current = false; };
  }, [serviceTypeId]);

  // Derived rather than reset in the effect: an answer belonging to the PREVIOUS
  // service type is still "loading" as far as this one is concerned, and
  // deciding that here costs no cascading render.
  const load: Load =
    result.at !== "loading" && result.serviceTypeId === serviceTypeId ? result : { at: "loading" };

  // Without a service type there are no categories to offer at all.
  const offered = serviceTypeId && load.at === "loaded" ? load.sources : null;
  const chosen = categories.length + teams.length;

  /**
   * What to list, given that "(not in Planning Center)" is a CLAIM.
   *
   * Only a landed read can make it. Until then `offered` is empty, and passing
   * that straight to optionsFor routes every stored name through the missing
   * branch — so opening the picker during the round trip showed every choice
   * the operator made marked as gone, directly under a line saying the read is
   * still happening. The picker is enabled throughout, so it is reachable.
   *
   * Not visible while the picker is SHUT, as it happens: with nothing offered,
   * options and chosen are the same list, and MultiSelect's trigger takes its
   * `chosen.length === options.length` branch and reads "All (N)". That is luck,
   * not a design — one live option arriving mid-render would put the marked
   * label straight onto the trigger.
   *
   * Listing the stored choices unmarked until something is known says nothing
   * untrue, and a landed read still marks what it genuinely no longer offers.
   */
  const listing = (live: string[] | undefined, stored: string[]) =>
    optionsFor(offered ? (live ?? []) : stored, stored);

  const status = !serviceTypeId
    ? " Choose a service type first."
    : load.at === "loading"
      ? " Reading the categories from Planning Center…"
      : load.at === "failed"
        ? " Could not read the categories from Planning Center."
        : "";

  return (
    <FieldSet>
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>Pre-service checklist</FieldLabel>
            <FieldDescription>
              Reads the plan&rsquo;s notes in Planning Center. Bullet each line and every bullet
              becomes a row you can tick off on Home; a note with no bullets becomes one row per
              line. Ticks are kept here only — Planning Center does not see them — and start fresh
              with each new plan.
              {status}
            </FieldDescription>
          </FieldContent>
        </Field>

        {/* data-field names the two pickers apart, as the calendar picker's do.
            They are otherwise identical controls whose only distinguishing text
            is a SUMMARY that changes with the selection. */}
        <Field data-field="categories">
          <FieldContent>
            <FieldLabel>Note categories</FieldLabel>
            <FieldDescription>Every note filed under these becomes part of the list.</FieldDescription>
          </FieldContent>
          <MultiSelect
            options={listing(offered?.categories, categories)}
            selected={categories}
            onChange={(next) => { void handlers.handleSetChecklistSources(next, teams); }}
            placeholder="None"
            disabled={!serviceTypeId}
          />
        </Field>

        <Field data-field="teams">
          <FieldContent>
            <FieldLabel>Teams</FieldLabel>
            <FieldDescription>
              Also take any note assigned to these teams, whatever category it is filed under.
            </FieldDescription>
          </FieldContent>
          <MultiSelect
            options={listing(offered?.teams, teams)}
            selected={teams}
            onChange={(next) => { void handlers.handleSetChecklistSources(categories, next); }}
            placeholder="None"
            disabled={!serviceTypeId}
          />
        </Field>

        {chosen === 0 && serviceTypeId && (
          <Field orientation="vertical">
            <FieldContent>
              <FieldDescription>
                Nothing chosen, so the checklist is off. It stays off rather than filling itself
                with every note on the plan.
              </FieldDescription>
            </FieldContent>
          </Field>
        )}

        {chosen > 0 && (
          <Field>
            <FieldContent>
              <FieldLabel>Start this week over</FieldLabel>
              <FieldDescription>
                Unticks every row on the current plan. Rarely needed — a new plan already starts
                with a clean list.
              </FieldDescription>
            </FieldContent>
            <Button
              variant="filled"
              disabled={!stageState.planId}
              onClick={() => {
                // Reported, not swallowed: a clear that silently failed would
                // leave ticks standing that the operator believes are gone.
                void invoke("checklist:clear")
                  .then(() => toast.success("Checklist ticks cleared"))
                  .catch((e: unknown) => toast.error(`Could not clear the ticks: ${errorMessage(e)}`));
              }}
            >
              Clear ticks
            </Button>
          </Field>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
