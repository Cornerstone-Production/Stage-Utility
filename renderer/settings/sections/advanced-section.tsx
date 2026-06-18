import { useState, type ChangeEvent } from "react";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Switch,
  Input,
} from "../../components/ui";
import type { SectionProps } from "../types";

export function AdvancedSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  // Local field state so typing doesn't fight the live store; commit on blur.
  const [publicUrl, setPublicUrl] = useState(stageState.publicUrl ?? "");

  function commitPublicUrl() {
    const trimmed = publicUrl.trim();
    if (trimmed === (stageState.publicUrl ?? "")) return;
    handlers.handleSetPublicUrl(trimmed || null);
  }

  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <FieldSet title="Advanced">
        <FieldGroup>
          <Field orientation="vertical">
            <FieldContent>
              <FieldLabel>Public address (DNS)</FieldLabel>
              <FieldDescription>
                The address people use to reach this server — e.g. a DNS name behind a reverse proxy.
                When set, the connect QR code and the display links use it instead of the local IP.
                Leave blank to use the auto-detected network address.
              </FieldDescription>
            </FieldContent>
            <Input
              value={publicUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPublicUrl(e.target.value)}
              onBlur={commitPublicUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="http://stageutility.prod.cornerstonelife.com"
              className="text-gray-12"
              aria-label="Public address (DNS)"
            />
          </Field>

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
