// servicecue-deploy-section.tsx — "Keep the page up to date", inside the Public link card's
// "Cloudflare connection".
//
// The server can put its own copy of the public page on Cloudflare after each update. This is
// where it is given the account and a token, shown how that is going, and asked to do it now.
// There is no switch: a token turns updating on and clearing it turns it off, as the route does.
//
// Drawn from the approved mockup. The status line is where the mockup puts it, a coloured dot and
// its words, then the button, then a detail line. The mockup's five states are the card's own
// wording, in the same voice; the states it did not draw (no copy of the page, other build, not
// yet read) are written the same way from what the server reports.
//
// The status comes down with the card's own read of the publish settings, which the card polls:
// nothing here asks for it again, so "updating" becomes "current" without a reload.

import { errorMessage } from "@main/services/errors";
import { isValidTimeZone } from "@main/services/app-timezone";
import { FORM_MASK, isMask } from "@main/services/mask";
import { plural } from "@main/services/plural";
import { useState, type ReactNode } from "react";

import { Button, ErrorNote, Input, confirm } from "../../components/ui";
import { invoke, type ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/clock-format";
import type { DeployState, DeployStatus, PublishSettingsDTO } from "../../../main/types/servicecue-publish-status.js";

/** A label with its hint on the left and the input on the right, as the mockup lays it out. */
export function ConnectionField({ label, hint, id, children }: { label: string; hint?: string; id: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-2.5 max-[560px]:grid-cols-1">
      <label htmlFor={id} className="pt-1.5 text-footnote text-fg">
        {label}
        {hint && <span className="block text-caption2 text-fg-muted">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

type Tone = "ok" | "busy" | "warn" | "bad" | "quiet";

const TONE: Record<Tone, { text: string; dot: string }> = {
  ok: { text: "text-ok-11", dot: "bg-ok-9" },
  busy: { text: "text-accent", dot: "bg-accent" },
  warn: { text: "text-warn-11", dot: "bg-warn-9" },
  bad: { text: "text-danger-11", dot: "bg-danger-9" },
  quiet: { text: "text-fg-muted", dot: "bg-fg-subtle" },
};

/** How long from now, as the card's facts say it: "20 s", "6 min", "2 h". Rounded up: it is never "0 s" while it is still to come. */
export function inHowLong(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.ceil(m / 60)} h`;
}

/** A time in the app's zone, as the mockup writes it: "21 Oct, 8:14 AM". */
export function deployedAt(at: number, zone: string): string {
  const timeZone = isValidTimeZone(zone) ? zone : undefined;
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) }).format(at);
  return `${day}, ${formatClock(at, { timeZone })}`;
}

/** What Cloudflare said, without the stop it ended with, so it can sit inside a sentence of ours. */
function bare(text: string): string {
  return text.trim().replace(/[.!?]+$/, "");
}

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-caption2">{children}</code>;

export interface DeployLine {
  tone: Tone;
  text: ReactNode;
  detail: ReactNode;
}

/**
 * What the status line and its detail say, for a state. `elapsedMs` is how long ago the answer was
 * read, so a retry time the server stamped is counted from its own clock and not the browser's.
 */
export function deployLine(d: DeployStatus, zone: string, elapsedMs: number): DeployLine {
  const build = d.page?.build ?? d.bundle?.build ?? "unknown";
  const state: DeployState = d.state;
  switch (state) {
    case "off":
      return {
        tone: "quiet",
        text: (
          <>
            Not updating: with no API token, the page stays on the build it has until someone runs <Code>npm run servicecue:deploy</Code>{" "}
            from a computer.
          </>
        ),
        detail: null,
      };
    case "unchecked":
      return {
        tone: "quiet",
        text: "Updating is on. The page's build has not been read yet.",
        detail: "It is read once publishing reaches the page, and again every few minutes.",
      };
    case "current": {
      const version = d.page?.version ?? d.bundle?.version;
      return {
        tone: "ok",
        text: (
          <>
            Up to date: build {build}
            {version ? ` (${version})` : ""}
            {d.page?.at != null ? `, deployed ${deployedAt(d.page.at, zone)}` : ""}
          </>
        ),
        detail: null,
      };
    }
    case "updating":
      return {
        tone: "busy",
        text: d.files ? `Updating the page… ${plural(d.files.uploaded, "file")} to upload, ${d.files.held} already on Cloudflare` : "Updating the page…",
        detail: null,
      };
    case "waiting":
      // The status says which: a live service is waited out, and a live state not yet known is waited on its own account.
      return d.waitingFor === "unknown"
        ? {
            tone: "warn",
            text: "Waiting to hear whether a service is live, then updating",
            detail:
              "This server has just started, or Planning Center cannot be reached. Update the page now goes ahead when the state is merely unknown, never through a live service.",
          }
        : {
            tone: "warn",
            text: `Waiting for the service to end, then updating${d.bundle ? ` to build ${d.bundle.build} (${d.bundle.version})` : ""}`,
            detail: "A service is live in Planning Center, so the page is left alone until it ends.",
          };
    case "failed": {
      const e = d.error;
      if (!e) return { tone: "bad", text: "Couldn't update the page. The page is unchanged.", detail: null };
      const reason = e.refused ? "Cloudflare refused the API token" : `${bare(e.message)} (${e.step}${e.code != null ? `, Cloudflare code ${e.code}` : ""})`;
      const wait = e.retryAt != null ? e.retryAt - d.now - elapsedMs : null;
      return {
        tone: "bad",
        text: `Couldn't update the page: ${reason}. The page is unchanged.`,
        detail: e.refused
          ? "The token may have been deleted or its role changed. Make a new one and paste it above."
          : wait == null
            ? "It is not tried again on its own. Update the page now tries once more."
            : wait <= 0
              ? "Tries again shortly."
              : `Tries again in about ${inHowLong(wait)}.`,
      };
    }
    case "newer":
      return {
        tone: "warn",
        text: `The page runs build ${build}${d.page?.version ? ` (${d.page.version})` : ""}, newer than this server's ${d.runningVersion}`,
        detail: "This server never rolls the page back by itself. Update the page now asks first, then puts this server's build back.",
      };
    case "other-build":
      return {
        tone: "warn",
        text: `The page runs build ${build} of this server's own version (${d.runningVersion}), deployed by another server`,
        detail:
          "This server leaves it alone, so two servers do not keep taking the page from each other. Update the page now asks first, then puts this server's build on it.",
      };
    case "no-bundle":
      return {
        tone: "warn",
        text: "This server's build has no copy of the page",
        detail: (
          <>
            {d.noBundle ? `${sentence(d.noBundle)} ` : ""}
            The reason is in the{" "}
            <a href="/log" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
              log
            </a>
            .
          </>
        ),
      };
  }
}

function sentence(text: string): string {
  return `${bare(text)}.`;
}

/** The pieces of a refused request the card acts on. */
function refusal(err: unknown): { status: number | undefined; code: string | undefined; body: Record<string, unknown> } {
  const e = err as Partial<ApiError>;
  return { status: e.status, code: e.code, body: e.body ?? {} };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** What the operator is asked before a page that was left alone is replaced. */
function downgradeQuestion(code: "newer" | "other-build", body: Record<string, unknown>, d: DeployStatus) {
  const running = str(body.runningVersion) ?? d.runningVersion;
  const ours = d.bundle ? `build ${d.bundle.build} (${d.bundle.version})` : `version ${running}`;
  if (code === "newer") {
    const page = str(body.pageVersion) ?? d.page?.version ?? "a newer version";
    return {
      title: "Put an older build on the page?",
      message: `The page was deployed from version ${page}, which is newer than this server's version ${running}. Replacing it puts this server's ${ours} on the public page, in place of the newer one.`,
    };
  }
  const page = str(body.pageBuild) ?? d.page?.build ?? "another build";
  const version = str(body.pageVersion) ?? d.runningVersion;
  return {
    title: "Replace another server's build?",
    message: `The page runs build ${page} of version ${version}, deployed by another server. Replacing it puts this server's ${ours} on the public page.`,
  };
}

export function KeepPageUpToDate({
  deploy,
  zone,
  elapsedMs,
  clock,
  guideHref,
  onAnswer,
  onDeploy,
  quiet,
}: {
  deploy: DeployStatus;
  /** The app's time zone, which the times are written in. */
  zone: string;
  /** How long ago `deploy` was read, by the browser's clock. */
  elapsedMs: number;
  /** The browser's clock now, ticking: what a retry countdown is read from. */
  clock: number;
  guideHref: string;
  /** A write's answer is the newest settings there are: the card keeps it in place of what it had read. */
  onAnswer: (next: PublishSettingsDTO) => void;
  /** A refusal's own copy of the status, newer than the read. */
  onDeploy: (next: DeployStatus) => void;
  /** Called before a write, so a poll in flight does not put back what it is changing. */
  quiet: () => Promise<void>;
}) {
  // What the operator has typed. null follows the server.
  const [acctDraft, setAcctDraft] = useState<string | null>(null);
  const [tokDraft, setTokDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** What the last "Update the page now" said, apart from an error: "Already up to date". */
  const [said, setSaid] = useState<string | null>(null);
  /** When a request the page refused as too soon may be made again: the browser's epoch ms, and the seconds the server said. */
  const [tooSoon, setTooSoon] = useState<{ until: number; sec: number } | null>(null);

  const stored = isMask(deploy.token);
  const acct = acctDraft ?? deploy.accountId;
  const tok = tokDraft ?? (stored ? FORM_MASK : "");
  const typedToken = tokDraft !== null && tokDraft.trim() !== "" && !isMask(tokDraft) ? tokDraft.trim() : null;
  const line = deployLine(deploy, zone, elapsedMs);
  const updating = deploy.state === "updating";
  // The tick can be up to a second old, so it never reads more than the server said.
  const wait = tooSoon === null ? 0 : Math.min(tooSoon.sec, Math.ceil((tooSoon.until - clock) / 1000));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    setSaid(null);
    await quiet();
    try {
      await action();
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Saved when the operator leaves a field. A token with no account (or the reverse) waits for the other; the route needs both. */
  async function saveCredentials() {
    if (busy) return;
    const cleared = stored && tokDraft !== null && tokDraft.trim() === "";
    const body: Record<string, string> = {};
    if (cleared) {
      // Deleting the token cannot be undone from here: it has to be made again in Cloudflare.
      setBusy(true);
      const yes = await confirm({
        title: "Stop keeping the page up to date?",
        message: "The token is deleted from this server; to turn updating on again you will need a new token from Cloudflare.",
        confirmLabel: "Delete the token",
        destructive: true,
      });
      setBusy(false);
      if (!yes) {
        setTokDraft(null);
        return;
      }
      body.token = "";
    } else if (typedToken !== null) {
      if (acct.trim() === "") {
        setNotice("Enter the Cloudflare account ID with the token.");
        return;
      }
      body.accountId = acct.trim();
      body.token = typedToken;
    } else if (acctDraft !== null && acctDraft.trim() !== deploy.accountId && (stored || acctDraft.trim() === "")) {
      body.accountId = acctDraft.trim();
    } else return;
    await run(async () => {
      onAnswer(await invoke<PublishSettingsDTO>("servicecue:setDeployCredentials", body));
      setAcctDraft(null);
      setTokDraft(null);
    });
  }

  /** "Update the page now". A page that was left alone is replaced only once the operator has said so, in a dialog that names both versions. */
  async function updateNow() {
    await run(async () => {
      let confirmDowngrade = false;
      for (;;) {
        try {
          const answer = await invoke<PublishSettingsDTO & { already?: "current"; serviceState?: "unknown" }>(
            "servicecue:deployNow",
            confirmDowngrade ? { confirmDowngrade } : undefined,
          );
          onAnswer(answer);
          if (answer.already === "current") setSaid("Already up to date.");
          else if (answer.serviceState === "unknown")
            setSaid("Updated the page. Planning Center had not said whether a service is live, so this went ahead without knowing.");
          return;
        } catch (err) {
          const { status, code, body } = refusal(err);
          const refused = body.deploy as DeployStatus | undefined;
          if (refused) onDeploy(refused);
          if (status === 409 && (code === "newer" || code === "other-build")) {
            if (confirmDowngrade) throw err;
            const q = downgradeQuestion(code, body, refused ?? deploy);
            if (!(await confirm({ ...q, confirmLabel: "Replace the page", cancelLabel: "Leave it" }))) return;
            confirmDowngrade = true;
            continue;
          }
          const sec = Number(body.retryAfterSec);
          if (status === 429 && Number.isFinite(sec) && sec > 0) {
            setTooSoon({ until: Date.now() + sec * 1000, sec });
            return;
          }
          throw err;
        }
      }
    });
  }

  return (
    <div className="mt-1 flex flex-col gap-3 rounded-[10px] border border-line bg-surface-raised p-3.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-footnote font-semibold text-fg">Keep the page up to date</h3>
        <p className="max-w-[72ch] text-caption1 text-fg-muted">
          This server is linked to the page, so after each update it puts its own copy of the page on Cloudflare, and the public page always
          matches what is here. Never during a live service. Clear the API token to stop.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <ConnectionField label="Cloudflare account ID" id="pl-cf-acct">
          <Input
            id="pl-cf-acct"
            className="font-mono"
            value={acct}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setAcctDraft(e.target.value)}
            onBlur={() => void saveCredentials()}
          />
        </ConnectionField>
        <ConnectionField label="API token" id="pl-cf-tok">
          <div className="flex min-w-0 flex-col gap-1">
            <Input
              id="pl-cf-tok"
              className="font-mono"
              type="password"
              placeholder="Paste a token to turn updating on"
              value={tok}
              disabled={busy}
              autoComplete="off"
              onFocus={(e) => {
                // The mask is not a value to edit: typing into it would append to bullets.
                if (isMask(tok)) e.currentTarget.select();
              }}
              onChange={(e) => setTokDraft(e.target.value)}
              onBlur={() => void saveCredentials()}
            />
            <p className="text-caption2 text-fg-muted">
              A token with the Workers <b className="font-semibold">Editor</b> role on the servicecue Worker only. It cannot touch DNS, domains or
              anything else.{" "}
              <a href={guideHref} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                How to make one
              </a>
            </p>
          </div>
        </ConnectionField>
      </div>

      {notice && <ErrorNote className="rounded-[9px] border-transparent bg-warn-9/12 px-3 py-[9px] text-caption1 text-warn-11">{notice}</ErrorNote>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 pt-0.5">
        <div role="status" className={cn("inline-flex items-start gap-2 text-footnote", TONE[line.tone].text)}>
          <span aria-hidden="true" className={cn("mt-[5px] size-2 shrink-0 rounded-full", TONE[line.tone].dot)} />
          <span data-deploy-state={deploy.state}>{line.text}</span>
        </div>
        {deploy.state !== "off" && (
          <Button
            variant="filled"
            size="small"
            className="ml-auto border border-line-strong bg-surface-raised hover:bg-fill-hover"
            disabled={busy || updating || wait > 0 || deploy.state === "no-bundle"}
            onClick={() => void updateNow()}
          >
            Update the page now
          </Button>
        )}
      </div>
      {deploy.state !== "off" && (wait > 0 || said || line.detail) && (
        <div className="flex flex-col gap-0.5 text-caption1 text-fg-muted">
          {wait > 0 && <span>Try again in {wait} s.</span>}
          {said && <span>{said}</span>}
          {line.detail && <span>{line.detail}</span>}
        </div>
      )}
    </div>
  );
}
