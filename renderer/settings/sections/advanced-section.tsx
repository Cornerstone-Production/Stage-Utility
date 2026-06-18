import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Switch,
} from "../../components/ui";
import type { SectionProps } from "../types";

export function AdvancedSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <FieldSet title="Advanced">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Enable NDI features</FieldLabel>
              <FieldDescription>
                Shows NDI controls throughout the app — the NDI source field on each view and the NDI
                video object in the layout editor. NDI only works in the native Apple client, so leave
                this off for web/Raspberry Pi displays.
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={stageState.ndiEnabled ?? false}
              onCheckedChange={handlers.handleSetNdiEnabled}
            />
          </Field>
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
