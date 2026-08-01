import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, Loader2Icon, PlusIcon, TrashIcon, XCircleIcon } from "lucide-react";

import { invoke, onNotification } from "../lib/api";
import { Button, InfoHint, Input, NumberInput, Separator, Status, Switch, toast } from "./ui";
import { useResyncOn } from "@renderer/lib/use-resync-on";

const DEFAULT_PORT = 7788;

function TargetBadge({ connection, message }: { connection: ConnectionState; message: string | null }) {
  if (connection === "connected") {
    return (
      <span className="flex items-center gap-1">
        <CheckCircle2Icon className="size-3.5 shrink-0 text-green-10" />
        <span className="text-caption1 text-green-10">Connected</span>
      </span>
    );
  }
  if (connection === "error") {
    return (
      <span className="flex items-center gap-1">
        <XCircleIcon className="size-3.5 shrink-0 text-red-10" />
        <span className="text-caption1 text-red-10">{message ?? "Error"}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Status variant="warning" />
      <span className="text-caption1 text-fg-subtle">Disabled</span>
    </span>
  );
}

function TargetCard({ target, onChanged }: { target: RossTalkTarget; onChanged: () => void }) {
  const [name, setName] = useState(target.name);
  const [host, setHost] = useState(String(target.config.host ?? ""));
  const [port, setPort] = useState<number>(Number(target.config.port ?? DEFAULT_PORT));
  const [family, setFamily] = useState<RossTalkFamily>(target.config.family ?? "carbonite");
  const [testing, setTesting] = useState(false);

  useResyncOn([target], () => {
    setName(target.name);
    setHost(String(target.config.host ?? ""));
    setPort(Number(target.config.port ?? DEFAULT_PORT));
    setFamily(target.config.family ?? "carbonite");
  });

  async function patch(patchBody: Record<string, unknown>) {
    await invoke("rosstalk:updateTarget", { id: target.id, patch: patchBody });
    onChanged();
  }

  async function test() {
    setTesting(true);
    try {
      const r = await invoke<{ ok: boolean; message?: string }>("rosstalk:test", { id: target.id });
      if (r.ok) toast.success(r.message ?? "Reachable");
      else toast.error(r.message ?? "Could not reach the device");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== target.name && void patch({ name })}
          className="h-7 flex-1 min-w-0 text-footnote font-medium"
          aria-label="Target name"
        />
        <TargetBadge connection={target.connection} message={target.message} />
        <Switch
          checked={target.enabled}
          onCheckedChange={(v) => void patch({ enabled: v })}
          aria-label="Enable target"
        />
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label="Remove target"
          onClick={async () => {
            await invoke("rosstalk:removeTarget", { id: target.id });
            onChanged();
          }}
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-caption2 text-fg-muted">Host</span>
          <Input
            value={host}
            placeholder="192.168.1.50"
            onChange={(e) => setHost(e.target.value)}
            onBlur={() => host !== (target.config.host ?? "") && void patch({ config: { host } })}
            className="h-7 text-footnote"
          />
        </label>
        <label className="flex w-24 shrink-0 flex-col gap-1">
          <span className="text-caption2 text-fg-muted">Port</span>
          <NumberInput
            value={port}
            min={1}
            max={65535}
            onChange={(v) => {
              setPort(v);
              void patch({ config: { port: v } });
            }}
            className="h-7 text-footnote"
          />
        </label>
        <label className="flex w-40 shrink-0 flex-col gap-1">
          <span className="flex items-center gap-1 text-caption2 text-fg-muted">
            Device
            <InfoHint>
              Carbonite and Ultrix share command names but not their meaning — XPT has different
              syntax on each, and GPI fires a GPI output on a Carbonite but a salvo on an Ultrix.
              Setting this correctly is what stops a command reaching the wrong kind of device.
            </InfoHint>
          </span>
          <select
            value={family}
            onChange={(e) => {
              const v = e.target.value as RossTalkFamily;
              setFamily(v);
              void patch({ config: { family: v } });
            }}
            className="h-7 rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
            aria-label="Device family"
          >
            <option value="carbonite">Carbonite switcher</option>
            <option value="ultrix">Ultrix router</option>
          </select>
        </label>
        <Button variant="filled" size="small" onClick={() => void test()} disabled={testing}>
          {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : null} Test
        </Button>
      </div>
    </div>
  );
}

/**
 * RossTalk targets + the global simulate switch.
 *
 * Simulate is deliberately the most prominent control here: it is the difference
 * between a rule logging what it would do and a command reaching a live switcher.
 */
export function RossTalkTargetsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["rosstalk:targets"],
    queryFn: () => invoke<{ targets: RossTalkTarget[]; simulate: boolean }>("rosstalk:targets"),
  });
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: ["rosstalk:targets"] }),
    [qc],
  );

  // Targets change from the server too (a connection comes up, simulate is toggled
  // elsewhere), so mirror the broadcast rather than relying on local writes.
  useEffect(() => onNotification("rosstalk:targets-changed", refresh), [refresh]);

  const targets = data?.targets ?? [];
  const simulate = data?.simulate ?? true;

  return (
    <div className="flex flex-col gap-3">
      <div
        className={
          "flex items-start gap-3 rounded-lg border p-3 " +
          (simulate ? "border-amber-6 bg-amber-2/60" : "border-line bg-surface")
        }
      >
        <div className="flex-1 min-w-0">
          <div className="text-footnote font-medium text-fg">Simulate mode</div>
          <p className="mt-0.5 text-caption1 text-fg-muted">
            {simulate
              ? "Commands are logged, not sent. Nothing reaches your switcher."
              : "Commands are sent to the device. Turn simulate on to test safely."}
          </p>
        </div>
        <Switch
          checked={simulate}
          onCheckedChange={async (v) => {
            await invoke("rosstalk:setSimulate", { simulate: v });
            refresh();
          }}
          aria-label="Simulate mode"
        />
      </div>

      <Separator />

      {targets.length === 0 ? (
        <p className="text-caption1 text-fg-muted">
          No targets yet. Add one per Ross device — a Carbonite switcher or an Ultrix router.
        </p>
      ) : (
        targets.map((t) => <TargetCard key={t.id} target={t} onChanged={refresh} />)
      )}

      <div>
        <Button
          variant="filled"
          size="small"
          onClick={async () => {
            await invoke("rosstalk:addTarget", {});
            refresh();
          }}
        >
          <PlusIcon className="size-3.5" /> Add target
        </Button>
      </div>
    </div>
  );
}
