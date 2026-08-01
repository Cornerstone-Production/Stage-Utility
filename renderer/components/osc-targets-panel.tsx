import { invoke, onNotification } from "../lib/api";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  Switch,
  Status,
  Separator,
  NumberInput,
  InfoHint,
  toast,
} from "../components/ui";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "../lib/cn";

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

function TargetBadge({ connection, message }: { connection: ConnectionState; message: string | null }) {
  if (connection === "connected") {
    return (
      <span className="flex items-center gap-1">
        <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
        <span className="text-caption1 text-green-10">Active</span>
      </span>
    );
  }
  if (connection === "error") {
    return (
      <span className="flex items-center gap-1">
        <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
        <span className="text-caption1 text-red-10">{message ?? "Error"}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Status variant="warning" />
      <span className="text-caption1 text-gray-9">Disabled</span>
    </span>
  );
}

function TargetCard({ target, onChange }: { target: OscTarget; onChange: (t: OscTarget[]) => void }) {
  const [name, setName] = useState(target.name);
  const [host, setHost] = useState(String(target.config.host ?? ""));
  const [port, setPort] = useState<number>(Number(target.config.port ?? 8000));
  const [sub, setSub] = useState(String(target.config.subscribeAddress ?? ""));
  const [subSec, setSubSec] = useState<number>(Number(target.config.subscribeIntervalSec ?? 9));
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  useResyncOn([target.name], () => setName(target.name));

  async function patch(p: Record<string, unknown>) {
    try {
      const next = await ipc<OscTarget[]>("osc:updateTarget", { id: target.id, patch: p });
      onChange(next);
    } catch (err) {
      toast.error(`Failed to save: ${String(err)}`);
    }
  }
  const patchConfig = (p: Record<string, unknown>) => patch({ config: p });

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      setTestResult(await ipc<{ ok: boolean; message?: string }>("osc:testTarget", { id: target.id }));
    } catch (err) {
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleRemove() {
    try {
      onChange(await ipc<OscTarget[]>("osc:removeTarget", { id: target.id }));
    } catch (err) {
      toast.error(`Failed to remove: ${String(err)}`);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          onBlur={() => name.trim() !== target.name && patch({ name: name.trim() || target.name })}
          placeholder="Target name"
          className="w-40 min-w-0"
          aria-label="Target name"
        />
        <div className="flex-1 min-w-0" />
        <TargetBadge connection={target.connection} message={target.message} />
        <Switch checked={target.enabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label={`Enable ${target.name}`} />
        <Button variant="transparent" size="small" iconOnly onClick={handleRemove} aria-label="Remove target">
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      <div className="flex items-center gap-2 pl-1">
        <Input
          value={host}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setHost(e.target.value)}
          onBlur={() => patchConfig({ host: host.trim() })}
          placeholder="192.168.1.50"
          className="flex-1 min-w-0"
          aria-label="Host"
        />
        <NumberInput value={port} onChange={setPort} onCommit={() => patchConfig({ port })} min={1} max={65535} className="w-44" aria-label="Port" />
      </div>

      <div className="flex items-center gap-2 pl-1">
        <Input
          value={sub}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSub(e.target.value)}
          onBlur={() => patchConfig({ subscribeAddress: sub.trim() })}
          placeholder="Subscribe/keepalive address (optional, e.g. /xremote)"
          className="flex-1 min-w-0"
          aria-label="Subscribe address"
        />
        <NumberInput value={subSec} onChange={setSubSec} onCommit={() => patchConfig({ subscribeIntervalSec: subSec })} min={1} max={60} suffix="s" className="w-28" aria-label="Subscribe interval seconds" />
        <InfoHint>
          Optional. Some gear (e.g. Behringer/Midas) only sends feedback while it keeps hearing from a
          subscriber — enter the address it expects (like /xremote) and how often to send it. Leave blank
          if your device pushes state on its own.
        </InfoHint>
      </div>

      <div className="flex items-center gap-2 pl-1">
        <Button variant="transparent" size="small" onClick={handleTest} disabled={isTesting}>
          {isTesting ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Test
        </Button>
        {testResult !== null && (
          <span className={cn("text-caption1 flex items-center gap-1", testResult.ok ? "text-green-10" : "text-red-10")}>
            {testResult.ok ? <CheckCircle2Icon className="size-3.5 shrink-0" /> : <XCircleIcon className="size-3.5 shrink-0" />}
            {testResult.message ?? (testResult.ok ? "OK" : "Failed")}
          </span>
        )}
      </div>
    </div>
  );
}

export function OscTargetsPanel({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const targetsQuery = useQuery({
    queryKey: ["osc:listTargets"],
    queryFn: () => ipc<OscTarget[]>("osc:listTargets"),
    retry: 1,
  });
  const portQuery = useQuery({
    queryKey: ["osc:getFeedbackPort"],
    queryFn: () => ipc<{ port: number }>("osc:getFeedbackPort"),
  });

  const targets = targetsQuery.data ?? [];
  const [portInput, setPortInput] = useState(9000);
  useResyncOn([portQuery.data], () => {
    if (portQuery.data) setPortInput(portQuery.data.port);
  });

  useEffect(() => {
    return onNotification("osc:targets-changed", (p) => {
      queryClient.setQueryData(["osc:listTargets"], p as OscTarget[]);
    });
  }, [queryClient]);

  function applyUpdate(next: OscTarget[]) {
    queryClient.setQueryData(["osc:listTargets"], next);
  }

  async function handleAdd() {
    try {
      applyUpdate(await ipc<OscTarget[]>("osc:addTarget", {}));
    } catch (err) {
      toast.error(`Failed to add target: ${String(err)}`);
    }
  }

  async function commitPort() {
    if (portInput === portQuery.data?.port) return;
    try {
      const next = await ipc<{ port: number }>("osc:setFeedbackPort", { port: portInput });
      queryClient.setQueryData(["osc:getFeedbackPort"], next);
      setPortInput(next.port);
      toast.success(`OSC feedback port set to ${next.port}`);
    } catch (err) {
      toast.error(`Failed to set port: ${String(err)}`);
    }
  }

  const portField = (
    <div className="flex items-center gap-2 pb-3 mb-1 border-b border-gray-a3">
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-body text-gray-12">Feedback port</span>
        <span className="text-caption1 text-gray-9">Local UDP port devices send OSC feedback to.</span>
      </div>
      <NumberInput value={portInput} onChange={setPortInput} onCommit={commitPort} min={1} max={65535} className="w-28" aria-label="OSC feedback port" />
    </div>
  );

  let body: ReactNode;
  if (targetsQuery.isLoading) {
    body = (
      <div className="flex items-center justify-center py-6">
        <Loader2Icon className="size-5 text-gray-9 animate-spin" />
      </div>
    );
  } else if (targets.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-2 py-1">
        <span className="text-body text-gray-11">No OSC targets</span>
        <span className="text-caption1 text-gray-9">Add a target device to send OSC from custom-layout buttons.</span>
        <Button variant="filled" size="small" onClick={handleAdd} className="mt-1">
          <PlusIcon className="size-3.5 text-gray-9" />
          Add target
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-0">
        {targets.map((t, idx) => (
          <div key={t.id}>
            {idx > 0 && <Separator className="my-4" />}
            <TargetCard target={t} onChange={applyUpdate} />
          </div>
        ))}
        <Separator className="my-4" />
        <Button variant="filled" size="small" onClick={handleAdd} className="self-start">
          <PlusIcon className="size-3.5 text-gray-9" />
          Add target
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-0", className)}>
      {portField}
      {body}
    </div>
  );
}
