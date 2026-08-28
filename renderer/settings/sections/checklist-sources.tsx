// Which of a plan's notes become the pre-service checklist.
//
// The options are read LIVE from Planning Center rather than stored, because a
// category renamed there has to appear under its new name. A picker built from a
// remembered copy is how somebody ends up choosing an option that matches
// nothing and cannot tell why their checklist is empty.
//
// A stored name that PCO no longer offers is kept in the list and marked, rather
// than dropped. Dropping it would silently unselect the operator's choice and
// leave the widget empty with nothing on screen to explain it — the same failure
// the ScriptView preset code documents from the other direction.

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
  type MultiSelectOption,
} from "../../components/ui";
import { invoke } from "../../lib/api";
import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import type { SectionProps } from "../types";

interface Sources {
  categories: string[];
  teams: string[];
}

/** Options for one picker: what PCO offers, plus any stored name it no longer does. */
function optionsFor(offered: readonly string[], chosen: readonly string[]): MultiSelectOption[] {
  const live = new Set(offered);
  const missing = chosen.filter((c) => !live.has(c));
  return [
    ...offered.map((name) => ({ value: name, label: name })),
    ...missing.map((name) => ({ value: name, label: `${name} (not in Planning Center)` })),
  ];
}

export function ChecklistSources({
  stageState,
  handlers,
}: Pick<SectionProps, "stageState" | "handlers">) {
  const [sources, setSources] = useState<Sources | null>(null);

  const categories = stageState.checklistNoteCategories ?? [];
  const teams = stageState.checklistNoteTeams ?? [];
  const serviceTypeId = stageState.serviceTypeId;

  // Re-read when the service type changes: categories belong to a service type,
  // so the options for a Weekend plan are not the options for an Events night.
  useEffect(() => {
    if (!serviceTypeId) return;
    let current = true;
    invoke<Sources>("checklist:sources")
      .then((s) => { if (current) setSources(s); })
      // Left null rather than emptied: an empty picker and a picker that could
      // not be loaded look identical, and the description below says which.
      .catch(() => { if (current) setSources(null); });
    return () => { current = false; };
  }, [serviceTypeId]);

  // Derived rather than cleared in the effect: without a service type there are
  // no categories to offer, and clearing state synchronously inside an effect
  // cascades a render for something the render can simply decide.
  const offered = serviceTypeId ? sources : null;
  const chosen = categories.length + teams.length;

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
              {!serviceTypeId && " Choose a service type first."}
              {serviceTypeId && !offered && " Could not read the categories from Planning Center."}
            </FieldDescription>
          </FieldContent>
        </Field>

        <Field>
          <FieldContent>
            <FieldLabel>Note categories</FieldLabel>
            <FieldDescription>Every note filed under these becomes part of the list.</FieldDescription>
          </FieldContent>
          <MultiSelect
            options={optionsFor(offered?.categories ?? [], categories)}
            selected={categories}
            onChange={(next) => { void handlers.handleSetChecklistSources(next, teams); }}
            placeholder="None"
            disabled={!serviceTypeId}
          />
        </Field>

        <Field>
          <FieldContent>
            <FieldLabel>Teams</FieldLabel>
            <FieldDescription>
              Also take any note assigned to these teams, whatever category it is filed under.
            </FieldDescription>
          </FieldContent>
          <MultiSelect
            options={optionsFor(offered?.teams ?? [], teams)}
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
