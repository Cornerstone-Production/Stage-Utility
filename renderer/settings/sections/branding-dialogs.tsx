// The Branding page's dialogs: one per asset, opened from its card.
//
// Every dialog is the same shape: a short description, the image in its crop
// editor (or a place to drop one), and a footer with Upload (Replace once set) and
// Remove. The editor is in the dialog itself, open from the start: a separate
// Adjust step meant a second dialog to reach the zoom an operator came for. The
// icon dialog adds the size previews and the background swatches. Nothing here
// talks to the server: each action is a callback into branding-section.tsx, which
// owns the file picker, the cropper's state and the writes.

import type { ReactNode } from "react";
import { ImageIcon, TrashIcon, UploadIcon } from "lucide-react";
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  FieldLabel,
} from "../../components/ui";
import { cn } from "../../lib/cn";
import { AndroidIcon, Describe, DropVeil, IosIcon, TabIcon, useFileDrop, useImageSize, type Brand } from "./branding-cards";
import { ART_MAX } from "../../lib/app-icon-render";

/** Behind-the-icon colours offered for transparent areas: black, two of the app's
 *  own blues, and white. The server accepts any #rrggbb; these are the choices. */
const ICON_BACKGROUNDS = ["#000000", "#15425c", "#2e6691", "#ffffff"] as const;

/** The dialog frame: header with the title, a body, and a footer rule above the
 *  actions. An image file dropped anywhere on it goes to `onFile`. */
function Frame({
  title,
  open,
  onClose,
  onFile,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onFile: (file: File) => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const drop = useFileDrop(onFile);
  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0" {...drop.handlers}>
        <div className="border-b border-line px-[18px] py-3.5 pr-12">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
        </div>
        <div className="flex flex-col gap-4 p-[18px]">{children}</div>
        <div className="flex items-center gap-2 border-t border-line px-[18px] py-3">{footer}</div>
        {drop.over && <DropVeil />}
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * The image as it is being edited, or what stands in for it.
 *
 * `editor` is the crop editor, built by branding-section.tsx from the saved
 * original or a freshly picked file. Without one: a line while the saved original
 * is read, the reason when it could not be, or a place to drop the first image.
 */
export type EditorSlot =
  | { kind: "editor"; node: ReactNode }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" };

function Editor({ slot, onUpload }: { slot: EditorSlot; onUpload: () => void }) {
  switch (slot.kind) {
    case "editor":
      return <>{slot.node}</>;
    case "loading":
      return <p className="text-caption1 text-fg-muted">Opening the image…</p>;
    case "error":
      return (
        <p role="alert" className="text-caption1 text-danger-11">
          {slot.message}
        </p>
      );
    case "empty":
      return (
        <button
          type="button"
          onClick={onUpload}
          className={cn(
            "flex h-[150px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong",
            "text-caption1 text-fg-muted transition-colors hover:bg-fill",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          )}
        >
          <ImageIcon className="size-6 text-fg-subtle" aria-hidden="true" />
          Drop an image here, or click to choose one
        </button>
      );
  }
}

/** A dialog's explanatory line, which is also what names it to a screen reader. */
function Lead({ children }: { children: ReactNode }) {
  return <DialogDescription className="text-caption1 text-fg-muted">{children}</DialogDescription>;
}

/** Upload (Replace once set), then Remove pushed to the far side. */
function Actions({
  isSet,
  busy,
  onUpload,
  onRemove,
  removeLabel,
}: {
  isSet: boolean;
  busy?: boolean;
  onUpload: () => void;
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
      )}
    </>
  );
}

interface ImageActions {
  onClose: () => void;
  onUpload: () => void;
  onRemove: () => void;
  /** A file dropped on the dialog. */
  onFile: (file: File) => void;
  /** The crop editor, or what stands in for it. */
  editor: EditorSlot;
}

// ── Logo ──────────────────────────────────────────────────────────────────────

export function LogoDialog({ open, brand, editor, ...actions }: { open: boolean; brand: Brand } & ImageActions) {
  const isSet = !!brand.appLogo;
  return (
    <Frame
      title="Logo"
      open={open}
      onClose={actions.onClose}
      onFile={actions.onFile}
      footer={<Actions isSet={isSet} removeLabel="Remove logo" {...actions} />}
    >
      <Lead>
        PNG, JPG, SVG or WebP, up to 1.5 MB. Appears next to the name in the sidebar and on every display.
      </Lead>
      <Editor slot={editor} onUpload={actions.onUpload} />
    </Frame>
  );
}

// ── Empty slot image and default avatar ───────────────────────────────────────

export function EmptySlotDialog({ open, isSet, editor, ...actions }: { open: boolean; isSet: boolean } & ImageActions) {
  return (
    <Frame
      title="Empty slot image"
      open={open}
      onClose={actions.onClose}
      onFile={actions.onFile}
      footer={<Actions isSet={isSet} removeLabel="Remove empty slot image" {...actions} />}
    >
      <Lead>Centered in empty slots on the kiosk, recolored to the display&apos;s gray. Optional.</Lead>
      <Editor slot={editor} onUpload={actions.onUpload} />
    </Frame>
  );
}

export function AvatarDialog({ open, isSet, editor, ...actions }: { open: boolean; isSet: boolean } & ImageActions) {
  return (
    <Frame
      title="Default avatar"
      open={open}
      onClose={actions.onClose}
      onFile={actions.onFile}
      footer={<Actions isSet={isSet} removeLabel="Remove default avatar" {...actions} />}
    >
      <Lead>
        Shown for scheduled people who have no photo in Planning Center, in place of their initials, recolored
        to match the theme. Optional. A built-in silhouette is used if unset.
      </Lead>
      <Editor slot={editor} onUpload={actions.onUpload} />
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
  editor,
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
  // Use my logo draws from the logo as it is saved, so say when that is small.
  const logoSize = useImageSize(isSet ? null : brand.appLogo);
  const logoSoft = logoSize !== null && Math.min(logoSize.w, logoSize.h) < ART_MAX;
  return (
    <Frame
      title="Tab and home-screen icon"
      open={open}
      onClose={actions.onClose}
      onFile={actions.onFile}
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
        A square PNG, JPG, SVG or WebP. 512 × 512 or larger looks sharpest. Stage Utility makes every size from
        it: the browser tab, the iPhone and iPad home screen, and Android&apos;s round and rounded-square masks.
      </Lead>
      <Editor slot={editor} onUpload={actions.onUpload} />
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
      {logoSoft && (
        <Describe className="mt-0 text-warn-11">
          Your logo is {logoSize.w} × {logoSize.h}, so an icon made from it may look soft.
        </Describe>
      )}
      <Describe className="mt-0">
        Uses the app name for the home-screen label: <b className="text-fg">{brand.appName}</b>.
      </Describe>
    </Frame>
  );
}
