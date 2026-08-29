// scores-teams-panel.tsx — which teams the operator follows.
//
// Bespoke, and deliberately not built on a shared searchable-list primitive.
// This is the fifth hand-rolled search popover in the repo and the plan
// originally proposed extracting one; that was overruled, because extracting a
// primitive with a single consumer is speculative generality and migrating the
// existing four means touching slot matching and every icon field in a PR about
// sports scores.
//
// Popover, NOT select.tsx. That is not a style preference: select.tsx renders a
// native <select>, so the OS draws the open list and its own first-letter
// typeahead fights any text field placed inside it. position-picker.tsx records
// exactly this lesson in its own header and is the shape copied here.
//
// The WHOLE favourite is saved, not just the id — displayName, abbreviation,
// logo and colour are cached at selection time so the settings row renders
// before the first poll and no display ever reaches a.espncdn.com itself.

import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, Loader2Icon, TrashIcon, TriangleAlertIcon } from "lucide-react";

import { LEAGUES } from "@main/types/scores";
import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { toast } from "../../components/ui";
import { cn } from "../../lib/cn";

function ipc<T>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(channel, payload);
}

/** The identity of a favourite. League AND id: ESPN's ids are unique per league. */
const keyOf = (f: { league: string; teamId: string }): string => `${f.league}:${f.teamId}`;

/**
 * Teams matching the query, on display name OR abbreviation.
 *
 * The abbreviation matters as much as the name: an operator who thinks of the
 * team as "NYY" should not have to know it is filed under "New York Yankees".
 * Exported so the matching rule can be tested without driving a popover.
 */
export function filterTeams(teams: readonly ScoreFavourite[], query: string): ScoreFavourite[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...teams];
  return teams.filter(
    (t) => t.displayName.toLowerCase().includes(q) || t.abbreviation.toLowerCase().includes(q),
  );
}

interface TeamCatalogue {
  teams: ScoreFavourite[];
  /** One line per league that could not be loaded. Shown, never swallowed. */
  errors: string[];
}

/**
 * Every league's teams, loaded once.
 *
 * Promise.allSettled rather than Promise.all: one league being unreachable must
 * not blank the other three. A rejection becomes a line the operator can read,
 * naming the league — an empty dropdown and a failed request look identical
 * otherwise, and the operator would be left retyping a search that could never
 * match anything.
 */
async function loadCatalogue(): Promise<TeamCatalogue> {
  const results = await Promise.allSettled(
    LEAGUES.map((l) => ipc<ScoreFavourite[]>("scores:listTeams", { league: l.id })),
  );
  const teams: ScoreFavourite[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    const league = LEAGUES[i];
    if (r.status === "fulfilled") teams.push(...r.value);
    else errors.push(`${league.label} could not be loaded — ${errorMessage(r.reason)}`);
  });
  return { teams, errors };
}

const labelForLeague = (id: string): string => LEAGUES.find((l) => l.id === id)?.label ?? id;

/** A team's logo, or its abbreviation when the CDN is blocked or absent. */
function TeamMark({ team, size = 20 }: { team: { logo: string | null; abbreviation: string }; size?: number }) {
  if (!team.logo) {
    return (
      <span
        className="shrink-0 text-caption2 font-medium text-gray-11 tabular-nums"
        style={{ width: size, textAlign: "center" }}
      >
        {team.abbreviation}
      </span>
    );
  }
  // alt is the abbreviation, so a blocked CDN degrades to readable text rather
  // than a hole in the row.
  return (
    <img src={team.logo} alt={team.abbreviation} width={size} height={size} className="shrink-0 object-contain" />
  );
}

/**
 * The add-a-team popover.
 *
 * Exported for its test: the query must reset when the popover closes, or
 * re-opening shows a filtered list whose filter has scrolled out of view — the
 * operator sees four teams, believes that is every team, and cannot find the one
 * they came for.
 */
export function TeamPicker({
  catalogue,
  loading,
  selected,
  onToggle,
  onOpen,
}: {
  catalogue: TeamCatalogue;
  loading: boolean;
  selected: ReadonlySet<string>;
  onToggle: (team: ScoreFavourite) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const hits = filterTeams(catalogue.teams, query);
    const byLeague = new Map<string, ScoreFavourite[]>();
    for (const t of hits) byLeague.set(t.league, [...(byLeague.get(t.league) ?? []), t]);
    // LEAGUES order, not insertion order, so the groups do not reshuffle as the
    // query changes which league happens to match first.
    return LEAGUES.map((l) => [l.label, byLeague.get(l.id) ?? []] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [catalogue.teams, query]);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
        // Reset on CLOSE, not on open: clearing on open would wipe the field
        // under an operator who reopened deliberately to refine a search.
        if (!next) setQuery("");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 items-center justify-between gap-1 rounded-md border border-gray-a6 bg-gray-a2",
            "px-2.5 py-1 text-footnote text-gray-12",
            "focus:outline-none focus:border-blue-8 focus:ring-1 focus:ring-blue-8",
          )}
        >
          <span>Add a team</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-gray-9" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-80 overflow-hidden rounded-md border border-gray-a6 bg-gray-2 shadow-md",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="border-b border-gray-a4 p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teams…"
              aria-label="Search teams"
              className={cn(
                "h-7 w-full rounded border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-blue-8",
              )}
            />
          </div>

          {catalogue.errors.length > 0 && (
            <div className="border-b border-gray-a4 px-2.5 py-2">
              {catalogue.errors.map((e) => (
                <p key={e} className="flex items-start gap-1.5 text-caption1 text-amber-11">
                  <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
                  <span>{e}</span>
                </p>
              ))}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable>
            {loading && (
              <div className="flex items-center justify-center gap-2 px-2 py-4 text-caption1 text-gray-9">
                <Loader2Icon className="size-3.5 animate-spin" />
                <span>Loading teams…</span>
              </div>
            )}
            {!loading && groups.length === 0 && (
              <div className="px-2 py-4 text-center text-caption1 text-gray-9">
                {catalogue.teams.length === 0 ? "No teams available" : "No teams match"}
              </div>
            )}
            {groups.map(([label, items]) => (
              <div key={label}>
                <p className="px-2 pt-2 pb-1 text-caption2 font-medium uppercase tracking-wider text-gray-9">
                  {label}
                </p>
                {items.map((t) => {
                  const chosen = selected.has(keyOf(t));
                  return (
                    <button
                      key={keyOf(t)}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      onClick={() => onToggle(t)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-footnote text-gray-12",
                        "hover:bg-gray-a3",
                        chosen && "bg-gray-a3",
                      )}
                    >
                      <CheckIcon
                        className={cn("size-3.5 shrink-0", chosen ? "text-accent opacity-100" : "opacity-0")}
                      />
                      <TeamMark team={t} size={18} />
                      <span className="truncate">{t.displayName}</span>
                      {chosen && <span className="ml-auto shrink-0 text-caption2 text-gray-9">Following</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function ScoresTeamsPanel({ className }: { className?: string } = {}) {
  const queryClient = useQueryClient();
  const [catalogueWanted, setCatalogueWanted] = useState(false);

  const favouritesQuery = useQuery({
    queryKey: ["scores:getFavourites"],
    queryFn: () => ipc<ScoresConfig>("scores:getFavourites"),
    retry: 1,
  });

  // Only fetched once the picker is actually opened: four league requests to
  // render a settings page nobody is editing is the traffic this integration is
  // built to avoid.
  const catalogueQuery = useQuery({
    queryKey: ["scores:listTeams"],
    queryFn: loadCatalogue,
    enabled: catalogueWanted,
    staleTime: 86_400_000,
  });

  const favourites = favouritesQuery.data?.favourites ?? [];
  const selected = new Set(favourites.map(keyOf));
  const catalogue = catalogueQuery.data ?? { teams: [], errors: [] };

  async function save(next: ScoreFavourite[]): Promise<void> {
    // Optimistic, then reconciled with what the server says it stored.
    queryClient.setQueryData(["scores:getFavourites"], { favourites: next });
    try {
      const saved = await ipc<ScoresConfig>("scores:setFavourites", { favourites: next });
      queryClient.setQueryData(["scores:getFavourites"], saved);
    } catch (err) {
      // Put the truth back rather than leaving the row showing a team that was
      // never saved, and say so.
      void favouritesQuery.refetch();
      toast.error(`Could not save followed teams: ${errorMessage(err)}`);
    }
  }

  function toggle(team: ScoreFavourite): void {
    const key = keyOf(team);
    void save(
      selected.has(key) ? favourites.filter((f) => keyOf(f) !== key) : [...favourites, team],
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-body text-gray-12">Followed teams</span>
          <span className="text-caption1 text-gray-9">
            Their live scores appear in the context bar, on Home, and on any display with a Live
            scores object.
          </span>
        </div>
        <TeamPicker
          catalogue={catalogue}
          loading={catalogueQuery.isLoading}
          selected={selected}
          onToggle={toggle}
          onOpen={() => setCatalogueWanted(true)}
        />
      </div>

      {favouritesQuery.isError && (
        <p className="flex items-start gap-1.5 text-caption1 text-red-11">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span>Could not read the followed teams — {errorMessage(favouritesQuery.error)}</span>
        </p>
      )}

      {favourites.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-a5 px-3 py-4 text-center text-caption1 text-gray-9">
          No teams followed yet. Scores stay off until you add one.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {favourites.map((f) => (
            <li
              key={keyOf(f)}
              className="flex items-center gap-2.5 rounded-md border border-gray-a4 bg-gray-a2 px-2.5 py-1.5"
            >
              <TeamMark team={f} />
              <span className="truncate text-footnote text-gray-12">{f.displayName}</span>
              <span className="ml-auto shrink-0 text-caption2 uppercase tracking-wider text-gray-9">
                {labelForLeague(f.league)}
              </span>
              <button
                type="button"
                aria-label={`Stop following ${f.displayName}`}
                onClick={() => void save(favourites.filter((x) => keyOf(x) !== keyOf(f)))}
                className="shrink-0 rounded p-1 text-gray-9 hover:bg-gray-a3 hover:text-red-11"
              >
                <TrashIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
