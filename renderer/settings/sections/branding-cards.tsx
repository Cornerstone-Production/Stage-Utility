// The Branding page's cards: the identity hero, the three asset cards and the
// connect-QR card.
//
// Each asset card draws its image where it is used, on stage black, so the card is
// the preview: the tab icon in a browser tab and on two home screens, the
// empty-slot image in an empty slot, the default avatar beside a name. Clicking a
// card opens that asset's dialog (branding-dialogs.tsx); dropping an image file on
// one opens it with that file in the crop editor. Nothing here edits.

import { useEffect, useState, type ReactNode } from "react";
import { ImageIcon, UploadIcon, UserRoundIcon } from "lucide-react";
import type { StageState } from "@main/types/state";
import { BrandLogo } from "../../components/brand-logo";
import { FieldDescription, FieldLabel, Switch } from "../../components/ui";
import { cn } from "../../lib/cn";
import { INK, iconInk, tabColor } from "../../lib/icon-ink";
import { useFileDrop } from "../../lib/use-file-drop";

/** A transparency checker that reads on a light or a dark surface: translucent grey
 *  squares, so whatever the theme's surface is shows between them. */
export const CHECKER =
  "bg-[length:10px_10px] bg-[image:conic-gradient(rgba(128,128,128,.35)_25%,transparent_0_50%,rgba(128,128,128,.35)_0_75%,transparent_0)]";

/** The card chrome every block on this page shares: the same material as a FieldSet. */
export const CARD = "rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]";

/** A field's explanatory line: the page's one description style, a step larger than
 *  the default so it reads against the cards' padding. */
export function Describe({ className, children }: { className?: string; children: ReactNode }) {
  return <FieldDescription className={cn("mt-0.5 text-caption1 text-fg-muted", className)}>{children}</FieldDescription>;
}

export type Brand = Pick<
  StageState,
  | "appName"
  | "appLogo"
  | "appLogoMonochrome"
  | "appIcon192"
  | "appIconMaskable"
  | "appIconArt"
  | "appIconTabBackground"
>;

// ── Dropping a file ───────────────────────────────────────────────────────────

/** What a drop target shows while a file is over it. */
export function DropVeil({ label = "Drop to use this image" }: { label?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[inherit]",
        "border-2 border-dashed border-focus bg-black/70 text-[13px] font-medium text-white",
      )}
    >
      {label}
    </div>
  );
}

// ── The icon, as it appears in each place ─────────────────────────────────────

/** The browser tab strip a tab icon is drawn on: light or dark, as the browser is. */
export type TabScheme = "light" | "dark";

/**
 * The icon a browser tab shows, drawn as applyFavicon draws it: the custom icon's
 * art over the tab's own background (none by default, so just the art in the ink
 * that suits `scheme`), else the logo, else the stock icon. `scheme` is the tab
 * strip the icon is on, since a transparent icon has no background of its own.
 */
export function TabIcon({ brand, size, scheme }: { brand: Brand; size: number; scheme: TabScheme }) {
  const themeInk = scheme === "dark" ? INK.dark : INK.light;
  if (brand.appIconArt) {
    const background = tabColor(brand.appIconTabBackground);
    if (!background) {
      return (
        <BrandLogo
          logo={brand.appIconArt}
          monochrome={brand.appLogoMonochrome}
          className="block"
          style={{ width: size, height: size, color: themeInk }}
        />
      );
    }
    return (
      <span
        className="grid place-items-center"
        style={{ width: size, height: size, backgroundColor: background, borderRadius: size * 0.19, padding: size * 0.0625 }}
      >
        <BrandLogo
          logo={brand.appIconArt}
          monochrome={brand.appLogoMonochrome}
          className="block"
          style={{ width: "100%", height: "100%", color: iconInk(background, brand.appLogoMonochrome) ?? undefined }}
        />
      </span>
    );
  }
  if (brand.appLogo) {
    return (
      <BrandLogo
        logo={brand.appLogo}
        monochrome={brand.appLogoMonochrome}
        className="block"
        style={{ width: size, height: size, color: themeInk }}
      />
    );
  }
  return <img src="/favicon.svg" alt="" width={size} height={size} className="block" />;
}

/** A browser tab: the icon beside the app name, on a light or dark tab strip. */
export function TabStrip({ brand, scheme }: { brand: Brand; scheme: TabScheme }) {
  return (
    <div
      className={cn(
        "flex w-[170px] items-center gap-[7px] rounded-lg px-2.5 py-[7px] text-[12px] font-medium",
        scheme === "light" ? "bg-[#ececec] text-[#222222]" : "bg-[#2a2a2a] text-[#eeeeee]",
      )}
    >
      <span className="flex size-4 flex-none items-center justify-center">
        <TabIcon brand={brand} size={16} scheme={scheme} />
      </span>
      <span className="truncate">{brand.appName}</span>
    </div>
  );
}

/** The corner radius iOS rounds a home-screen icon to, as a share of its side. */
export const IOS_RADIUS = 0.22;

/** The icon on an iPhone or iPad home screen: the custom 192 or the built-in 180. */
export function IosIcon({ brand, size }: { brand: Brand; size: number }) {
  return (
    <img
      src={brand.appIcon192 ?? "/apple-touch-icon.png"}
      alt=""
      width={size}
      height={size}
      className="block shadow-[0_0_0_1px_var(--su-line)]"
      style={{ borderRadius: Math.round(size * IOS_RADIUS) }}
    />
  );
}

/** The icon on an Android home screen, in the round mask: the maskable image,
 *  whose art keeps to the safe zone, so the circle crops what a launcher would. */
export function AndroidIcon({ brand, size }: { brand: Brand; size: number }) {
  return (
    <img
      src={brand.appIconMaskable ?? "/icon-maskable-512.png"}
      alt=""
      width={size}
      height={size}
      className="block rounded-full shadow-[0_0_0_1px_var(--su-line)]"
    />
  );
}

// ── Identity ──────────────────────────────────────────────────────────────────

/** The logo large on a stage-black canvas, and the name beneath it: how the app
 *  introduces itself on a display. The logo is the control that changes the logo. */
export function IdentityStage({
  brand,
  onLogo,
  onFile,
}: {
  brand: Brand;
  onLogo: () => void;
  onFile: (file: File) => void;
}) {
  const hasLogo = !!brand.appLogo;
  const drop = useFileDrop(onFile);
  return (
    <div
      className="relative flex min-h-[300px] flex-col items-center justify-center gap-[18px] bg-black p-7"
      {...drop.handlers}
    >
      {drop.over && <DropVeil label="Drop to use as the logo" />}
      <button
        type="button"
        onClick={onLogo}
        aria-label={hasLogo ? "Change logo" : "Add a logo"}
        className={cn(
          "group relative grid size-[168px] place-items-center rounded-[18px] border border-dashed",
          "transition-colors hover:border-white/35 hover:bg-white/[.04]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          hasLogo ? "border-transparent" : "border-white/25",
        )}
      >
        {hasLogo ? (
          <BrandLogo
            logo={brand.appLogo}
            monochrome={brand.appLogoMonochrome}
            className="size-[132px]"
            style={{ color: INK.dark }}
          />
        ) : (
          <span className="flex flex-col items-center gap-2 text-[12.5px] text-white/50">
            <UploadIcon className="size-6" aria-hidden="true" />
            Add a logo
          </span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            "absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-[3px]",
            "border border-white/[.14] bg-[rgba(28,28,28,.95)] text-[11.5px] text-[#ededf0]",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        >
          {hasLogo ? "Change logo" : "Add logo"}
        </span>
      </button>
      <div className="max-w-full truncate px-2 text-center text-[30px] font-semibold tracking-[-0.01em] text-white">
        {brand.appName}
      </div>
      <span className="absolute bottom-3 left-3.5 text-[11px] text-white/40">
        How it appears on a stage display. Click the logo, or drop an image here, to change it.
      </span>
    </div>
  );
}

// ── Asset cards ───────────────────────────────────────────────────────────────

/** Natural pixel size of an image, once it has loaded; null before that or when it
 *  cannot be measured. Only used for the "1024 × 1024" in a state line. */
export function useImageSize(src: string | null): { w: number; h: number } | null {
  const [size, setSize] = useState<{ src: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!src || typeof Image === "undefined") return;
    const img = new Image();
    img.onload = () => setSize({ src, w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);
  // Keyed by src so a replaced image never shows its predecessor's size.
  return src && size && size.src === src && size.w > 0 ? size : null;
}

function AssetCard({
  title,
  description,
  state,
  onOpen,
  onFile,
  children,
}: {
  title: string;
  description: string;
  state: string;
  onOpen: () => void;
  onFile: (file: File) => void;
  children: ReactNode;
}) {
  const drop = useFileDrop(onFile);
  return (
    <button
      type="button"
      onClick={onOpen}
      {...drop.handlers}
      className={cn(
        CARD,
        "group relative flex flex-col overflow-hidden text-left transition-colors hover:border-line-strong",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
      )}
    >
      {drop.over && <DropVeil />}
      <div className="relative grid h-[170px] place-items-center overflow-hidden bg-black">{children}</div>
      <div className="flex flex-col gap-[3px] px-3.5 py-3">
        <b className="text-[14px] font-semibold text-fg">{title}</b>
        <span className="text-caption1 text-fg-muted">{description}</span>
        <div className="mt-1.5 text-caption1 text-fg-subtle">{state}</div>
      </div>
    </button>
  );
}

/** The state line for an image that is set: "Set · 1024 × 1024" once measured. */
function setLine(size: { w: number; h: number } | null): string {
  return size ? `Set · ${size.w} × ${size.h}` : "Set";
}

export function IconCard({ brand, onOpen, onFile }: { brand: Brand; onOpen: () => void; onFile: (file: File) => void }) {
  return (
    <AssetCard
      title="Tab and home-screen icon"
      description="Browser tab, bookmarks, and the icon when the app is added to a phone or tablet home screen."
      state={
        brand.appIcon192
          ? "Custom icon"
          : "Not set: the tab shows your logo, and phones show the built-in Stage Utility icon."
      }
      onOpen={onOpen}
      onFile={onFile}
    >
      <div className="absolute left-4 right-4 top-[22px] flex h-[34px] items-end rounded-t-[9px] bg-[#202020] px-2">
        <div className="flex h-7 w-[170px] items-center gap-[7px] rounded-t-[7px] bg-[#2e2e2e] px-2.5 text-[11.5px] text-[#ededf0]">
          <span className="flex size-3.5 flex-none items-center justify-center">
            <TabIcon brand={brand} size={14} scheme="dark" />
          </span>
          <span className="truncate">{brand.appName}</span>
        </div>
      </div>
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-start gap-4">
        <div className="flex flex-col items-center gap-[5px] text-[10px] text-[#ededf0]">
          <IosIcon brand={brand} size={52} />
          iPhone
        </div>
        <div className="flex flex-col items-center gap-[5px] text-[10px] text-[#ededf0]">
          <AndroidIcon brand={brand} size={52} />
          Android
        </div>
      </div>
    </AssetCard>
  );
}

export function EmptySlotCard({ image, onOpen, onFile }: { image: string | null; onOpen: () => void; onFile: (file: File) => void }) {
  const size = useImageSize(image);
  return (
    <AssetCard
      title="Empty slot image"
      description="Centered in empty mic slots on the kiosk, recolored to the display's gray."
      state={image ? setLine(size) : "Not set"}
      onOpen={onOpen}
      onFile={onFile}
    >
      <div className="grid h-[118px] w-[150px] place-items-center rounded-lg border border-white/10 bg-white/[.03]">
        {image ? (
          <BrandLogo logo={image} monochrome className="size-[70px]" style={{ color: "rgba(255,255,255,.22)" }} />
        ) : (
          <ImageIcon className="size-8 text-white/20" aria-hidden="true" />
        )}
      </div>
    </AssetCard>
  );
}

export function AvatarCard({ image, onOpen, onFile }: { image: string | null; onOpen: () => void; onFile: (file: File) => void }) {
  const size = useImageSize(image);
  return (
    <AssetCard
      title="Default avatar"
      description="For scheduled people with no Planning Center photo, in place of their initials."
      state={image ? setLine(size) : "Not set · built-in silhouette"}
      onOpen={onOpen}
      onFile={onFile}
    >
      <div className="flex gap-3">
        <div className="grid h-[104px] w-[84px] place-items-center rounded-lg border border-white/10 text-white/35">
          {image ? (
            <BrandLogo logo={image} monochrome className="size-10" style={{ color: "rgba(255,255,255,.35)" }} />
          ) : (
            <UserRoundIcon className="size-10" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col justify-center gap-0.5 text-[12px] text-[#ededf0]">
          <b className="text-[13px]">Sam Rivera</b>
          <span className="text-white/50">Vocals</span>
        </div>
      </div>
    </AssetCard>
  );
}

// ── Connect QR ────────────────────────────────────────────────────────────────

/** Moved here when the Connect tab went. It is not a "connect" setting: it decides
 *  whether a QR and the LAN URL appear in the top bar of every stage display, which
 *  is a decision about how the displays LOOK, and that is this page. Kept rather
 *  than deleted with the rest of that tab: four view renderers read it. */
export function QrCard({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={cn(CARD, "flex items-center justify-between gap-4 px-4 py-3.5")}>
      <div className="flex min-w-0 flex-col">
        <FieldLabel>Show connect QR on displays</FieldLabel>
        <Describe>
          Puts a QR code and this server&apos;s address in the top bar of every stage display, so anyone on the
          network can scan it and open the app.
        </Describe>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label="Show connect QR on displays" />
    </div>
  );
}
