import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  CopyIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  DropletIcon,
  CableIcon,
  ClockIcon,
  ScrollTextIcon,
  type LucideIcon,
} from "lucide-react";
import { CompanionInfoPanel } from "../../components/companion-info-panel";
import { invoke, onNotification } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { IconTint } from "../../components/icon-tint";
import type { SectionProps } from "../types";

export function ConnectSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
      <FieldSet>
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

      <ToolsPanel baseUrl={stageState.publicUrl || window.location.origin} iconColors={stageState.iconColors} />

      <CompanionPanel />
    </div>
  );
}

// The app's standalone pages, in the one place whose job is already handing out
// links. They are not displays, so they don't belong on the Displays tab — that
// tab answers "which View does this screen show", and these aren't outputs.
const TOOLS: { path: string; label: string; description: string; icon: LucideIcon }[] = [
  { path: "/scriptview", label: "ScriptView", description: "Rundown dashboard, per service type.", icon: ListChecksIcon },
  { path: "/baptism", label: "Baptisms", description: "Time testimonies and baptisms live.", icon: DropletIcon },
  { path: "/patch", label: "Patch", description: "This week's stage input and output patch.", icon: CableIcon },
  { path: "/history", label: "Service history", description: "Timing, attendance and audio for past services.", icon: ClockIcon },
  { path: "/log", label: "Log", description: "Raw server log — for diagnosing a problem, not for volunteers.", icon: ScrollTextIcon },
];

// Styled as the Displays tab styles a display: a titled card whose footer is the
// URL, click to copy. No QR per tool — these are links you send someone, not codes
// you print and mount, and a wall of QR codes buries the list.
function ToolsPanel({ baseUrl, iconColors }: { baseUrl: string; iconColors?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Tools</span>
      {TOOLS.map((t) => {
        const url = `${baseUrl}${t.path}`;
        const Icon = t.icon;
        return (
          <div
            key={t.path}
            className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]"
          >
            <div className="flex items-center gap-2.5 px-3 pt-2">
              <IconTint itemKey={t.path} icon={Icon} color={iconColors?.[t.path]} label={t.label} />
              <span className="min-w-0 flex-1 truncate text-callout font-semibold leading-tight text-fg">
                {t.label}
              </span>
              <a
                href={t.path}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md p-1 text-fg-subtle transition-colors hover:bg-fill hover:text-fg"
                aria-label={`Open ${t.label}`}
                title={`Open ${t.label}`}
              >
                <ExternalLinkIcon className="size-4" />
              </a>
            </div>
            <p className="px-3 pb-2 pt-1 text-caption2 text-fg-muted">{t.description}</p>
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left transition-colors hover:bg-fill"
              title="Click to copy URL"
              onClick={async () => {
                if (await copyText(url)) toast.success("URL copied");
                else toast.error("Couldn't copy — select the URL manually");
              }}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-caption2 text-fg-subtle">{url}</span>
              <CopyIcon className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Bitfocus Companion connects TO this app, so this just shows the URL + live
// client count — it lives on Connect (alongside the phone-connect flow), not on
// Integrations (there's nothing to dial) or Advanced.
function CompanionPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["integrations:list"],
    queryFn: () =>
      invoke<{ descriptors: IntegrationDescriptor[]; states: IntegrationState[] }>("integrations:list"),
  });
  useEffect(() => {
    return onNotification("integrations:state-changed", (payload: unknown) => {
      const states = payload as IntegrationState[];
      queryClient.setQueryData(
        ["integrations:list"],
        (prev: { descriptors: IntegrationDescriptor[]; states: IntegrationState[] } | undefined) =>
          prev ? { ...prev, states } : prev,
      );
    });
  }, [queryClient]);

  const state = data?.states.find((s) => s.id === "companion");
  if (!state) return null;
  return (
    <FieldSet>
      <CompanionInfoPanel state={state} />
    </FieldSet>
  );
}
