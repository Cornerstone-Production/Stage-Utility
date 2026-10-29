// The inspector's controls for a Mic slots widget: which board it shows, a way to
// make one, and a link to the page where boards are edited.
//
// A widget used to carry its own slots (or embed a screen's); it now points at a
// board, the same set of layouts a slots screen can show, so the slots are edited
// in one place for every screen and widget.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AppLink } from "../app/app-link";
import { useRouterHandle } from "../lib/use-search-param";
import { Button, Input, toast } from "../components/ui";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { gridBoardId } from "@main/services/slot-boards";
import { Row, RowNumber, RowSelect } from "./inspector-rows";

type GridConfig = Extract<LayoutObjectConfig, { type: "slots-grid" }>;

const NONE = "__none__";
const NEW = "__new__";

/** The config as a board-pointing widget stores it: the legacy fields dropped, and
 *  the display width they may have carried kept. */
export function pointedAt(c: GridConfig, boardId: string | null): GridConfig {
  const { source: _s, sourceViewId: _v, slotsLayout, ...rest } = c;
  const displayWidthIn = c.displayWidthIn ?? slotsLayout?.displayWidthIn ?? null;
  return { ...rest, boardId, ...(displayWidthIn ? { displayWidthIn } : {}) };
}

export function SlotsGridBoard({
  objectId,
  config,
  onConfig,
}: {
  objectId: string;
  config: GridConfig;
  onConfig: (c: LayoutObjectConfig) => void;
}) {
  const qc = useQueryClient();
  // The link is a router link wherever there is a router; a page rendered alone (a
  // test, a preview) gets the same address as a plain anchor.
  const router = useRouterHandle();
  const { data: boards = [], error } = useQuery({ queryKey: ["boards:list"], queryFn: () => invoke<SlotBoardDTO[]>("boards:list") });
  const current = gridBoardId(config, objectId);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const made = await invoke<{ id: string; boards: SlotBoardDTO[] }>("boards:create", { name: trimmed });
      qc.setQueryData(["boards:list"], made.boards);
      onConfig(pointedAt(config, made.id));
      setNaming(false);
      setName("");
    } catch (err) {
      toast.error(`Couldn't create the board: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RowSelect
        label="Board"
        hint="The set of slots this widget shows. Screens and other widgets can show the same board."
        value={naming ? NEW : (current ?? NONE)}
        options={[
          { value: NONE, label: "None" },
          ...boards.map((b) => ({ value: b.id, label: b.name })),
          // A widget whose board is not in the list (deleted elsewhere) still reads as it is.
          ...(current && !boards.some((b) => b.id === current) ? [{ value: current, label: "Unknown board" }] : []),
          { value: NEW, label: "New board…" },
        ]}
        onChange={(v) => {
          if (v === NEW) setNaming(true);
          else {
            setNaming(false);
            onConfig(pointedAt(config, v === NONE ? null : v));
          }
        }}
      />
      {error != null && <p className="text-caption2 text-danger-11">Couldn't load the boards: {errorMessage(error)}.</p>}
      {naming && (
        <Row label="Name">
          <div className="flex items-center gap-1.5">
            <Input
              value={name}
              autoFocus
              aria-label="New board name"
              placeholder="Pastors widget"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
            <Button variant="accent" size="small" disabled={!name.trim() || busy} onClick={() => void create()}>
              Create
            </Button>
          </div>
        </Row>
      )}
      <RowNumber
        label="Display width"
        hint="This widget's active width in inches, for a board aligned to chargers. Blank leaves it unaligned."
        value={config.displayWidthIn ?? config.slotsLayout?.displayWidthIn ?? null}
        step={0.25}
        min={1}
        suffix="in"
        placeholder="Not set"
        onChange={(n) => onConfig({ ...pointedAt(config, current), displayWidthIn: n })}
        onUnset={() => onConfig({ ...pointedAt(config, current), displayWidthIn: null })}
      />
      {current && (
        router ? (
          <AppLink to="/mic-slots" search={{ board: current } as never} className="text-caption1 text-accent hover:underline">
            Edit in Mic slots
          </AppLink>
        ) : (
          <a href={`/mic-slots?board=${encodeURIComponent(current)}`} className="text-caption1 text-accent hover:underline">
            Edit in Mic slots
          </a>
        )
      )}
    </>
  );
}
