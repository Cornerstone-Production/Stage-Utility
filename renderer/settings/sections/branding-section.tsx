import { useState, useRef, useEffect, useCallback, type ChangeEvent } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { FieldLabel, Button, Input, Switch, toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import type { SectionProps } from "../types";
import { cn } from "../../lib/cn";
import { ColorField } from "../../components/ui/color-field";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { errorMessage } from "@main/services/errors";
import { DEFAULT_ICON_BACKGROUND } from "@main/services/install-metadata";
import { logToServer } from "../../lib/client-log";
import { ART_MAX, renderIconSizes, toIconArt } from "../../lib/app-icon-render";
import { AvatarCard, CARD, Describe, EmptySlotCard, IconCard, IdentityStage, QrCard } from "./branding-cards";
import { AvatarDialog, EmptySlotDialog, IconDialog, LogoDialog, type EditorSlot } from "./branding-dialogs";
import { LogoCropper } from "./logo-cropper";

// Convenience presets for the brand accent (any org can also pick a custom hex).
// Kept non-generic: a considered blue plus a few distinct hues. Semantic status
// colors (green/red/amber) are separate and never themed.
const ACCENT_PRESETS = ["#2e6691", "#3b82a6", "#5b9bd8", "#6e56cf", "#0d9488", "#c2410c"];

// Keep in sync with the server-side cap in remote-server.ts (~1.5 MB decoded
// leaves headroom under the 2 MB data-URL limit).
const MAX_LOGO_BYTES = 1_500_000;
const ACCEPTED = "image/png,image/jpeg,image/svg+xml,image/webp";
const ACCEPTED_TYPES = ACCEPTED.split(",");


type Crop = { scale: number; x: number; y: number };
type Target = "app" | "empty" | "avatar" | "icon";

/** The word the crop editor uses for each thing it can crop. */
const NOUN: Record<Target, string> = { app: "logo", empty: "image", avatar: "image", icon: "icon" };

/** What the open dialog's crop editor holds: the saved original being read, the
 *  reason it could not be, or the image to edit and where it was last left. */
type Edit =
  | { target: Target; status: "loading" }
  | { target: Target; status: "error"; message: string }
  | { target: Target; status: "ready"; src: string; initial: Crop | null };

export function BrandingSection({
  stageState,
  handlers,
}: Pick<SectionProps, "stageState" | "handlers">) {
  const [name, setName] = useState(stageState.appName);
  /** Which asset's dialog is open. */
  const [dialog, setDialog] = useState<Target | null>(null);
  /** The open dialog's crop editor. */
  const [edit, setEdit] = useState<Edit | null>(null);
  /** Bumped on every open, close and new file, so a saved original that arrives
   *  after the operator has moved on is dropped rather than shown over their pick. */
  const editSeq = useRef(0);
  /** An icon is being drawn and saved: its controls wait. */
  const [iconBusy, setIconBusy] = useState(false);
  /** The same fact for the handlers: state would still read false in a second click's closure. */
  const iconRunning = useRef(false);
  /** The background a NEW icon will be drawn over; once one is set, the saved one rules. */
  const [draftBackground, setDraftBackground] = useState(DEFAULT_ICON_BACKGROUND);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<Target>("app");
  const [accentDraft, setAccentDraft] = useState(stageState.accentColor ?? "#2e6691");
  // The swatch follows the pointer; the SAVE does not.
  //
  // The old <input type="color"> committed on blur — once per edit. ColorField's
  // panel commits from onPointerMove, unthrottled, and this handler wrote to the
  // server inline: one drag across the saturation square fired dozens of
  // stage:setBranding POSTs, each persisting to disk, recomputing and
  // SSE-broadcasting the whole StageState to every display, and raising a toast.
  //
  // Trailing edge only, so the value that lands is where the pointer stopped.
  // Flushed on unmount, or closing the panel mid-drag would drop the last write.
  const accentSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accentPending = useRef<string | null>(null);
  // The latest handlers, read when the save fires. The save and the unmount flush
  // depend on `handlers` through this ref, not through their dependency lists: a
  // page that hands down a new `handlers` on a render would otherwise run the
  // effect's cleanup, flushing the pending save early and defeating the debounce.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);
  const commitAccent = useCallback((v: string) => {
    accentPending.current = v;
    if (accentSave.current) clearTimeout(accentSave.current);
    accentSave.current = setTimeout(() => {
      accentSave.current = null;
      const next = accentPending.current;
      accentPending.current = null;
      if (next != null) handlersRef.current.handleSetBranding({ accentColor: next });
    }, 250);
  }, []);
  useEffect(
    () => () => {
      if (!accentSave.current) return;
      clearTimeout(accentSave.current);
      accentSave.current = null;
      const next = accentPending.current;
      accentPending.current = null;
      if (next != null) handlersRef.current.handleSetBranding({ accentColor: next });
    },
    [],
  );

  // A file dropped anywhere else on this page — between the cards, or on the dim
  // around an open dialog — would make the browser leave the app and open the file
  // in the tab. The cards and dialogs take theirs; everything else is refused.
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);

  useResyncOn([stageState.accentColor], () => {
    setAccentDraft(stageState.accentColor ?? "#2e6691");
  });

  useResyncOn([stageState.appName], () => {
    setName(stageState.appName);
  });

  function commitName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === stageState.appName) {
      setName(stageState.appName);
      return;
    }
    handlers.handleSetBranding({ name: trimmed });
  }

  function openPicker(target: Target) {
    pickTarget.current = target;
    fileRef.current?.click();
  }

  /** Open `target`'s dialog with `file` in its crop editor: from Upload or Replace,
   *  or dropped on the card or the dialog. Nothing is saved until Save. */
  function loadFile(target: Target, file: File) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("That is not a PNG, JPG, SVG or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Image is too large — please use one under 1.5 MB.");
      return;
    }
    const seq = ++editSeq.current;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        toast.error("Could not read that image.");
        return;
      }
      if (editSeq.current !== seq) return;
      setDialog(target);
      setEdit({ target, status: "ready", src: dataUrl, initial: null }); // fresh upload
    };
    reader.onerror = () => toast.error("Could not read that image.");
    reader.readAsDataURL(file);
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) loadFile(pickTarget.current, file);
  }

  /** The saved background once an icon exists, else the pick for the one about to be made. */
  const iconBackground = stageState.appIcon192 ? stageState.appIconBackground : draftBackground;

  /** The saved upload and crop behind a target, for re-editing. The icon also hands
   *  back its art, which a new background is redrawn from. Rejects when it cannot be
   *  read: an editor opened on a stand-in would save the stand-in over the original. */
  async function sourceOf(target: Target): Promise<BrandingSource> {
    try {
      return await invoke<BrandingSource>("stage:getBrandingSource", { target });
    } catch (err) {
      logToServer("branding", `could not read the saved ${NOUN[target]} to edit: ${errorMessage(err)}`);
      throw err;
    }
  }

  /** The image each target has saved now, or null when it has none. */
  const savedImage: Record<Target, string | null> = {
    app: stageState.appLogo,
    empty: stageState.emptySlotLogo,
    avatar: stageState.defaultAvatar,
    icon: stageState.appIcon192,
  };

  /**
   * Open a dialog with its editor already on the ORIGINAL upload, at the saved zoom
   * and position. The editor is the dialog's body, so there is no second step to
   * reach it; with nothing saved the body is a place to drop the first image.
   */
  function openDialog(target: Target) {
    const seq = ++editSeq.current;
    setDialog(target);
    if (!savedImage[target]) {
      setEdit(null);
      return;
    }
    setEdit({ target, status: "loading" });
    sourceOf(target).then(
      (source) => {
        if (editSeq.current !== seq) return;
        // The icon's 192 px thumbnail has its background baked in: no source for an icon.
        const src = source.original ?? source.art ?? (target === "icon" ? null : savedImage[target]);
        setEdit(
          src
            ? { target, status: "ready", src, initial: source.crop ?? null }
            : { target, status: "error", message: `The saved ${NOUN[target]} has no original to edit. Replace it to change it.` },
        );
      },
      (err: unknown) => {
        if (editSeq.current !== seq) return;
        setEdit({ target, status: "error", message: `Could not open the saved ${NOUN[target]} to edit: ${errorMessage(err)}` });
      },
    );
  }

  function closeDialog() {
    editSeq.current++;
    setDialog(null);
    setEdit(null);
  }

  /** Close the dialog a write was started from, unless the operator has since
   *  closed it or opened another: a slow save must not shut the next one. */
  function closeAfter(seq: number) {
    if (editSeq.current === seq) closeDialog();
  }

  /** What an icon is made from. `art` is any square image; it is brought down to 512. */
  interface IconSpec {
    art: string;
    original: string | null;
    crop: Crop | null;
    background: string;
  }

  /**
   * Make the icon from `build()`'s answer: draw every size and save the set.
   *
   * Resolves true only when the server took it. A failure at any step is shown and
   * put on /log here, except a refusal by the server, which the write itself shows.
   * The dialog stays open either way, so nothing reads as saved that was not. A
   * second request while one is running is dropped, from the moment of the click:
   * two overlapping ones would land in whichever order their image decodes finished.
   */
  async function makeIcon(build: () => Promise<IconSpec>): Promise<boolean> {
    if (iconRunning.current) return false;
    iconRunning.current = true;
    setIconBusy(true);
    try {
      const spec = await build();
      const art = await toIconArt(spec.art);
      const sizes = await renderIconSizes(art, spec.background);
      return await handlers.handleSetBranding({ icon: { ...spec, art, ...sizes } });
    } catch (err) {
      logToServer("branding", `the tab and home-screen icon could not be made: ${errorMessage(err)}`);
      toast.error(`Could not make the icon: ${errorMessage(err)}`);
      return false;
    } finally {
      iconRunning.current = false;
      setIconBusy(false);
    }
  }

  /** Build the icon from the logo that is already set, with the same crop. */
  async function buildIconFromLogo() {
    const logo = stageState.appLogo;
    if (!logo) return;
    const ok = await makeIcon(async () => {
      const source = await sourceOf("app");
      return { art: logo, original: source.original, crop: source.crop, background: iconBackground };
    });
    if (ok) closeDialog();
  }

  /** A swatch: redraw the saved icon over the new colour, or just remember it for the next one. */
  async function pickBackground(hex: string) {
    if (!stageState.appIcon192) {
      setDraftBackground(hex);
      return;
    }
    if (hex === stageState.appIconBackground) return;
    await makeIcon(async () => {
      const source = await sourceOf("icon");
      if (!source.art) throw new Error("the saved icon has no art to redraw; replace the icon instead");
      return { art: source.art, original: source.original, crop: source.crop, background: hex };
    });
  }

  async function onCropSave(result: { logo: string; original: string; crop: Crop }) {
    if (!edit) return;
    const target = edit.target;
    const seq = editSeq.current;
    if (target === "icon") {
      const ok = await makeIcon(async () => ({
        art: result.logo,
        original: result.original,
        crop: result.crop,
        background: iconBackground,
      }));
      if (ok) closeAfter(seq);
      return;
    }
    let saved: Parameters<typeof handlers.handleSetBranding>[0];
    switch (target) {
      case "app":
        saved = { logo: result.logo, logoOriginal: result.original, logoCrop: result.crop };
        break;
      case "empty":
        saved = { emptyLogo: result.logo, emptyLogoOriginal: result.original, emptyLogoCrop: result.crop };
        break;
      case "avatar":
        saved = { avatar: result.logo, avatarOriginal: result.original, avatarCrop: result.crop };
        break;
    }
    // The editor stays open when the server refuses, so the work is not lost with the toast.
    if (await handlers.handleSetBranding(saved)) closeAfter(seq);
  }

  async function remove(field: "logo" | "emptyLogo" | "avatar") {
    const seq = editSeq.current;
    if (await handlers.handleSetBranding({ [field]: null })) closeAfter(seq);
  }

  async function removeIcon() {
    const seq = editSeq.current;
    if (await handlers.handleSetBranding({ icon: null })) closeAfter(seq);
  }

  /** What `target`'s dialog shows where the image goes. */
  function editorFor(target: Target): EditorSlot {
    // No edit for an open dialog means it opened with nothing saved: openDialog
    // sets "loading" itself whenever it starts a read. An image saved meanwhile,
    // from another browser, keeps the drop area rather than a "loading" line no
    // read will ever finish.
    if (edit?.target !== target) return { kind: "empty" };
    if (edit.status === "loading") return { kind: "loading" };
    if (edit.status === "error") return { kind: "error", message: edit.message };
    return {
      kind: "editor",
      node: (
        <LogoCropper
          // One editor per image: a new file starts over at cover, not at the last zoom.
          key={edit.src}
          src={edit.src}
          initial={edit.initial}
          noun={NOUN[target]}
          // The empty-slot image and the avatar are always drawn recoloured; the
          // logo follows the toggle; the icon is drawn exactly as it is.
          monochrome={target === "app" ? stageState.appLogoMonochrome : target !== "icon"}
          // An icon is drawn up to 512 px: a smaller crop is scaled up and looks soft.
          sharpFrom={target === "icon" ? ART_MAX : undefined}
          className="border-0 bg-transparent p-0"
          onCancel={closeDialog}
          onSave={(r) => void onCropSave(r)}
        />
      ),
    };
  }

  return (
    <div className="flex flex-col gap-3 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      {/* Shared hidden file input (target chosen by whichever Upload was clicked). */}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED}
        onChange={onPickFile}
        className="hidden"
        aria-hidden="true"
      />

      {/* ── Identity: the logo and name as a display draws them, and the settings that style them ── */}
      <div className={cn(CARD, "grid overflow-hidden md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]")}>
        <IdentityStage brand={stageState} onLogo={() => openDialog("app")} onFile={(f) => loadFile("app", f)} />
        <div className="flex flex-col gap-[18px] px-6 py-[22px]">
          <div className="flex flex-col">
            <FieldLabel>App name</FieldLabel>
            <Describe>Shown in the sidebar, on every display&apos;s top bar and in the browser tab.</Describe>
            <Input
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder="Stage Utility"
              className="mt-2 h-9 w-full text-[14px]"
              aria-label="App name"
            />
          </div>

          {/* ── Accent color (themeable brand accent) ── */}
          <div className="flex flex-col">
            <FieldLabel>Accent color</FieldLabel>
            <Describe>Buttons, selection, links and focus. Live, over and caution colors are unaffected.</Describe>
            <div className="mt-[9px] flex flex-wrap items-center gap-2">
              {ACCENT_PRESETS.map((hex) => {
                const chosen = stageState.accentColor?.toLowerCase() === hex;
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => handlers.handleSetBranding({ accentColor: hex })}
                    aria-pressed={chosen}
                    className={cn(
                      "size-[26px] rounded-[7px] border border-gray-a5 transition-transform hover:scale-110",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      chosen && "outline outline-2 outline-offset-2 outline-fg",
                    )}
                    style={{ backgroundColor: hex }}
                    aria-label={`Set accent ${hex}`}
                  />
                );
              })}
              <Tooltip label="Custom color">
                {/* The gradient is the label's own background, not an inner element.
                    Nested, it painted to the padding box while the preset swatches
                    paint to the border box — same-size element, 2px less colour, and
                    it read as a smaller chip in the row. */}
                <span
                  className={cn(
                    "relative size-[26px] rounded-[7px] border border-gray-a5 transition-transform hover:scale-110",
                    "bg-[conic-gradient(from_180deg,#c2410c,#0d9488,#5b9bd8,#6e56cf,#c2410c)]",
                  )}
                >
                  {/* The wheel stays the affordance; the app's picker is the
                      panel behind it. An accent is a brand colour and opaque by
                      definition, so no opacity slider. */}
                  <ColorField
                    label="Custom accent color"
                    allowAlpha={false}
                    value={accentDraft}
                    onChange={(v: string) => {
                      setAccentDraft(v);
                      if (v.toLowerCase() !== (stageState.accentColor ?? "").toLowerCase()) {
                        commitAccent(v);
                      }
                    }}
                    className="absolute inset-0 [&>button]:size-full [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:opacity-0"
                  />
                </span>
              </Tooltip>
              <Button
                variant="transparent"
                size="small"
                onClick={() => handlers.handleSetBranding({ accentColor: null })}
              >
                Default
              </Button>
            </div>
          </div>

          {stageState.appLogo && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col">
                <FieldLabel>Recolor to match theme</FieldLabel>
                <Describe>Best for single-color logos. Off shows the logo exactly as uploaded.</Describe>
              </div>
              <Switch
                checked={stageState.appLogoMonochrome}
                onCheckedChange={(v: boolean) => handlers.handleSetBranding({ monochrome: v })}
                aria-label="Recolor logo to match theme"
              />
            </div>
          )}
        </div>
      </div>

      {/* ── The images, each drawn where it is used ── */}
      <div className="grid gap-3 md:grid-cols-3">
        <IconCard brand={stageState} onOpen={() => openDialog("icon")} onFile={(f) => loadFile("icon", f)} />
        <EmptySlotCard
          image={stageState.emptySlotLogo}
          onOpen={() => openDialog("empty")}
          onFile={(f) => loadFile("empty", f)}
        />
        <AvatarCard
          image={stageState.defaultAvatar}
          onOpen={() => openDialog("avatar")}
          onFile={(f) => loadFile("avatar", f)}
        />
      </div>

      <QrCard checked={stageState.showQr ?? false} onChange={handlers.handleShowQrChange} />

      <LogoDialog
        open={dialog === "app"}
        brand={stageState}
        editor={editorFor("app")}
        onClose={closeDialog}
        onUpload={() => openPicker("app")}
        onFile={(f) => loadFile("app", f)}
        onRemove={() => void remove("logo")}
      />
      <IconDialog
        open={dialog === "icon"}
        brand={stageState}
        background={iconBackground}
        busy={iconBusy}
        editor={editorFor("icon")}
        onBackground={(hex) => void pickBackground(hex)}
        onUseLogo={() => void buildIconFromLogo()}
        onClose={closeDialog}
        onUpload={() => openPicker("icon")}
        onFile={(f) => loadFile("icon", f)}
        onRemove={() => void removeIcon()}
      />
      <EmptySlotDialog
        open={dialog === "empty"}
        isSet={!!stageState.emptySlotLogo}
        editor={editorFor("empty")}
        onClose={closeDialog}
        onUpload={() => openPicker("empty")}
        onFile={(f) => loadFile("empty", f)}
        onRemove={() => void remove("emptyLogo")}
      />
      <AvatarDialog
        open={dialog === "avatar"}
        isSet={!!stageState.defaultAvatar}
        editor={editorFor("avatar")}
        onClose={closeDialog}
        onUpload={() => openPicker("avatar")}
        onFile={(f) => loadFile("avatar", f)}
        onRemove={() => void remove("avatar")}
      />
    </div>
  );
}
