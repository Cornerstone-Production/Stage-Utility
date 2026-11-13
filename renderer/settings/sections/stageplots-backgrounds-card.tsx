// stageplots-backgrounds-card.tsx — the editor's Backgrounds card: upload a PNG,
// JPEG or PDF, list what is uploaded, and for the selected one its clean-up
// switch, before and after, sizes, which plots use it, and delete.
//
// A PNG or JPEG goes up as it is and the server converts it. A PDF is read in
// the browser: with more than one page a picker asks which, then the PDF is
// kept on the server and the chosen page goes up as a 2400 px PNG. The page is
// chosen here, at upload; using another page means uploading the PDF again,
// because the server keeps the PDF but never sends it back.

import { useEffect, useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { STAGEPLOT_LIMITS, type BackgroundView, type StagePlotsView } from "@main/types/stageplots";

import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { Dialog } from "../../components/ui/dialog";
import { Switch } from "../../components/ui/switch";
import { loadPdf, type OpenPdf } from "../../lib/pdf-raster";
import { formatBytes, plotsUsing } from "../../main/stageplots/doc-helpers";
import { Mono } from "../../main/stageplots/mono";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { CardHeader, Num, SaveError, type Save } from "./stageplots-shared";

const MB = 1024 * 1024;
/** The long edge a PDF page is rendered at, the size the server converts to. A
 *  page whose PNG passes 10 MB goes up as a JPEG (pdf-raster.ts). */
const PAGE_LONG_EDGE = 2400;
/** Pages the picker draws a thumbnail for; past these it offers the number alone. */
const THUMBNAIL_PAGES = 30;

const KIND_OF: Readonly<Record<BackgroundView["original"]["mime"], string>> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPG",
};

function rowDetail(b: BackgroundView): string {
  const first = b.pdfPage && b.pdfPages ? `Page ${b.pdfPage} of ${b.pdfPages}` : `Clean-up ${b.cleanup ? "on" : "off"}`;
  return `${first} · ${formatBytes(b.converted.bytes)}`;
}

interface Picking {
  file: File;
  pdf: OpenPdf;
  page: number;
  thumbs: (string | null)[];
}

function PagePicker({
  picking,
  onChoose,
  onPick,
  onCancel,
  onThumb,
}: {
  picking: Picking;
  onChoose: (page: number) => void;
  onPick: () => void;
  onCancel: () => void;
  onThumb: (page: number, url: string) => void;
}) {
  const { pdf } = picking;
  // Draw the thumbnails one after another once the picker opens.
  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (let page = 1; page <= Math.min(pdf.pages, THUMBNAIL_PAGES) && !stopped; page++) {
        try {
          const blob = await pdf.renderPage(page, 240);
          if (!stopped) onThumb(page, URL.createObjectURL(blob));
        } catch {
          // A page that will not draw keeps its number button; choosing it
          // still tries to render it at full size, which says why if it fails.
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title="Choose a page"
      confirmLabel={`Use page ${picking.page}`}
      onConfirm={onPick}
    >
      <p className="text-footnote text-fg-muted">
        <Mono text={`${picking.file.name} has ${pdf.pages} pages. The page you choose becomes the background; to use another later, upload the PDF again.`} />
      </p>
      <div className="mt-3 grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto" role="group" aria-label="PDF page">
        {Array.from({ length: pdf.pages }, (_, i) => i + 1).map((page) => (
          <button
            key={page}
            type="button"
            aria-pressed={page === picking.page}
            aria-label={`Page ${page}`}
            onClick={() => onChoose(page)}
            className="flex flex-col items-center gap-1 rounded-lg border border-transparent p-1 text-caption1 text-fg-muted hover:bg-fill aria-pressed:border-accent/45 aria-pressed:bg-accent-soft aria-pressed:text-fg"
          >
            {picking.thumbs[page - 1] ? (
              <img src={picking.thumbs[page - 1]!} alt="" className="block h-16 w-full rounded border border-line bg-[var(--su-plot-paper)] object-contain" />
            ) : (
              <span className="block h-16 w-full rounded border border-dashed border-line" />
            )}
            <Num>{page}</Num>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function BackgroundDetail({ doc, background, save, onError }: { doc: StagePlotsView; background: BackgroundView; save: Save; onError: (m: string | null) => void }) {
  const [converting, setConverting] = useState(false);
  const users = plotsUsing(doc, background.id);
  const setCleanup = async (cleanup: boolean) => {
    setConverting(true);
    const r = await save(() => stageplotsApi.updateBackground(background.id, { cleanup }));
    setConverting(false);
    onError(r.ok ? null : r.error);
  };
  const remove = async () => {
    if (users.length > 0) {
      onError(`${background.name} is used by ${users.map((u) => `${u.venue} · ${u.plot}`).join(", ")}. Give those plots another background first.`);
      return;
    }
    if (!(await confirm({ title: `Delete ${background.name}?`, message: "No plot uses it. Its images are removed from the server.", confirmLabel: "Delete background", destructive: true }))) return;
    const r = await save(() => stageplotsApi.deleteBackground(background.id));
    onError(r.ok ? null : r.error);
  };
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-2.5" data-testid="background-detail">
      {background.pdfPage && background.pdfPages && (
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 flex-1">
            <b className="block text-footnote font-medium">PDF page</b>
            <small className="block text-[11px] leading-[14px] text-fg-subtle">
              <Mono text={`Page ${background.pdfPage} of ${background.pdfPages}. Upload the PDF again to use another page.`} />
            </small>
          </span>
        </div>
      )}
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <b className="block text-footnote font-medium">Clean-up</b>
          <small className="block text-[11px] leading-[14px] text-fg-subtle">{converting ? "Converting…" : "Greyscale, even contrast, faded toward white"}</small>
        </span>
        <Switch aria-label="Clean-up" checked={background.cleanup} disabled={converting} onCheckedChange={(on) => void setCleanup(on)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <figure className="m-0">
          <img src={background.sourceUrl} alt="" loading="lazy" className="block aspect-[3/2] w-full rounded-md border border-line bg-[var(--su-plot-paper)] object-contain" />
          <figcaption className="mt-[3px] text-[11px] text-fg-subtle">Before</figcaption>
        </figure>
        <figure className="m-0">
          <img src={background.url} alt="" className="block aspect-[3/2] w-full rounded-md border border-line bg-[var(--su-plot-paper)] object-contain" />
          <figcaption className="mt-[3px] text-[11px] text-fg-subtle">After</figcaption>
        </figure>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] text-caption1">
        <dt className="text-fg-subtle">Original</dt>
        <dd className="m-0 text-right text-fg-soft">
          <Mono text={`${KIND_OF[background.original.mime]} · ${formatBytes(background.original.bytes)}`} />
        </dd>
        <dt className="text-fg-subtle">Web image</dt>
        <dd className="m-0 text-right text-fg-soft" data-testid="web-image">
          <Mono text={`${formatBytes(background.converted.bytes)} · ${background.converted.width} × ${background.converted.height}`} />
        </dd>
        <dt className="text-fg-subtle">Used by</dt>
        <dd className="m-0 text-right text-fg-soft">{users.length > 0 ? users.map((u) => u.plot).join(", ") : "No plots"}</dd>
      </dl>
      <Button variant="transparent" size="small" className="self-start text-danger-11" onClick={() => void remove()}>
        Delete background…
      </Button>
    </div>
  );
}

export function BackgroundsCard({
  doc,
  selectedId,
  onSelect,
  save,
  openPdf = loadPdf,
}: {
  doc: StagePlotsView;
  selectedId: string | null;
  onSelect: (id: string) => void;
  save: Save;
  /** How a PDF is opened in the browser; a test hands in its own. */
  openPdf?: (bytes: ArrayBuffer) => Promise<OpenPdf>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  /** The pick being uploaded. The dialog reports itself closed after Use page, and
   *  that close must not destroy the PDF the upload is about to render from. */
  const uploadingPick = useRef<Picking | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = doc.backgrounds.find((b) => b.id === selectedId) ?? doc.backgrounds[0] ?? null;

  const closePicker = (p: Picking | null) => {
    for (const url of p?.thumbs ?? []) if (url) URL.revokeObjectURL(url);
    p?.pdf.destroy();
    setPicking(null);
  };

  const uploadPage = async (file: File, pdf: OpenPdf, page: number) => {
    const name = file.name.slice(0, STAGEPLOT_LIMITS.nameChars);
    setBusy("Uploading the PDF…");
    const kept = await save(() => stageplotsApi.uploadPdf(name, file));
    if (!kept.ok) {
      setBusy(null);
      setError(kept.error);
      return;
    }
    setBusy(`Rendering page ${page}…`);
    let raster: Blob;
    try {
      raster = await pdf.renderPage(page, PAGE_LONG_EDGE);
    } catch (err) {
      setBusy(null);
      setError(`Couldn't render page ${page} of ${file.name}: ${errorMessage(err)}`);
      return;
    }
    setBusy("Converting…");
    const made = await save(() => stageplotsApi.uploadImage(name, raster, { original: kept.value.originalHash, page, pages: pdf.pages }));
    setBusy(null);
    setError(made.ok ? null : made.error);
    if (made.ok) onSelect(made.value.id);
  };

  const upload = async (file: File) => {
    setError(null);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const cap = isPdf ? STAGEPLOT_LIMITS.pdfBytes : STAGEPLOT_LIMITS.imageBytes;
    if (file.size > cap) {
      setError(`${file.name} is ${formatBytes(file.size)}; ${isPdf ? "a PDF" : "an image"} can be at most ${cap / MB} MB.`);
      return;
    }
    if (!isPdf) {
      setBusy("Converting…");
      const r = await save(() => stageplotsApi.uploadImage(file.name.slice(0, STAGEPLOT_LIMITS.nameChars), file));
      setBusy(null);
      setError(r.ok ? null : r.error);
      if (r.ok) onSelect(r.value.id);
      return;
    }
    setBusy("Reading the PDF…");
    let pdf: OpenPdf;
    try {
      pdf = await openPdf(await file.arrayBuffer());
    } catch (err) {
      setBusy(null);
      setError(`Couldn't read ${file.name} as a PDF: ${errorMessage(err)}`);
      return;
    }
    setBusy(null);
    if (pdf.pages === 1) {
      await uploadPage(file, pdf, 1);
      pdf.destroy();
    } else {
      setPicking({ file, pdf, page: 1, thumbs: Array.from({ length: pdf.pages }, () => null) });
    }
  };

  return (
    <section className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="Backgrounds">
      <CardHeader title="Backgrounds">
        <Button variant="filled" size="small" disabled={busy !== null || doc.backgrounds.length >= STAGEPLOT_LIMITS.backgrounds} onClick={() => input.current?.click()}>
          <UploadIcon className="size-3.5" />
          {busy ?? "Upload"}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,application/pdf,.pdf"
          className="hidden"
          data-testid="background-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </CardHeader>
      <p className="text-caption1 text-fg-subtle">
        PNG or JPG up to <Num>{STAGEPLOT_LIMITS.imageBytes / MB}</Num> MB, PDF up to <Num>{STAGEPLOT_LIMITS.pdfBytes / MB}</Num> MB. Converted once into a quiet web image.
      </p>
      <SaveError message={error} />
      {doc.backgrounds.length > 0 && (
        <div className="flex flex-col gap-1">
          {doc.backgrounds.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-current={b.id === selected?.id}
              onClick={() => onSelect(b.id)}
              className="grid grid-cols-[54px_minmax(0,1fr)] items-center gap-2.5 rounded-lg border border-transparent p-1 text-left transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-[current=true]:border-accent/45 aria-[current=true]:bg-accent-soft"
            >
              <img src={b.url} alt="" loading="lazy" className="block h-9 w-[54px] rounded border border-line bg-[var(--su-plot-paper)] object-cover" />
              <span className="min-w-0">
                <b className="block truncate text-caption1 font-medium text-fg">{b.name}</b>
                <small className="block text-[11px] leading-[14px] text-fg-subtle">
                  <Mono text={rowDetail(b)} />
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      {selected && <BackgroundDetail key={selected.id} doc={doc} background={selected} save={save} onError={setError} />}
      {picking && (
        <PagePicker
          picking={picking}
          onThumb={(page, url) => setPicking((p) => (p ? { ...p, thumbs: p.thumbs.map((t, i) => (i === page - 1 ? url : t)) } : p))}
          onChoose={(page) => setPicking((p) => (p ? { ...p, page } : p))}
          onCancel={() => uploadingPick.current !== picking && closePicker(picking)}
          onPick={() => {
            const p = picking;
            uploadingPick.current = p;
            setPicking(null);
            void uploadPage(p.file, p.pdf, p.page).finally(() => {
              uploadingPick.current = null;
              closePicker(p);
            });
          }}
        />
      )}
    </section>
  );
}
