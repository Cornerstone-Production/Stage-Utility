// stageplots.ts — venues, their stage plots, and the backgrounds plots draw on.
//
// One config store (stageplots.json) holds all three lists. A plot's
// coordinates are plot units: the canvas is 1000 units wide and its height
// follows its background's aspect ratio (16:9 when it has none), so items keep
// their place on the drawing when the background changes or is re-converted.
// See docs/features/stageplots.md.

export type VenueKind = "home" | "offsite";

export interface Venue {
  id: string;
  name: string;
  /** Only groups the list: home venues first. */
  kind: VenueKind;
  notes: string;
  /** This venue's plots, in tab order. Every id names a plot whose venueId is this venue. */
  plotIds: string[];
  /** One of plotIds, or null only while the venue has no plots. */
  defaultPlotId: string | null;
}

export type BackgroundOriginalMime = "image/png" | "image/jpeg" | "application/pdf";
export type BackgroundSourceExt = "png" | "jpg";

/**
 * An uploaded drawing, converted once. Hashes are the content names the image
 * store gives a file: the first 16 hex of its SHA-256.
 */
export interface Background {
  id: string;
  name: string;
  /** What was uploaded. A PNG or JPEG is its own source; a PDF is kept beside
   *  the images and never served. */
  original: { hash: string; mime: BackgroundOriginalMime; bytes: number };
  /** The raster the conversion reads: the upload itself, or the page the
   *  browser rendered from a PDF. Kept so clean-up can be toggled later. */
  source: { hash: string; ext: BackgroundSourceExt };
  /** The WebP every plot draws. */
  converted: { hash: string; width: number; height: number; bytes: number };
  cleanup: boolean;
  /** The PDF page the source was rendered from, 1-based, and how many the PDF has. */
  pdfPage: number | null;
  pdfPages: number | null;
}

/** A background as the API serves it: with the URLs of its converted image
 *  and of the source raster it was converted from (the editor's Before). */
export interface BackgroundView extends Background {
  url: string;
  sourceUrl: string;
}

/** Every kind of item a plot can carry. */
export const ITEM_TYPES = ["box", "circle", "zone", "cable", "conn", "symbol", "text"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The nine symbols, sorted. Their drawings are renderer/main/stageplots/symbols.ts. */
export const SYMBOL_KINDS = ["amp", "camera", "console", "drumkit", "keyboard", "micstand", "piano", "speaker", "wedge"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const TEXT_KINDS = ["label", "callout", "dimension"] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** One point of a cable, in plot units. */
export type CablePoint = [number, number];

/**
 * One drawn item, in plot units. x and y are the top-left of the unrotated box
 * and rotation turns it about its centre, in degrees within (-180, 180]. A
 * cable is its points; its x, y, w and h are their bounding box and it does
 * not rotate. `color` is one of PATCH_COLORS, or null for the plot's ink.
 */
export interface PlotItem {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  label: string;
  color: string | null;
  notes: string;
  /** What plugs in here, in order: input names. */
  inputs: string[];
  /** Only on a symbol. */
  symbol?: SymbolKind;
  /** Only on text. */
  textKind?: TextKind;
  /** Only on a cable: 2 to 50 points. */
  points?: CablePoint[];
  /** Only on a cable. */
  dashed?: boolean;
}

export interface Plot {
  id: string;
  venueId: string;
  name: string;
  backgroundId: string | null;
  /** How far the background is faded toward the paper, 0 to 1. */
  bgFade: number;
  items: PlotItem[];
  /** Bumped by every change to the plot. */
  version: number;
}

export interface StagePlotsDoc {
  venues: Venue[];
  backgrounds: Background[];
  plots: Plot[];
}

/** GET /api/stageplots, and every stageplots:updated frame. */
export interface StagePlotsView {
  venues: Venue[];
  backgrounds: BackgroundView[];
  plots: Plot[];
}

export const STAGEPLOT_LIMITS = {
  /** The largest PNG or JPEG upload, and the largest page raster. */
  imageBytes: 12 * 1024 * 1024,
  /** The largest PDF upload. */
  pdfBytes: 25 * 1024 * 1024,
  venues: 50,
  plotsPerVenue: 20,
  backgrounds: 50,
  nameChars: 60,
  notesChars: 500,
  itemsPerPlot: 500,
  inputsPerItem: 64,
  labelChars: 60,
  inputChars: 40,
  cablePointsMin: 2,
  cablePointsMax: 50,
  /** An item's smallest and largest width and height, in plot units. */
  itemMinSize: 8,
  itemMaxSize: 1000,
} as const;

/** The plot canvas is this many units wide. */
export const PLOT_UNITS_WIDE = 1000;

/** Broadcast with the whole StagePlotsView after every change. Not hydrated:
 *  a page reads GET /api/stageplots on mount, like patch:updated. */
export const STAGEPLOTS_CHANNEL = "stageplots:updated";
