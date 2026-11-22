// OpenAI on Integrations: a tile in the grid, and the dialog that holds the API key
// Theme photos edits mic slot photos with.
//
// Not a server integration. OpenAI has no config, no enable switch and nothing to
// automate; it is one secret and how it stands (see main/services/photo-themes/
// openai-connection.ts). So the panel draws its tile beside the described ones,
// from the same markup, and this file supplies what is specific to it: where the
// tile sorts, what it says, and the key form in its dialog.
//
// THE KEY NEVER LIVES IN REACT STATE. The field is uncontrolled and read from a
// ref at the moment Save is pressed; state holds only whether it has text, so Save
// can enable. The server answers with a hint (`sk-…3f2a`) and never the key, and
// that hint is all this file ever holds. A saved key clears the field.

import { useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "@main/services/errors";
import type { OpenAiConnectionDTO } from "@main/types/photo-themes";

import {
  Button,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  ErrorNote,
  Input,
} from "../../components/ui";
import { TONE_FACE } from "../../components/connection-badge";
import { integrationDialogClass } from "../../components/integration-dialog-size";
import { invoke as ipc } from "../../lib/api";
import { cn } from "../../lib/cn";
import { STATES, type Tone } from "../../app/mic-slots/photo-themes/openai-wording";
import { OPENAI_KEY, PHOTO_THEMES_KEY, useOpenAiConnection } from "../../app/mic-slots/photo-themes/use-photo-themes";

const DOT: Record<Tone, string> = { ok: "bg-ok-9", warn: "bg-warn-11", bad: "bg-danger-9", off: "bg-fg-subtle" };
const LINK = "text-accent underline underline-offset-2 hover:text-accent-hover";
const TITLE: Record<Tone, string> = { ok: "text-ok-11", warn: "text-warn-11", bad: "text-danger-11", off: "text-fg" };

/** The id the tile and `?integration=` use. Not one of the server's integration ids. */
export const OPENAI_TILE_ID = "openai";

/** What the tile and the dialog header say OpenAI is for. */
export const OPENAI_DESCRIPTION = "Edits mic slot photos for Theme photos on Mic slots.";

/** One state, dressed the way ConnectionBadge dresses its own: the tile's footer and the
 *  dialog's header. */
function OpenAiStatus({ tone, title, state }: { tone: Tone; title: string; state?: string }) {
  const face = TONE_FACE[tone];
  return (
    <span data-openai-state={state} className="flex min-w-0 items-center gap-1" aria-label={title}>
      {face.icon}
      <span className={cn("truncate text-caption1", face.tone)}>{title}</span>
    </span>
  );
}

/** What the panel needs to draw OpenAI's tile. */
export interface OpenAiTile {
  /** Which half it sorts into. */
  inUse: boolean;
  /** Whether the header's "N of M connected" counts it. */
  connected: boolean;
  summary: string;
  footer: ReactNode;
}

const NOT_SET_UP = <span className="text-caption1 text-fg-muted">Not set up</span>;

/**
 * Where the tile sorts and what it says, from the connection query.
 *
 * In use once a key is saved, and whenever the connection is in trouble, for the
 * reason the other tiles stay up on an error: a rejected key is what an operator
 * wants to see. A status that cannot be read is trouble too. While it loads the tile
 * is under Not set up, so it is on screen and opens its dialog from the first paint.
 * `connected` is the one state the header counts.
 */
export function openAiTile({ data: conn, isError }: { data: OpenAiConnectionDTO | undefined; isError: boolean }): OpenAiTile {
  if (isError) {
    return { inUse: true, connected: false, summary: OPENAI_DESCRIPTION, footer: <OpenAiStatus tone="warn" title="Can't read status" /> };
  }
  if (!conn) return { inUse: false, connected: false, summary: OPENAI_DESCRIPTION, footer: NOT_SET_UP };
  const { tone, title } = STATES[conn.state];
  const inUse = conn.hint !== null || tone === "warn" || tone === "bad";
  return {
    inUse,
    connected: conn.state === "connected",
    summary: conn.hint ?? OPENAI_DESCRIPTION,
    footer: inUse ? <OpenAiStatus tone={tone} title={title} state={conn.state} /> : NOT_SET_UP,
  };
}

/** What a Test answered, in a line under the buttons. */
function testLine(c: OpenAiConnectionDTO): { tone: Tone; text: string } {
  switch (c.state) {
    case "connected":
      return { tone: "ok", text: "Key works." };
    case "out-of-credits":
      return { tone: "bad", text: "Key works, but the credits are used up." };
    case "invalid-key":
      return { tone: "bad", text: "OpenAI rejected this key." };
    case "not-connected":
      return { tone: "off", text: "There is no key to test." };
    case "unchecked":
    case "forbidden":
    case "unreachable":
      return { tone: "bad", text: c.reason ?? STATES[c.state].detail };
  }
}

/** The key form: the body of the OpenAI dialog. */
export function OpenAiKeyForm() {
  const qc = useQueryClient();
  const keyId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [result, setResult] = useState<{ tone: Tone; text: string } | null>(null);

  const { data: conn, error } = useOpenAiConnection();

  function took(next: OpenAiConnectionDTO) {
    qc.setQueryData(OPENAI_KEY, next);
    // The Mic slots page reads the same connection with the themes.
    void qc.invalidateQueries({ queryKey: PHOTO_THEMES_KEY });
  }

  async function run(kind: "save" | "test" | "remove", send: () => Promise<OpenAiConnectionDTO>, then: (c: OpenAiConnectionDTO) => void) {
    setBusy(kind);
    setResult(null);
    try {
      const next = await send();
      took(next);
      then(next);
    } catch (err) {
      // A refusal leaves the field as typed and says why; nothing reads as saved.
      setResult({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  const saveKey = () => {
    const apiKey = input.current?.value ?? "";
    if (!apiKey.trim()) return;
    void run(
      "save",
      () => ipc<OpenAiConnectionDTO>("openai:saveKey", { apiKey }),
      () => {
        if (input.current) input.current.value = "";
        setHasText(false);
        setResult({ tone: "ok", text: "Key saved." });
      },
    );
  };
  const testKey = () =>
    void run(
      "test",
      () => ipc<OpenAiConnectionDTO>("openai:testKey"),
      (c) => setResult(testLine(c)),
    );
  const removeKey = () =>
    void run(
      "remove",
      () => ipc<OpenAiConnectionDTO>("openai:clearKey"),
      () => setResult({ tone: "off", text: "Key removed." }),
    );

  if (error) return <ErrorNote>Couldn't read OpenAI's status: {errorMessage(error)}.</ErrorNote>;
  if (!conn) return null;
  const view = STATES[conn.state];
  const keySaved = conn.hint !== null;
  const detail = conn.reason ?? view.detail;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <label htmlFor={keyId} className="flex items-center gap-1.5 text-footnote font-semibold text-fg">
            <KeyRoundIcon className="size-4 text-fg-muted" aria-hidden />
            API key
          </label>
          <span className={cn("text-caption1", keySaved && view.tone === "ok" ? "text-ok-11" : keySaved && view.tone === "bad" ? "text-danger-11" : "text-fg-muted")}>
            {keySaved ? view.title : "Not saved"}
          </span>
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveKey();
          }}
        >
          {/* Uncontrolled, and never autofilled: this is a secret. */}
          <Input
            ref={input}
            id={keyId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-48 flex-[1_1_12rem] font-mono"
            placeholder={conn.hint ? `${conn.hint} (saved)` : "sk-…"}
            onChange={(e) => setHasText(e.target.value.length > 0)}
          />
          <Button type="submit" variant="filled" size="medium" disabled={!hasText || busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="filled" size="medium" disabled={!keySaved || busy !== null} onClick={testKey}>
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          {keySaved && (
            <Button type="button" variant="transparent" size="medium" disabled={busy !== null} onClick={removeKey}>
              Remove key
            </Button>
          )}
        </form>
        {result && (
          <p role="status" className={cn("text-caption1", result.tone === "ok" ? "text-ok-11" : result.tone === "bad" ? "text-danger-11" : "text-fg-muted")}>
            {result.text}
          </p>
        )}
        <p className="text-caption1 text-fg-muted">
          Uses your ChatGPT Business plan's included API credits: link an{" "}
          <a href="https://developers.openai.com/api/docs/guides/chatgpt-api-credits" target="_blank" rel="noopener noreferrer" className={LINK}>
            API organization
          </a>{" "}
          to the workspace, then create a{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className={LINK}>
            project key
          </a>{" "}
          there.
        </p>
      </div>
      <div role="status" data-openai-state={conn.state} className="flex items-start gap-2 border-t border-line pt-3 text-footnote">
        <i aria-hidden className={cn("mt-[5px] size-2 shrink-0 rounded-full", DOT[view.tone])} />
        <span>
          <b className={cn("font-semibold", TITLE[view.tone])}>{view.title}.</b> <span className="text-fg">{detail}</span>
        </span>
      </div>
    </div>
  );
}

/** OpenAI's dialog, in the shell the integrations use: same width, header and body padding. */
export function OpenAiDialog({ onClose }: { onClose: () => void }) {
  const { data: conn } = useOpenAiConnection();
  return (
    <DialogRoot open onOpenChange={(next: boolean) => !next && onClose()}>
      <DialogContent
        className={integrationDialogClass(OPENAI_TILE_ID)}
        // Focus goes back to the tile by id from the panel, as for every integration.
        onCloseAutoFocus={(e: Event) => e.preventDefault()}
      >
        <DialogHeader className="mb-0 flex-row items-start gap-3 border-b border-line px-5 pb-3 pt-4">
          <div className="min-w-0">
            <DialogTitle>OpenAI</DialogTitle>
            <DialogDescription>{OPENAI_DESCRIPTION}</DialogDescription>
          </div>
          {/* Room for the X in the corner. */}
          <div className="ml-auto mr-6 flex shrink-0 items-center gap-3">
            {conn && <OpenAiStatus tone={STATES[conn.state].tone} title={STATES[conn.state].title} state={conn.state} />}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <OpenAiKeyForm />
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
