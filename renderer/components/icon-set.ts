// icon-set.ts — the icons an operator can put on a screen or a console.
//
// Lucide ships 6092 icons. Offering all of them would mean bundling the whole
// set or lazy-loading an index, both of which cost real bytes on a Pi over
// wifi, and would put a grid in front of the operator that nobody can scan
// without typing. This is a curated set, chosen for what actually goes on a
// wall in a production booth: screens, consoles, cameras, audio, lighting,
// people, time, and a handful of plain shapes for when none of that fits.
//
// Every icon here is already imported somewhere in the app or is a sibling of
// one, so the set costs nothing to ship.
//
// NAMES ARE THE STORED VALUE and are therefore an API. Renaming an entry
// silently reverts every icon an operator chose under the old name, so add
// freely and rename never. `resolveIcon` falls back rather than blanking, so a
// name this build does not know draws the item's built-in icon instead of a
// hole.
//
// `keywords` exist because the lucide name is often not the word an operator
// would reach for — nobody searches "Presentation" looking for a projector.

import {
  ActivityIcon, AirplayIcon, AlarmClockIcon, AnchorIcon, AudioLinesIcon, AudioWaveformIcon,
  BellIcon, BookOpenIcon, BoxIcon, CalendarIcon, CameraIcon, CastIcon, CheckIcon,
  CircleIcon, ClapperboardIcon, ClockIcon, CloudIcon, CompassIcon, CpuIcon, CrownIcon,
  DiscIcon, DoorOpenIcon, DropletIcon, FilmIcon, FlagIcon, FlameIcon, FolderIcon,
  GaugeIcon, GuitarIcon, HandIcon, HeadphonesIcon, HeartIcon, HomeIcon, ImageIcon,
  InfoIcon, KeyboardIcon, LayersIcon, LayoutGridIcon, LightbulbIcon, ListIcon,
  MapPinIcon, MegaphoneIcon, MicIcon, MicOffIcon, MonitorIcon, MonitorSpeakerIcon,
  MoonIcon, MusicIcon, PaletteIcon, PianoIcon, PlayIcon, PowerIcon, PresentationIcon,
  ProjectorIcon, RadioIcon, RadioTowerIcon, RocketIcon, RssIcon, ScreenShareIcon,
  SettingsIcon, ShieldIcon, SlidersHorizontalIcon, SlidersVerticalIcon, SmartphoneIcon,
  SpeakerIcon, SparklesIcon, SquareIcon, StarIcon, SunIcon, TabletIcon, TargetIcon,
  TimerIcon, TvIcon, UsersIcon, VideoIcon, VolumeIcon, WifiIcon, ZapIcon,
  type LucideIcon,
} from "lucide-react";

export interface IconChoice {
  /** The stored name. An API — add, never rename. */
  name: string;
  icon: LucideIcon;
  /** Words an operator might actually type, beyond the name itself. */
  keywords: string;
}

export const ICON_SET: IconChoice[] = [
  // Screens and surfaces
  { name: "Monitor", icon: MonitorIcon, keywords: "screen display wall tv" },
  { name: "Tv", icon: TvIcon, keywords: "screen display television" },
  { name: "Projector", icon: ProjectorIcon, keywords: "beamer screen imag" },
  { name: "Presentation", icon: PresentationIcon, keywords: "projector slides screen" },
  { name: "ScreenShare", icon: ScreenShareIcon, keywords: "share cast output" },
  { name: "Cast", icon: CastIcon, keywords: "stream airplay send" },
  { name: "Airplay", icon: AirplayIcon, keywords: "cast stream send" },
  { name: "Smartphone", icon: SmartphoneIcon, keywords: "phone mobile handheld" },
  { name: "Tablet", icon: TabletIcon, keywords: "ipad touch panel" },
  { name: "LayoutGrid", icon: LayoutGridIcon, keywords: "grid tiles dashboard" },
  { name: "Layers", icon: LayersIcon, keywords: "stack overlay" },

  // Consoles and control
  { name: "SlidersHorizontal", icon: SlidersHorizontalIcon, keywords: "console desk mixer faders control" },
  { name: "SlidersVertical", icon: SlidersVerticalIcon, keywords: "console desk mixer faders control" },
  { name: "Keyboard", icon: KeyboardIcon, keywords: "input typing console" },
  { name: "Gauge", icon: GaugeIcon, keywords: "meter level dial" },
  { name: "Hand", icon: HandIcon, keywords: "touch control surface manual" },
  { name: "Power", icon: PowerIcon, keywords: "on off standby" },
  { name: "Settings", icon: SettingsIcon, keywords: "gear config options" },
  { name: "Cpu", icon: CpuIcon, keywords: "machine computer server" },

  // Audio
  { name: "Mic", icon: MicIcon, keywords: "microphone vocal wireless" },
  { name: "MicOff", icon: MicOffIcon, keywords: "muted microphone" },
  { name: "Headphones", icon: HeadphonesIcon, keywords: "iem monitor cans" },
  { name: "Speaker", icon: SpeakerIcon, keywords: "monitor wedge pa" },
  { name: "MonitorSpeaker", icon: MonitorSpeakerIcon, keywords: "wedge foldback stage" },
  { name: "Volume", icon: VolumeIcon, keywords: "level audio sound" },
  { name: "AudioLines", icon: AudioLinesIcon, keywords: "waveform sound signal" },
  { name: "AudioWaveform", icon: AudioWaveformIcon, keywords: "waveform sound signal" },
  { name: "Music", icon: MusicIcon, keywords: "song worship band" },
  { name: "Guitar", icon: GuitarIcon, keywords: "band instrument acoustic electric" },
  { name: "Piano", icon: PianoIcon, keywords: "keys band instrument" },
  { name: "Disc", icon: DiscIcon, keywords: "track playback record" },

  // Video and broadcast
  { name: "Camera", icon: CameraIcon, keywords: "cam photo shot" },
  { name: "Video", icon: VideoIcon, keywords: "camera cam recording" },
  { name: "Film", icon: FilmIcon, keywords: "video clip roll" },
  { name: "Clapperboard", icon: ClapperboardIcon, keywords: "video take scene" },
  { name: "Radio", icon: RadioIcon, keywords: "rf wireless comms" },
  { name: "RadioTower", icon: RadioTowerIcon, keywords: "broadcast stream transmit live" },
  { name: "Rss", icon: RssIcon, keywords: "feed stream broadcast" },
  { name: "Wifi", icon: WifiIcon, keywords: "network wireless signal" },
  { name: "Activity", icon: ActivityIcon, keywords: "signal live pulse" },

  // Lighting and stage
  { name: "Lightbulb", icon: LightbulbIcon, keywords: "light lx lighting" },
  { name: "Zap", icon: ZapIcon, keywords: "power cue trigger fast" },
  { name: "Sparkles", icon: SparklesIcon, keywords: "haze effect atmosphere" },
  { name: "Flame", icon: FlameIcon, keywords: "pyro effect heat" },
  { name: "Sun", icon: SunIcon, keywords: "bright day house lights" },
  { name: "Moon", icon: MoonIcon, keywords: "dark night blackout" },
  { name: "Palette", icon: PaletteIcon, keywords: "colour colors theme" },
  { name: "Image", icon: ImageIcon, keywords: "picture graphic still" },

  // People and service
  { name: "Users", icon: UsersIcon, keywords: "team people band crew" },
  { name: "Megaphone", icon: MegaphoneIcon, keywords: "announce speaker preach" },
  { name: "BookOpen", icon: BookOpenIcon, keywords: "scripture sermon notes script" },
  { name: "Droplet", icon: DropletIcon, keywords: "baptism water" },
  { name: "Heart", icon: HeartIcon, keywords: "care welcome love" },
  { name: "Crown", icon: CrownIcon, keywords: "lead main primary" },
  { name: "Shield", icon: ShieldIcon, keywords: "security safety guard" },
  { name: "DoorOpen", icon: DoorOpenIcon, keywords: "doors entry lobby foyer" },
  { name: "Home", icon: HomeIcon, keywords: "front main start" },

  // Time and order
  { name: "Clock", icon: ClockIcon, keywords: "time now clock" },
  { name: "AlarmClock", icon: AlarmClockIcon, keywords: "countdown alert time" },
  { name: "Timer", icon: TimerIcon, keywords: "countdown stopwatch elapsed" },
  { name: "Calendar", icon: CalendarIcon, keywords: "plan schedule service date" },
  { name: "List", icon: ListIcon, keywords: "order rundown items" },
  { name: "Play", icon: PlayIcon, keywords: "start go run" },
  { name: "Flag", icon: FlagIcon, keywords: "marker cue point" },
  { name: "Target", icon: TargetIcon, keywords: "aim focus goal" },
  { name: "Rocket", icon: RocketIcon, keywords: "launch go start" },

  // Plain marks, for when nothing above fits
  { name: "Circle", icon: CircleIcon, keywords: "dot plain simple" },
  { name: "Square", icon: SquareIcon, keywords: "box plain simple" },
  { name: "Star", icon: StarIcon, keywords: "favourite important" },
  { name: "Check", icon: CheckIcon, keywords: "done ready ok" },
  { name: "Info", icon: InfoIcon, keywords: "notes about detail" },
  { name: "Bell", icon: BellIcon, keywords: "alert notify" },
  { name: "MapPin", icon: MapPinIcon, keywords: "location where room" },
  { name: "Compass", icon: CompassIcon, keywords: "direction find" },
  { name: "Anchor", icon: AnchorIcon, keywords: "fixed pinned" },
  { name: "Box", icon: BoxIcon, keywords: "package thing" },
  { name: "Folder", icon: FolderIcon, keywords: "group collection" },
  { name: "Cloud", icon: CloudIcon, keywords: "remote online" },
];

const BY_NAME = new Map(ICON_SET.map((c) => [c.name, c.icon]));

/**
 * The icon for a stored name, or null when there is no usable choice.
 *
 * Null rather than a placeholder, so the caller draws the item's OWN built-in
 * icon. A name from a set this build does not have — an older release, or an
 * entry removed later — must not leave a hole where the operator's icon was.
 */
export function resolveIcon(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return BY_NAME.get(name) ?? null;
}

/** The set, filtered by a query against both the name and its keywords. */
export function searchIcons(query: string): IconChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return ICON_SET;
  return ICON_SET.filter((c) => `${c.name} ${c.keywords}`.toLowerCase().includes(q));
}
