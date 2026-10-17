import { useState, useRef, useEffect, useCallback, type ChangeEvent } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { FieldLabel, Button, Input, Switch, toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import type { SectionProps } from "../types";
import { cn } from "../../lib/cn";
import { ColorField } from "../../components/ui/color-field";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { errorMessage } from "@main/services/errors";
import { logToServer } from "../../lib/client-log";
import { renderIconSizes, toIconArt } from "../../lib/app-icon-render";
import { AvatarCard, CARD, Describe, EmptySlotCard, IconCard, IdentityStage, QrCard } from "./branding-cards";
import { AvatarDialog, CropDialog, EmptySlotDialog, IconDialog, LogoDialog } from "./branding-dialogs";

// Convenience presets for the brand accent (any org can also pick a custom hex).
// Kept non-generic: a considered blue plus a few distinct hues. Semantic status
// colors (green/red/amber) are separate and never themed.
const ACCENT_PRESETS = ["#2e6691", "#3b82a6", "#5b9bd8", "#6e56cf", "#0d9488", "#c2410c"];

// Keep in sync with the server-side cap in remote-server.ts (~1.5 MB decoded
// leaves headroom under the 2 MB data-URL limit).
const MAX_LOGO_BYTES = 1_500_000;
const ACCEPTED = "image/png,image/jpeg,image/svg+xml,image/webp";

/** What a new icon is drawn over until the operator picks something else. */
const DEFAULT_ICON_BACKGROUND = "#000000";

type Crop = { scale: number; x: number; y: number };
type Target = "app" | "empty" | "avatar" | "icon";

/** The word the crop editor uses for each thing it can crop. */
const NOUN: Record<Target, string> = { app: "logo", empty: "image", avatar: "image", icon: "icon" };

export function BrandingSection({
  stageState,
  handlers,
}: Pick<SectionProps, "stageState" | "handlers">) {
  const [name, setName] = useState(stageState.appName);
  /** Which asset's dialog is open. */
  const [dialog, setDialog] = useState<Target | null>(null);
  /** The crop editor, when one is open: the image, where it was last left, and what it is for. */
  const [crop, setCrop] = useState<{ src: string; initial: Crop | null; target: Target } | null>(null);
  /** An icon is being drawn and saved: its controls wait. */
  const [iconBusy, setIconBusy] = useState(false);
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
  const commitAccent = useCallback(
    (v: string) => {
      accentPending.current = v;
      if (accentSave.current) clearTimeout(accentSave.current);
      accentSave.current = setTimeout(() => {
        accentSave.current = null;
        const next = accentPending.current;
        accentPending.current = null;
        if (next != null) handlers.handleSetBranding({ accentColor: next });
      }, 250);
    },
    [handlers],
  );
  useEffect(
    () => () => {
      if (!accentSave.current) return;
      clearTimeout(accentSave.current);
      const next = accentPending.current;
      if (next != null) handlers.handleSetBranding({ accentColor: next });
    },
    [handlers],
  );

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

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Image is too large — please use one under 1.5 MB.");
      return;
    }
    const target = pickTarget.current;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) {
        toast.error("Could not read that image.");
        return;
      }
      setDialog(null);
      setCrop({ src: dataUrl, initial: null, target }); // fresh upload
    };
    reader.onerror = () => toast.error("Could not read that image.");
    reader.readAsDataURL(file);
  }

  /** The saved background once an icon exists, else the pick for the one about to be made. */
  const iconBackground = stageState.appIcon192 ? stageState.appIconBackground : draftBackground;

  /** The saved upload and crop behind a target, for re-editing. The icon also hands
   *  back its art, which a new background is redrawn from. */
  async function sourceOf(target: Target): Promise<BrandingSource | null> {
    try {
      return await invoke<BrandingSource>("stage:getBrandingSource", { target });
    } catch (err) {
      logToServer("branding", `could not read the saved ${NOUN[target]} to edit: ${errorMessage(err)}`);
      return null;
    }
  }

  // Re-open the editor on the ORIGINAL upload, restoring saved zoom/position.
  async function onAdjust(target: Target) {
    const fallback =
      target === "app"
        ? stageState.appLogo
        : target === "empty"
          ? stageState.emptySlotLogo
          : target === "avatar"
            ? stageState.defaultAvatar
            : stageState.appIcon192;
    const source = await sourceOf(target);
    const src = source?.original ?? source?.art ?? fallback;
    if (!src) {
      toast.error("There is nothing to adjust.");
      return;
    }
    setDialog(null);
    setCrop({ src, initial: source?.crop ?? null, target });
  }

  /**
   * Draw every size of the icon from `art` over `background` and save the set.
   *
   * Resolves true only when the server took it. A failure to draw is shown and put
   * on /log here; a refusal by the server is shown by the write itself. Either way
   * the dialog stays open, so nothing reads as saved that was not.
   */
  async function saveIcon(icon: {
    art: string;
    original: string | null;
    crop: Crop | null;
    background: string;
  }): Promise<boolean> {
    setIconBusy(true);
    try {
      const sizes = await renderIconSizes(icon.art, icon.background);
      return await handlers.handleSetBranding({ icon: { ...icon, ...sizes } });
    } catch (err) {
      logToServer("branding", `the tab and home-screen icon could not be drawn: ${errorMessage(err)}`);
      toast.error(`Could not make the icon: ${errorMessage(err)}`);
      return false;
    } finally {
      setIconBusy(false);
    }
  }

  /** Build the icon from the logo that is already set, with the same crop. */
  async function buildIconFromLogo() {
    if (!stageState.appLogo) return;
    setIconBusy(true);
    let art: string;
    let source: BrandingSource | null;
    try {
      [art, source] = await Promise.all([toIconArt(stageState.appLogo), sourceOf("app")]);
    } catch (err) {
      logToServer("branding", `the icon could not be built from the logo: ${errorMessage(err)}`);
      toast.error(`Could not make the icon from your logo: ${errorMessage(err)}`);
      return;
    } finally {
      setIconBusy(false);
    }
    const ok = await saveIcon({
      art,
      original: source?.original ?? null,
      crop: source?.crop ?? null,
      background: iconBackground,
    });
    if (ok) setDialog(null);
  }

  /** A swatch: redraw the saved icon over the new colour, or just remember it for the next one. */
  async function pickBackground(hex: string) {
    if (!stageState.appIcon192) {
      setDraftBackground(hex);
      return;
    }
    const source = await sourceOf("icon");
    try {
      const art = await toIconArt(source?.art ?? stageState.appIcon192);
      await saveIcon({ art, original: source?.original ?? null, crop: source?.crop ?? null, background: hex });
    } catch (err) {
      logToServer("branding", `the icon could not be redrawn on the new background: ${errorMessage(err)}`);
      toast.error(`Could not change the background: ${errorMessage(err)}`);
    }
  }

  async function onCropSave(result: { logo: string; original: string; crop: Crop }) {
    if (!crop) return;
    const target = crop.target;
    if (target === "icon") {
      try {
        const art = await toIconArt(result.logo);
        const ok = await saveIcon({ art, original: result.original, crop: result.crop, background: iconBackground });
        if (ok) setCrop(null);
      } catch (err) {
        logToServer("branding", `the icon could not be drawn from the crop: ${errorMessage(err)}`);
        toast.error(`Could not make the icon: ${errorMessage(err)}`);
      }
      return;
    }
    const saved =
      target === "app"
        ? { logo: result.logo, logoOriginal: result.original, logoCrop: result.crop }
        : target === "empty"
          ? { emptyLogo: result.logo, emptyLogoOriginal: result.original, emptyLogoCrop: result.crop }
          : { avatar: result.logo, avatarOriginal: result.original, avatarCrop: result.crop };
    // The editor stays open when the server refuses, so the work is not lost with the toast.
    if (await handlers.handleSetBranding(saved)) setCrop(null);
  }

  async function remove(field: "logo" | "emptyLogo" | "avatar") {
    if (await handlers.handleSetBranding({ [field]: null })) setDialog(null);
  }

  async function removeIcon() {
    if (await handlers.handleSetBranding({ icon: null })) setDialog(null);
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
        <IdentityStage brand={stageState} onLogo={() => setDialog("app")} />
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
        <IconCard brand={stageState} onOpen={() => setDialog("icon")} />
        <EmptySlotCard image={stageState.emptySlotLogo} onOpen={() => setDialog("empty")} />
        <AvatarCard image={stageState.defaultAvatar} onOpen={() => setDialog("avatar")} />
      </div>

      <QrCard checked={stageState.showQr ?? false} onChange={handlers.handleShowQrChange} />

      <LogoDialog
        open={dialog === "app"}
        brand={stageState}
        onClose={() => setDialog(null)}
        onUpload={() => openPicker("app")}
        onAdjust={() => void onAdjust("app")}
        onRemove={() => void remove("logo")}
      />
      <IconDialog
        open={dialog === "icon"}
        brand={stageState}
        background={iconBackground}
        busy={iconBusy}
        onBackground={(hex) => void pickBackground(hex)}
        onUseLogo={() => void buildIconFromLogo()}
        onClose={() => setDialog(null)}
        onUpload={() => openPicker("icon")}
        onAdjust={() => void onAdjust("icon")}
        onRemove={() => void removeIcon()}
      />
      <EmptySlotDialog
        open={dialog === "empty"}
        isSet={!!stageState.emptySlotLogo}
        onClose={() => setDialog(null)}
        onUpload={() => openPicker("empty")}
        onAdjust={() => void onAdjust("empty")}
        onRemove={() => void remove("emptyLogo")}
      />
      <AvatarDialog
        open={dialog === "avatar"}
        isSet={!!stageState.defaultAvatar}
        onClose={() => setDialog(null)}
        onUpload={() => openPicker("avatar")}
        onAdjust={() => void onAdjust("avatar")}
        onRemove={() => void remove("avatar")}
      />

      {/* Crop / zoom editor — shared by every image. */}
      <CropDialog
        crop={
          crop && {
            src: crop.src,
            initial: crop.initial,
            noun: NOUN[crop.target],
            // The empty-slot image and the avatar are always drawn recoloured; the
            // logo follows the toggle; the icon is drawn exactly as it is.
            monochrome: crop.target === "app" ? stageState.appLogoMonochrome : crop.target !== "icon",
          }
        }
        onCancel={() => setCrop(null)}
        onSave={(r) => void onCropSave(r)}
      />
    </div>
  );
}
