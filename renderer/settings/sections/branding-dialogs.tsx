// The Branding page's dialogs: one per asset, opened from its card.
//
// Every dialog is the same shape: a short description, the image in its crop
// editor (or a place to drop one), and a footer with Upload (Replace once set) and
// Remove. The editor is in the dialog itself, open from the start. The icon dialog
// adds the size previews and the background swatches. Nothing here
// talks to the server: each action is a callback into branding-section.tsx, which
// owns the file picker, the cropper's state and the writes.

import { useState, type ReactNode } from "react";
import { ImageIcon, TrashIcon, UploadIcon } from "lucide-react";
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  FieldLabel,
  Switch,
} from "../../components/ui";
import { ColorField } from "../../components/ui/color-field";
import { cn } from "../../lib/cn";
import { AndroidIcon, CHECKER, Describe, DropVeil, IosIcon, TabStrip, useImageSize, type Brand } from "./branding-cards";
import { useFileDrop } from "../../lib/use-file-drop";
import { useResyncOn } from "../../lib/use-resync-on";
import { useTrailingCommit } from "../../lib/use-trailing-commit";
import { ART_MAX } from "../../lib/app-icon-render";
import { resolveAccent } from "../../lib/icon-ink";
import { NO_TAB_BACKGROUND } from "@main/services/install-metadata";

const BLACK = "#000000";
const WHITE = "#ffffff";
/** Where Custom starts, before the operator has picked anything. */
const CUSTOM_START = "#c2410c";

function currentAccent(accentColor: string | null): string {
  const css = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--brand-accent");
  return resolveAccent(accentColor, css);
}

/** The shape every swatch shares. */
const SWATCH = cn(
  "relative size-[26px] rounded-[7px] border border-line-strong transition-transform",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
  "disabled:opacity-50",
);
const SELECTED = "outline outline-2 outline-offset-2 outline-fg";
/**
 * A background colour: Transparent (where `allowNone`), Black, White, Accent and
 * Custom. The server takes any `#rrggbb`; these are the choices, and what is
 * stored is the colour itself.
 */
/** `whenFree`: a pick made as the dialog closes. If an icon is being made, it runs after that one. */
export interface PickOptions {
  whenFree?: boolean;
}

function BackgroundField({
  label,
  description,
  value,
  allowNone,
  accentColor,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  /** `#rrggbb`, or "none" where `allowNone`. */
  value: string;
  allowNone: boolean;
  accentColor: string | null;
  busy: boolean;
  onChange: (value: string, options?: PickOptions) => void;
}) {
  const accent = currentAccent(accentColor);
  const current = value.toLowerCase();
  const isNone = current === NO_TAB_BACKGROUND;
  const isCustom = !isNone && current !== BLACK && current !== WHITE && current !== accent;
  const [custom, setCustom] = useState(isCustom ? current : CUSTOM_START);
  // A colour saved from another browser moves the swatch with it. Only a custom value does:
  // picking black must not forget the custom colour the wheel last held.
  useResyncOn([value], () => {
    if (isCustom) setCustom(current);
  });

  // The wheel commits as the pointer moves, and each commit redraws every size and
  // saves them: only where the pointer stops is sent (useTrailingCommit). A commit that
  // lands while a save is running waits for it, or the last colour would be dropped. Closing
  // the dialog flushes what is pending; if a save is still running then, `whenFree` asks
  // the section to run it once that one is done.
  const schedule = useTrailingCommit<string>(
    (next, { unmounting }) => onChange(next, unmounting ? { whenFree: true } : undefined),
    350,
    { waitWhile: () => busy },
  );

  const choices: { id: string; name: string; hex: string | null }[] = [
    ...(allowNone ? [{ id: NO_TAB_BACKGROUND, name: "Transparent", hex: null }] : []),
    { id: BLACK, name: "Black", hex: BLACK },
    { id: WHITE, name: "White", hex: WHITE },
    { id: accent, name: "Accent", hex: accent },
  ];
  const picked = (id: string) => id === current;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-[200px] flex-col">
        <FieldLabel>{label}</FieldLabel>
        <Describe>{description}</Describe>
      </div>
      <div className="flex items-center gap-2" role="group" aria-label={label}>
        {choices.map((c) => (
          <button
            key={c.name}
            type="button"
            disabled={busy}
            onClick={() => onChange(c.id)}
            aria-pressed={picked(c.id)}
            aria-label={`${label} ${c.name.toLowerCase()}`}
            title={c.name}
            style={c.hex ? { backgroundColor: c.hex } : undefined}
            className={cn(SWATCH, c.hex === null && CHECKER, picked(c.id) && SELECTED)}
          />
        ))}
        <span
          title="Custom colour"
          aria-pressed={isCustom}
          className={cn(
            SWATCH,
            "bg-[conic-gradient(from_180deg,#c2410c,#0d9488,#5b9bd8,#6e56cf,#c2410c)]",
            isCustom && SELECTED,
            busy && "pointer-events-none opacity-50",
          )}
        >
          <ColorField
            label={`${label}, custom colour`}
            allowAlpha={false}
            value={custom}
            onChange={(v: string) => {
              setCustom(v);
              schedule(v.toLowerCase());
            }}
            className="absolute inset-0 [&>button]:size-full [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:opacity-0"
          />
        </span>
      </div>
    </div>
  );
}

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

/** One preview with its name under it. No frame of its own: each preview is the
 *  shape it has where it is used, and a backing square behind a rounded one shows
 *  at its corners. */
function Preview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-[11px] text-fg-muted">
      {children}
      {label}
    </div>
  );
}

export function IconDialog({
  open,
  brand,
  accentColor,
  homeBackground,
  tabBackground,
  recolor,
  busy,
  onHomeBackground,
  onTabBackground,
  onRecolor,
  onUseLogo,
  editor,
  ...actions
}: {
  open: boolean;
  brand: Brand;
  /** The accent the Accent swatch resolves to (null: the theme's own). */
  accentColor: string | null;
  /** The home-screen icon's background: the saved one, or the pick to use on creation. */
  homeBackground: string;
  /** The tab's: `#rrggbb` or "none". The saved one, or the pick to use on creation. */
  tabBackground: string;
  /** Recolor to match theme, which the logo card also holds: the icon follows it. */
  recolor: boolean;
  /** An icon is being drawn and saved; the controls wait for it. */
  busy: boolean;
  onHomeBackground: (hex: string, options?: PickOptions) => void;
  onTabBackground: (value: string, options?: PickOptions) => void;
  onRecolor: (on: boolean) => void;
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
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col">
          <FieldLabel>Recolor to match theme</FieldLabel>
          <Describe>
            The same setting as the logo&apos;s. The art is drawn in the ink that reads against what is behind it.
            Off draws it as uploaded.
          </Describe>
        </div>
        <Switch
          checked={recolor}
          disabled={busy}
          onCheckedChange={onRecolor}
          aria-label="Recolor icon to match theme"
        />
      </div>
      <BackgroundField
        label="Tab background"
        description="Transparent shows just the logo in the tab, in the ink that suits the browser."
        value={tabBackground}
        allowNone
        accentColor={accentColor}
        busy={busy}
        onChange={onTabBackground}
      />
      <BackgroundField
        label="Home-screen background"
        description="Fills transparent areas. Phones would otherwise fill them with black."
        value={homeBackground}
        allowNone={false}
        accentColor={accentColor}
        busy={busy}
        onChange={onHomeBackground}
      />
      <div className="flex flex-wrap items-end gap-[18px]">
        <Preview label="Tab, light browser">
          <TabStrip brand={brand} scheme="light" />
        </Preview>
        <Preview label="Tab, dark browser">
          <TabStrip brand={brand} scheme="dark" />
        </Preview>
        <Preview label="iPhone 180">
          <IosIcon brand={brand} size={60} />
        </Preview>
        <Preview label="Android 192">
          <AndroidIcon brand={brand} size={64} />
        </Preview>
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
