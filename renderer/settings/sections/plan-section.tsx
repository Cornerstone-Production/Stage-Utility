import { useState } from "react";
import { DownloadIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  ButtonGroup,
  Button,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Switch,
  Collapsible,
} from "../../components/ui";
import type { SectionProps } from "../types";
import { ChecklistSources } from "./checklist-sources";
import { ExportPlanDialog } from "./export-plan-dialog";

export function PlanSection({
  stageState,
  serviceTypes,
  plans,
  isRefreshing,
  handlers,
}: Pick<SectionProps, "stageState" | "serviceTypes" | "plans" | "isRefreshing" | "handlers">) {
  const [exporting, setExporting] = useState(false);
  const allowed = stageState.allowedServiceTypeIds ?? [];
  const visibleServiceTypes =
    allowed.length === 0 ? serviceTypes : serviceTypes.filter((st) => allowed.includes(st.id));

  // Toggle which service types are "active" — the ones auto plan mode follows and
  // the manual picker is limited to. An empty allowed-list means "all active".
  function toggleActive(id: string, checked: boolean) {
    let next: string[];
    if (allowed.length === 0) {
      next = checked ? [] : serviceTypes.map((st) => st.id).filter((sid) => sid !== id);
    } else if (checked) {
      next = [...allowed, id];
      if (next.length === serviceTypes.length) next = []; // all on → normalize to "all active"
    } else {
      next = allowed.filter((sid) => sid !== id);
    }
    handlers.handleSetAllowedServiceTypes(next).catch(() => {});
  }

  return (
    <div className="flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <FieldSet data-flash-id="plan-selection">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Plan selection</FieldLabel>
              <FieldDescription>
                {stageState.planMode === "auto"
                  ? "Automatically follows the next upcoming event across your selected service types."
                  : "Manually choose a service type and plan."}
              </FieldDescription>
            </FieldContent>
            <ButtonGroup>
              <Button
                variant={stageState.planMode === "auto" ? "accent" : "filled"}
                size="small"
                onClick={() => handlers.handlePlanModeChange("auto")}
              >
                Auto
              </Button>
              <Button
                variant={stageState.planMode === "manual" ? "accent" : "filled"}
                size="small"
                onClick={() => handlers.handlePlanModeChange("manual")}
              >
                Manual
              </Button>
            </ButtonGroup>
          </Field>

          {/* Service type picker (manual only) */}
          {stageState.planMode === "manual" && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Service type</FieldLabel>
              </FieldContent>
              <Select
                value={stageState.serviceTypeId ?? ""}
                onValueChange={handlers.handleServiceTypeChange}
                disabled={visibleServiceTypes.length === 0}
              >
                <SelectTrigger className="w-full sm:w-52">
                  <SelectValue
                    placeholder={visibleServiceTypes.length === 0 ? "No types found" : "Select…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {visibleServiceTypes.map((st) => (
                    <SelectItem key={st.id} value={st.id}>
                      {st.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {/* Plan picker (manual only) */}
          {stageState.planMode === "manual" && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Plan</FieldLabel>
                <FieldDescription>Upcoming services, plus the last 30 days.</FieldDescription>
              </FieldContent>
              <Select
                value={stageState.planId ?? ""}
                onValueChange={handlers.handlePlanChange}
                disabled={plans.length === 0}
              >
                <SelectTrigger className="w-full sm:w-52">
                  <SelectValue placeholder={plans.length === 0 ? "No plans found" : "Select plan…"} />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                      {p.dates ? ` — ${p.dates}` : ""}
                      {/* Flagged by the server, which built the list — last Sunday
                          and next Sunday would otherwise read identically. */}
                      {p.past && <span className="text-fg-subtle"> · past</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {/* Active plan + next plan + refresh */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Active plan</FieldLabel>
              {stageState.planTitle && (
                <FieldDescription>
                  {stageState.planTitle}
                  {stageState.planDates && (
                    <span className="text-fg-subtle"> · {stageState.planDates}</span>
                  )}
                </FieldDescription>
              )}
            </FieldContent>
            <div className="flex items-center gap-2">
              {stageState.planMode === "auto" && (
                <Button variant="filled" size="small" onClick={handlers.handleNextPlan}>
                  Next plan
                </Button>
              )}
              <Button
                variant="filled"
                size="small"
                onClick={handlers.handleRefresh}
                disabled={isRefreshing}
                aria-label="Refresh from PCO"
              >
                {isRefreshing ? (
                  <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5 text-gray-9" />
                )}
                Refresh
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </FieldSet>

      {serviceTypes.length > 0 && (() => {
        // Active types (or all, when none are singled out) stay visible; the rest
        // collapse behind a disclosure so a short active set isn't buried under a
        // wall of off-switches for types you never run.
        const isActive = (id: string) => allowed.length === 0 || allowed.includes(id);
        const active = serviceTypes.filter((st) => isActive(st.id));
        const inactive = serviceTypes.filter((st) => !isActive(st.id));
        const row = (st: (typeof serviceTypes)[number]) => (
          <Field key={st.id} orientation="horizontal">
            <FieldContent>
              <FieldLabel>{st.name}</FieldLabel>
            </FieldContent>
            <Switch
              checked={isActive(st.id)}
              onCheckedChange={(v: boolean) => toggleActive(st.id, v)}
              aria-label={`Activate ${st.name}`}
            />
          </Field>
        );
        return (
          <FieldSet>
            <FieldGroup>
              {/* Export sits with the types it exports, rather than under
                  Advanced beside the whole-machine snapshot: this is one
                  service type's setup, and the type is chosen here. */}
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Active Service Types</FieldLabel>
                  <FieldDescription>
                    Auto plan mode follows only active types, and the manual picker is limited to
                    them. Turning all off is the same as having them all active.
                  </FieldDescription>
                </FieldContent>
                <Button variant="filled" size="small" onClick={() => setExporting(true)}>
                  <DownloadIcon className="size-3.5" /> Export plan…
                </Button>
              </Field>
              <ExportPlanDialog
                open={exporting}
                onOpenChange={setExporting}
                serviceTypes={visibleServiceTypes}
                defaultServiceTypeId={stageState.serviceTypeId ?? null}
              />
              {active.map(row)}
              {/* The slot editors' plan switcher walks these types. Beside the
                  allowlist because it is the same decision continued: which
                  types, and then in what order the editor steps through them.
                  It moves the EDITOR only; nothing here changes what the screens
                  follow. */}
              <Field orientation="vertical">
                <FieldContent>
                  <FieldLabel>Plan switcher in the slot editors</FieldLabel>
                  <FieldDescription>
                    {stageState.planSwitcherMode === "within-type"
                      ? "Within a type: the middle is a dropdown of the allowed types; the arrows walk that type's plans, Default first and then each upcoming date."
                      : "Upcoming plans: the arrows walk every allowed type's plans in date order; the middle names the date and the type."}
                  </FieldDescription>
                </FieldContent>
                <ButtonGroup role="group" aria-label="How the plan switcher steps">
                  <Button
                    variant={stageState.planSwitcherMode === "within-type" ? "accent" : "filled"}
                    aria-pressed={stageState.planSwitcherMode === "within-type"}
                    size="small"
                    onClick={() => { handlers.handleSetPlanSwitcherMode("within-type").catch(() => {}); }}
                  >
                    Within a type
                  </Button>
                  <Button
                    variant={stageState.planSwitcherMode === "upcoming" ? "accent" : "filled"}
                    aria-pressed={stageState.planSwitcherMode === "upcoming"}
                    size="small"
                    onClick={() => { handlers.handleSetPlanSwitcherMode("upcoming").catch(() => {}); }}
                  >
                    Upcoming plans
                  </Button>
                </ButtonGroup>
              </Field>
              {inactive.length > 0 && (
                <Collapsible
                  label="Inactive service types"
                  summary={`${inactive.length} hidden`}
                >
                  {inactive.map(row)}
                </Collapsible>
              )}
            </FieldGroup>
          </FieldSet>
        );
      })()}

      <ChecklistSources stageState={stageState} handlers={handlers} />
    </div>
  );
}
