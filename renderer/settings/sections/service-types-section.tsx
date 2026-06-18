import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  Switch,
} from "../../components/ui";
import type { SectionProps } from "../types";

export function ServiceTypesSection({
  stageState,
  serviceTypes,
  handlers,
}: Pick<SectionProps, "stageState" | "serviceTypes" | "handlers">) {
  const allowed = stageState.allowedServiceTypeIds ?? [];

  function toggle(id: string, checked: boolean) {
    let next: string[];
    if (allowed.length === 0) {
      // Currently all-allowed; switching one off means explicitly listing the others
      if (!checked) {
        next = serviceTypes.map((st) => st.id).filter((sid) => sid !== id);
      } else {
        // checked a type when previously all allowed — no-op (already on)
        next = [];
      }
    } else {
      if (checked) {
        next = [...allowed, id];
        // If all types are now checked, normalize to empty (all allowed)
        if (next.length === serviceTypes.length) next = [];
      } else {
        next = allowed.filter((sid) => sid !== id);
      }
    }
    handlers.handleSetAllowedServiceTypes(next).catch(() => {});
  }

  if (serviceTypes.length === 0) {
    return (
      <div className="px-5 py-5">
        <p className="text-body text-gray-9">
          Connect Planning Center in the Integrations section to see your service types.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <FieldSet title="Allowed Service Types">
        <FieldGroup>
          {serviceTypes.map((st) => {
            const isOn = allowed.length === 0 || allowed.includes(st.id);
            return (
              <Field key={st.id} orientation="horizontal">
                <FieldContent>
                  <FieldLabel>{st.name}</FieldLabel>
                </FieldContent>
                <Switch
                  checked={isOn}
                  onCheckedChange={(v: boolean) => toggle(st.id, v)}
                  aria-label={`Allow ${st.name}`}
                />
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
      <p className="text-caption1 text-gray-9">
        Auto plan mode follows only allowed types. The manual picker is also limited to these.
        Disabling all types is the same as allowing all.
      </p>
    </div>
  );
}
