import {
  FieldSet,
  FieldGroup,
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Switch,
  toast,
} from "../../components/ui";
import { QrHint } from "../../components/qr-hint";
import { copyText } from "../../lib/clipboard";
import type { SectionProps } from "../types";

export function ConnectSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
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
                <button
                  type="button"
                  className="mt-1.5 self-start text-left text-caption2 font-mono text-gray-a9 hover:text-gray-11 transition-colors truncate max-w-full"
                  title="Click to copy URL"
                  onClick={async () => {
                    const ok = await copyText(stageState.remoteUrl!);
                    if (ok) toast.success("URL copied");
                    else toast.error("Couldn't copy — select the address manually");
                  }}
                >
                  {stageState.remoteUrl}
                </button>
              </FieldContent>
              <QrHint url={stageState.remoteUrl} />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
