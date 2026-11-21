// The OpenAI card on Integrations: the API key Theme photos edits mic slot photos with.
//
// Not an integration tile. OpenAI has no config, no enable switch and nothing to
// automate; it is one secret and how it stands (see main/services/photo-themes/
// openai-connection.ts). So it is a card of its own under the grid.
//
// THE KEY NEVER LIVES IN REACT STATE. The field is uncontrolled and read from a
// ref at the moment Save is pressed; state holds only whether it has text, so Save
// can enable. The server answers with a hint (`sk-…3f2a`) and never the key, and
// that hint is all this card ever holds. A saved key clears the field.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import type { OpenAiConnectionDTO } from "@main/types/photo-themes";

import { Button, ErrorNote, Input } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { cn } from "../../lib/cn";
import { STATES, type Tone } from "../../app/mic-slots/photo-themes/openai-wording";
import { OPENAI_KEY, PHOTO_THEMES_KEY } from "../../app/mic-slots/photo-themes/use-photo-themes";

const CHIP: Record<Tone, string> = {
  ok: "bg-ok-9/15 text-ok-11",
  warn: "bg-warn-9/15 text-warn-11",
  bad: "bg-danger-9/15 text-danger-11",
  off: "bg-fill text-fg-muted",
};
const DOT: Record<Tone, string> = { ok: "bg-ok-9", warn: "bg-warn-11", bad: "bg-danger-9", off: "bg-fg-subtle" };
const TITLE: Record<Tone, string> = { ok: "text-ok-11", warn: "text-warn-11", bad: "text-danger-11", off: "text-fg" };

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

export function OpenAiCard() {
  const qc = useQueryClient();
  const keyId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [result, setResult] = useState<{ tone: Tone; text: string } | null>(null);

  const { data: conn, error } = useQuery({ queryKey: OPENAI_KEY, queryFn: () => ipc<OpenAiConnectionDTO>("openai:getStatus") });

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
    <section aria-label="OpenAI" data-openai-card className="su-card mt-3 flex max-w-3xl flex-col rounded-[0.875rem]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1 pt-3.5">
        <h2 className="min-w-0 flex-1 text-callout font-semibold text-fg">OpenAI</h2>
        <span data-openai-state={conn.state} className={cn("rounded-full px-2 py-px text-caption1 font-medium", CHIP[view.tone])}>
          {view.title}
        </span>
      </div>
      <p className="px-4 pb-2.5 text-footnote text-fg-muted">Edits mic slot photos for Theme photos on Mic slots. Nothing else uses it.</p>
      <div className="flex flex-col gap-2 border-t border-line px-4 py-3.5">
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
          On a ChatGPT Business plan, the plan's included API credits pay for edits; after that, normal API billing applies.
        </p>
      </div>
      <div role="status" className="flex items-start gap-2 border-t border-line px-4 py-3 text-footnote">
        <i aria-hidden className={cn("mt-[5px] size-2 shrink-0 rounded-full", DOT[view.tone])} />
        <span>
          <b className={cn("font-semibold", TITLE[view.tone])}>{view.title}.</b> <span className="text-fg">{detail}</span>
        </span>
      </div>
    </section>
  );
}
