import { Loader2Icon, RefreshCwIcon } from "lucide-react";
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

export function PlanSection({
  stageState,
  serviceTypes,
  plans,
  isRefreshing,
  handlers,
}: Pick<SectionProps, "stageState" | "serviceTypes" | "plans" | "isRefreshing" | "handlers">) {
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
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <FieldSet>
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
              <Field orientation="vertical">
                <FieldContent>
                  <FieldLabel>Active Service Types</FieldLabel>
                  <FieldDescription>
                    Auto plan mode follows only active types, and the manual picker is limited to
                    them. Turning all off is the same as having them all active.
                  </FieldDescription>
                </FieldContent>
              </Field>
              {active.map(row)}
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
    </div>
  );
}
