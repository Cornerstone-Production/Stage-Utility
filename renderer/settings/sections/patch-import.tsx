import { useMemo, useRef, useState } from "react";
import { UploadIcon, XIcon, DownloadIcon } from "lucide-react";

import { Button } from "../../components/ui";
import { invoke } from "../../lib/api";

/** Minimal RFC-4180-ish CSV parser (handles quoted fields + embedded commas/newlines). */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "")) lines.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x.trim() !== "")) lines.push(row);
  }
  const headers = (lines.shift() ?? []).map((h) => h.trim());
  return { headers, rows: lines };
}

type FieldKey = "index" | "label" | "mic" | "phantom" | "console" | "from";
const FIELDS: { key: FieldKey; label: string; required?: boolean }[] = [
  { key: "index", label: "Channel # (rack)", required: true },
  { key: "label", label: "Source / name" },
  { key: "mic", label: "Mic / DI" },
  { key: "phantom", label: "48V" },
  { key: "console", label: "Console ch" },
  { key: "from", label: "From (routing)" },
];

/** Guess a column for each field from the header text. */
function autoMap(headers: string[]): Record<FieldKey, number> {
  const find = (re: RegExp) => headers.findIndex((h) => re.test(h.toLowerCase()));
  return {
    index: find(/(^#$)|input|channel|\bch\b|rack in/),
    label: find(/source|name|instrument/),
    mic: find(/mic|\bdi\b/),
    phantom: find(/48|phantom/),
    console: find(/console/),
    from: find(/snake|stage input|pocket|from|path|\bto\b/),
  };
}

const truthy = (v: string) => /^(x|y|yes|true|1|48v?)$/i.test(v.trim());

/** Best-effort parse of a "From" cell ("Snake B-1", "SL Drop Snake - 1", or an
 *  "A → B" chain) into path hops, matching device names by longest prefix. The
 *  remainder after the device name is the connector. Segments matching no device
 *  are returned as leftover text (kept as a note so nothing is lost). */
function parseHops(raw: string, devices: PatchDevice[]): { hops: PatchHop[]; leftover: string } {
  const segments = raw.split(/→|->|>|;/).map((s) => s.trim()).filter(Boolean);
  const byLen = [...devices].filter((d) => d.name).sort((a, b) => b.name.length - a.name.length);
  const hops: PatchHop[] = [];
  const unmatched: string[] = [];
  for (const seg of segments) {
    const low = seg.toLowerCase();
    const dev = byLen.find((d) => low.startsWith(d.name.toLowerCase()));
    if (dev) hops.push({ deviceId: dev.id, connector: seg.slice(dev.name.length).replace(/^[\s\-/:·|]+/, "").trim() });
    else unmatched.push(seg);
  }
  return { hops, leftover: unmatched.join(" ") };
}

/**
 * CSV import with column mapping (Phase B). Parses a CSV client-side, lets the
 * operator map columns → patch fields, and upserts endpoints into the draft by
 * rack + dir + channel #. xlsx import is a planned follow-on (server-side parse).
 */
export function PatchImport({
  devices,
  endpoints,
  dir,
  onChange,
  onClose,
}: {
  devices: PatchDevice[];
  endpoints: PatchEndpoint[];
  dir: "in" | "out";
  onChange: (next: PatchEndpoint[]) => void;
  onClose: () => void;
}) {
  const racks = devices.filter((d) => d.kind === "rack");
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [map, setMap] = useState<Record<FieldKey, number>>({ index: -1, label: -1, mic: -1, phantom: -1, console: -1, from: -1 });
  const [rackId, setRackId] = useState<string>(racks[0]?.id ?? "");
  const [err, setErr] = useState<string | null>(null);

  async function onFile(file: File) {
    setErr(null);
    try {
      let p: { headers: string[]; rows: string[][] };
      if (/\.xlsx$/i.test(file.name)) {
        // Parse server-side (avoids bundling a spreadsheet reader into the renderer).
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        p = await invoke<{ headers: string[]; rows: string[][] }>("patch:parseXlsx", { xlsx: btoa(bin) });
      } else {
        p = parseCsv(await file.text());
      }
      if (!p.headers.length) { setErr("Couldn't read any columns from that file."); return; }
      setParsed(p);
      setMap(autoMap(p.headers));
    } catch {
      setErr("Couldn't read that file. Try exporting a clean CSV.");
    }
  }

  // A ready-to-fill starter CSV whose headers auto-map, using a real device name
  // in the routing example so it parses straight into the diagram on import.
  function downloadTemplate() {
    const box = devices.find((d) => d.kind !== "rack");
    const sn = box?.name ?? "Snake B";
    const header = dir === "in" ? ["Ch", "Source", "Mic", "48V", "Console", "From"] : ["Ch", "Name", "Console", "To"];
    const rows =
      dir === "in"
        ? [["1", "Kick In", "e901", "X", "1", `${sn} 1`], ["2", "Kick Out", "Beta 52", "", "2", `${sn} 2`], ["41", "Wireless 1", "", "", "41", ""]]
        : [["1", "Mains L", "1", `${sn} 1`], ["2", "IEM Vox 1", "2", ""]];
    const esc = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `patch-${dir === "in" ? "inputs" : "outputs"}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const preview = useMemo(() => (parsed ? parsed.rows.slice(0, 3) : []), [parsed]);

  function apply() {
    if (!parsed || !rackId || map.index < 0) return;
    const key = (i: number) => `${rackId}:${dir}:${i}`;
    const next = new Map<string, PatchEndpoint>(endpoints.map((e) => [`${e.rackId}:${e.dir}:${e.index}`, e]));
    let added = 0;
    for (const r of parsed.rows) {
      const idx = parseInt((r[map.index] ?? "").replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(idx) || idx <= 0) continue;
      const cur = next.get(key(idx)) ?? { rackId, dir, index: idx };
      const cell = (k: FieldKey) => (map[k] >= 0 ? (r[map[k]] ?? "").trim() : "");
      const fromRaw = cell("from");
      const { hops, leftover } = fromRaw ? parseHops(fromRaw, devices) : { hops: [], leftover: "" };
      next.set(key(idx), {
        ...cur,
        label: cell("label") || cur.label,
        mic: dir === "in" ? cell("mic") || cur.mic : cur.mic,
        phantom: dir === "in" && map.phantom >= 0 ? truthy(cell("phantom")) : cur.phantom,
        consoleChannel: cell("console") || cur.consoleChannel,
        // Parse the routing column into path hops; unmatched text stays as a note.
        path: hops.length ? hops : cur.path,
        notes: fromRaw ? (hops.length ? leftover || cur.notes : fromRaw) : cur.notes,
      });
      added++;
    }
    onChange(Array.from(next.values()));
    onClose();
  }

  return (
    <div className="rounded-xl border border-line-strong bg-surface-raised p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-footnote font-semibold text-fg">Import — {dir === "in" ? "Inputs" : "Outputs"}</h3>
        <button type="button" onClick={onClose} className="rounded p-1 text-fg-subtle hover:text-fg" aria-label="Close import"><XIcon className="size-4" /></button>
      </div>

      {racks.length === 0 ? (
        <p className="mt-2 text-footnote text-fg-muted">Add a rack device first, then import into it.</p>
      ) : !parsed ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="filled" size="small" onClick={() => fileRef.current?.click()}><UploadIcon className="size-3.5" /> Choose CSV / Excel file</Button>
            <Button variant="transparent" size="small" onClick={downloadTemplate}><DownloadIcon className="size-3.5" /> Download template</Button>
          </div>
          {err && <p className="text-footnote text-warn-11">{err}</p>}
          <p className="text-caption2 text-fg-subtle">Import a CSV or .xlsx export of your patch sheet, then map the columns here — or start from the template.</p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-footnote text-fg-muted">
            Import into
            <select value={rackId} onChange={(e) => setRackId(e.target.value)} className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg">
              {racks.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-caption2 text-fg-subtle">
                {f.label}{f.required ? " *" : ""}
                <select
                  value={map[f.key]}
                  onChange={(e) => setMap((m) => ({ ...m, [f.key]: Number(e.target.value) }))}
                  className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg"
                >
                  <option value={-1}>— none —</option>
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Col ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>

          {preview.length > 0 && map.index >= 0 && (
            <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption2 text-fg-muted">
              <div className="mb-1 font-semibold uppercase tracking-wider text-fg-subtle">Preview</div>
              {preview.map((r, i) => (
                <div key={i} className="tabular-nums">
                  #{(r[map.index] ?? "").trim() || "—"} · {map.label >= 0 ? (r[map.label] ?? "").trim() : "(no source)"}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button variant="accent" size="small" onClick={apply} disabled={map.index < 0 || !rackId}>Apply import</Button>
            <Button variant="transparent" size="small" onClick={() => setParsed(null)}>Choose a different file</Button>
          </div>
          {map.index < 0 && <p className="text-caption2 text-warn-11">Map the Channel # column to continue.</p>}
        </div>
      )}
    </div>
  );
}
