// The Branding page's dialogs: one per asset, opened from its card.
//
// Every dialog is the same shape: a short description, whatever previews the
// image, and a footer with Upload (Replace once set), Adjust and Remove. The icon
// dialog adds the size previews and the background swatches. Nothing here talks to
// the server: each action is a callback into branding-section.tsx, which owns the
// file picker, the cropper and the writes.

import type { ReactNode } from "react";
import { CropIcon, TrashIcon, UploadIcon } from "lucide-react";
import { BrandLogo } from "../../components/brand-logo";
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  FieldLabel,
} from "../../components/ui";
import { cn } from "../../lib/cn";
import { AndroidIcon, Describe, IosIcon, TabIcon, type Brand } from "./branding-cards";
import { LogoCropper } from "./logo-cropper";

/** Behind-the-icon colours offered for transparent areas: black, two of the app's
 *  own blues, and white. The server accepts any #rrggbb; these are the choices. */
const ICON_BACKGROUNDS = ["#000000", "#15425c", "#2e6691", "#ffffff"] as const;

/** The dialog frame: header with the title, a body, and a footer rule above the actions. */
function Frame({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0">
        <div className="border-b border-line px-[18px] py-3.5 pr-12">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
        </div>
        <div className="flex flex-col gap-4 p-[18px]">{children}</div>
        <div className="flex items-center gap-2 border-t border-line px-[18px] py-3">{footer}</div>
      </DialogContent>
    </DialogRoot>
  );
}

/** A dialog's explanatory line, which is also what names it to a screen reader. */
function Lead({ children }: { children: ReactNode }) {
  return <DialogDescription className="text-caption1 text-fg-muted">{children}</DialogDescription>;
}

/** Upload (Replace once set), then Adjust, then Remove pushed to the far side. */
function Actions({
  isSet,
  busy,
  onUpload,
  onAdjust,
  onRemove,
  removeLabel,
}: {
  isSet: boolean;
  busy?: boolean;
  onUpload: () => void;
  onAdjust: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <>
      <Button variant="filled" size="small" disabled={busy} onClick={onUpload}>
        <UploadIcon className="size-3.5 text-gray-9" />
        {isSet ? "Replace" : "Upload"}
      </Button>
      {isSet && (
        <>
          <Button variant="filled" size="small" disabled={busy} onClick={onAdjust}>
            <CropIcon className="size-3.5 text-gray-9" />
            Adjust
          </Button>
          <Button
            variant="filled"
            size="small"
            disabled={busy}
            onClick={onRemove}
            className="ml-auto text-danger-11"
            aria-label={removeLabel}
          >
            <TrashIcon className="size-3.5" />
            Remove
          </Button>
        </>
      )}
    </>
  );
}

interface ImageActions {
  onClose: () => void;
  onUpload: () => void;
  onAdjust: () => void;
  onRemove: () => void;
}

// ── Logo ──────────────────────────────────────────────────────────────────────

export function LogoDialog({ open, brand, ...actions }: { open: boolean; brand: Brand } & ImageActions) {
  const isSet = !!brand.appLogo;
  return (
    <Frame
      title="Logo"
      open={open}
      onClose={actions.onClose}
      footer={<Actions isSet={isSet} removeLabel="Remove logo" {...actions} />}
    >
      <div className="grid h-[200px] place-items-center rounded-[10px] bg-black">
        {isSet ? (
          <BrandLogo
            logo={brand.appLogo}
            monochrome={brand.appLogoMonochrome}
            className="size-[150px]"
            style={{ color: "#ededf0" }}
          />
        ) : (
          <span className="text-[12.5px] text-white/50">No logo yet</span>
        )}
      </div>
      <Lead>
        PNG, JPG, SVG or WebP, up to 1.5 MB. Appears next to the name in the sidebar and on every display.
      </Lead>
    </Frame>
  );
}

// ── Empty slot image and default avatar ───────────────────────────────────────

export function EmptySlotDialog({ open, isSet, ...actions }: { open: boolean; isSet: boolean } & ImageActions) {
  return (
    <Frame
      title="Empty slot image"
      open={open}
      onClose={actions.onClose}
      footer={<Actions isSet={isSet} removeLabel="Remove empty slot image" {...actions} />}
    >
      <Lead>Centered in empty slots on the kiosk, recolored to the display&apos;s gray. Optional.</Lead>
    </Frame>
  );
}

export function AvatarDialog({ open, isSet, ...actions }: { open: boolean; isSet: boolean } & ImageActions) {
  return (
    <Frame
      title="Default avatar"
      open={open}
      onClose={actions.onClose}
      footer={<Actions isSet={isSet} removeLabel="Remove default avatar" {...actions} />}
    >
      <Lead>
        Shown for scheduled people who have no photo in Planning Center, in place of their initials, recolored
        to match the theme. Optional. A built-in silhouette is used if unset.
      </Lead>
    </Frame>
  );
}

// ── Tab and home-screen icon ──────────────────────────────────────────────────

/** One size of the icon, in the frame it appears in, with its name under it. */
function Size({ label, size, round, children }: { label: string; size: number; round?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-[11px] text-fg-muted">
      <div
        className="grid place-items-center overflow-hidden bg-black"
        style={{ width: size, height: size, borderRadius: round ? "50%" : 4 }}
      >
        {children}
      </div>
      {label}
    </div>
  );
}

export function IconDialog({
  open,
  brand,
  background,
  busy,
  onBackground,
  onUseLogo,
  ...actions
}: {
  open: boolean;
  brand: Brand;
  /** The colour behind transparent areas: the saved one, or the pick to use on creation. */
  background: string;
  /** An icon is being drawn and saved; the controls wait for it. */
  busy: boolean;
  onBackground: (hex: string) => void;
  /** Build the icon from the logo already set. */
  onUseLogo: () => void;
} & ImageActions) {
  const isSet = !!brand.appIcon192;
  return (
    <Frame
      title="Tab and home-screen icon"
      open={open}
      onClose={actions.onClose}
      footer={
        <>
          <Actions isSet={isSet} busy={busy} removeLabel="Remove tab and home-screen icon" {...actions} />
          {!isSet && (
            <Button
              variant="transparent"
              size="small"
              disabled={busy || !brand.appLogo}
              onClick={onUseLogo}
              title={brand.appLogo ? undefined : "Set a logo first"}
            >
              Use my logo
            </Button>
          )}
        </>
      }
    >
      <Lead>
        A square PNG, SVG or WebP, at least 512 × 512. Stage Utility makes every size from it: the browser tab,
        the iPhone and iPad home screen, and Android&apos;s round and rounded-square masks.
      </Lead>
      <div className="flex flex-wrap items-end gap-[18px]">
        <Size label="Tab 16" size={16}>
          <TabIcon brand={brand} size={16} />
        </Size>
        <Size label="Tab 32" size={32}>
          <TabIcon brand={brand} size={32} />
        </Size>
        <Size label="iPhone 180" size={60}>
          <IosIcon brand={brand} size={60} />
        </Size>
        <Size label="Android 192" size={64} round>
          <AndroidIcon brand={brand} size={64} />
        </Size>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col">
          <FieldLabel>Background</FieldLabel>
          <Describe>Fills transparent areas. Phones would otherwise fill them with black.</Describe>
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Icon background">
          {ICON_BACKGROUNDS.map((hex) => (
            <button
              key={hex}
              type="button"
              disabled={busy}
              onClick={() => onBackground(hex)}
              aria-pressed={background.toLowerCase() === hex}
              aria-label={`Background ${hex}`}
              style={{ backgroundColor: hex }}
              className={cn(
                "size-[26px] rounded-[7px] border border-line-strong transition-transform",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                "disabled:opacity-50",
                background.toLowerCase() === hex && "outline outline-2 outline-offset-2 outline-fg",
              )}
            />
          ))}
        </div>
      </div>
      <Describe className="mt-0">
        Uses the app name for the home-screen label: <b className="text-fg">{brand.appName}</b>.
      </Describe>
    </Frame>
  );
}

// ── Position and zoom ─────────────────────────────────────────────────────────

/** The crop editor, in a dialog of its own. The panel inside carries its own title,
 *  zoom, Save and Cancel; the dialog title is there for screen readers. */
export function CropDialog({
  crop,
  onCancel,
  onSave,
}: {
  crop: {
    src: string;
    initial: { scale: number; x: number; y: number } | null;
    noun: string;
    monochrome: boolean;
  } | null;
  onCancel: () => void;
  onSave: (result: { logo: string; original: string; crop: { scale: number; x: number; y: number } }) => void;
}) {
  return (
    <DialogRoot open={crop !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[560px] p-[18px]">
        <DialogTitle className="sr-only">Crop {crop?.noun ?? "image"}</DialogTitle>
        <DialogDescription className="sr-only">Drag to reposition, use the slider to zoom, then save.</DialogDescription>
        {crop && (
          <LogoCropper
            key={crop.src}
            src={crop.src}
            initial={crop.initial}
            monochrome={crop.monochrome}
            noun={crop.noun}
            className="border-0 bg-transparent p-0"
            onCancel={onCancel}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </DialogRoot>
  );
}
