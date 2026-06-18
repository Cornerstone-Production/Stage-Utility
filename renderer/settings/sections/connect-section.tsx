import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Switch,
} from "../../components/ui";
import { QrHint } from "../../components/qr-hint";
import type { SectionProps } from "../types";

export function ConnectSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 py-5 max-sm:py-4">
      <FieldSet title="Remote Connection">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Show connect QR on display</FieldLabel>
              <FieldDescription>
                Displays the QR code and LAN URL in the kiosk top bar.
              </FieldDescription>
            </FieldContent>
            <Switch checked={stageState.showQr ?? false} onCheckedChange={handlers.handleShowQrChange} />
          </Field>

          {stageState.remoteUrl && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Connect a phone</FieldLabel>
                <FieldDescription>
                  Scan this code or open the address on a phone on the same network to control the
                  display remotely.
                </FieldDescription>
              </FieldContent>
              <QrHint url={stageState.remoteUrl} />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
