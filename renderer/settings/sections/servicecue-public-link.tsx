// servicecue-public-link.tsx — the "Public link" card on the ServiceCue presets page.
//
// ServiceCue on the web: the server sends what ServiceCue shows out to a page the
// operator deployed, and volunteers open that page instead of the app. This card is
// the switch, the address it publishes to, the link to hand out, and how it is going.
//
// Three states, drawn from the approved mockup: OFF (setup fields; the switch waits
// for both), PUBLISHING (the link, QR code and what was last sent) and PROBLEM (the
// same, and why the page is not being reached). Every word of the card is the
// mockup's, and the problem text says what really went wrong.
//
// One react-query read, polled while the page is open (the Automation page's own pattern
// for a live status). The answer to every write goes into the same cache entry: it is
// newer than anything read, and a poll in flight when a write starts is cancelled.

import { errorMessage } from "@main/services/errors";
import { FORM_MASK, isMask } from "@main/services/mask";
import { plural } from "@main/services/plural";
import { parsePublishUrl } from "@main/services/servicecue-publish-rules";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useUpdateStatus } from "../../app/queries";
import { QrHint } from "../../components/qr-hint";
import { Button, ErrorNote, Input, Switch } from "../../components/ui";
import { SkeletonRows } from "../../components/ui/skeleton";
import { invoke } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { docsPageUrl } from "../../lib/docs-url";
import { cn } from "../../lib/cn";
import { useFailedReads } from "../../lib/use-failed-reads";
import type {
  PublishProblem,
  PublishSettingsDTO,
  PublishTestResult,
} from "../../../main/types/servicecue-publish-status.js";

/** How often the card asks how it is going while the page is open. */
const POLL_MS = 5_000;
/** How long "Copied" stays on the button. */
const COPIED_MS = 1_500;

const QUERY_KEY = ["servicecue:getPublish"] as const;

const ADDRESS_PLACEHOLDER = "https://servicecue.your-account.workers.dev";

/** The mockup's button: a hairline border on the raised surface, which `filled` alone does not draw. */
const RAISED_BUTTON = "border border-line-strong bg-surface-raised hover:bg-fill-hover";

/** How long ago, as the card's facts say it: "8 s", "6 min", "2 h". */
export function sentAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** The origin an address names, for telling an edit from a re-typing: null when it names none. */
function originOf(address: string): string | null {
  // Only to tell two addresses apart: the server decides which are allowed.
  const parsed = parsePublishUrl(address, true);
  return parsed.ok ? parsed.origin : null;
}

const KEEPS_SHOWING = " Until then the public page keeps showing the rundown it last got, with a note saying how old it is.";

/** A sentence ends in a full stop, whatever the server's own words did. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The problems whose fix is in the connection fields, which the card opens for them. */
const FIXED_BELOW: ReadonlySet<PublishProblem["kind"]> = new Set(["auth", "config", "redirect", "rejected", "unreachable"]);

/**
 * Why the page is not being reached, in the card's voice.
 *
 * The token text is the mockup's, word for word. The others say the same kind of
 * thing about their own cause: who answered, what it means, what to do.
 */
export function ProblemText({ problem }: { problem: PublishProblem }): ReactNode {
  const status = <b className="font-semibold">{problem.status}</b>;
  switch (problem.kind) {
    case "auth":
      return (
        <>
          Cloudflare answered {status}: the publishing token doesn't match the one set on the page. Enter it again below.
          {KEEPS_SHOWING}
        </>
      );
    case "blocked":
      return (
        <>
          Cloudflare answered {status}: a rule on the account blocked this server. Check the firewall and access rules for the page's
          address, then save the connection again.{KEEPS_SHOWING}
        </>
      );
    case "limited":
      return (
        <>
          Cloudflare answered {status}: the page is being asked too often. This server keeps trying, a little less often each time.
          {KEEPS_SHOWING}
        </>
      );
    case "no-token":
      // The page answers 503 to EVERY request, a correct token included, while its own token is
      // missing or under 32 characters: the commonest 503 there is, and the operator's to fix.
      return (
        <>
          The page answered {status}: it has no token set, or one under 32 characters. Set it on the page, as the setup guide shows.
          This server keeps trying, a little less often each time.{KEEPS_SHOWING}
        </>
      );
    case "server":
      return (
        <>
          Cloudflare answered {status}: the page had a problem of its own. This server keeps trying, a little less often each
          time.{KEEPS_SHOWING}
        </>
      );
    case "rejected":
      return (
        <>
          The address answered {status}, which isn't what the ServiceCue page says. Check the address below.{KEEPS_SHOWING}
        </>
      );
    case "redirect":
      return (
        <>
          The address answered with a redirect, and a redirect is never followed. Use the address the page was deployed at,
          below.{KEEPS_SHOWING}
        </>
      );
    case "unreachable":
      return (
        <>
          This server couldn't reach the page: {sentence(problem.message)} Check the address below, and that this server can get to
          the internet.{KEEPS_SHOWING}
        </>
      );
    case "protocol":
    case "config":
      // Said by the server in full, and nothing has been sent for it to keep showing.
      return <>{problem.message}</>;
  }
}

/** A failed connection test as the problem it names, for the same sentence. */
function problemOfTest(t: Extract<PublishTestResult, { ok: false }>): PublishProblem {
  return { kind: t.kind, ...(t.status !== undefined ? { status: t.status } : {}), message: t.message };
}

const pill = {
  off: { word: "Off", tone: "bg-fill text-fg-muted" },
  publishing: { word: "Publishing", tone: "bg-ok-9/12 text-ok-11" },
  problem: { word: "Not reaching the page", tone: "bg-warn-9/12 text-warn-11" },
} as const;

type View = keyof typeof pill;

function viewOf(dto: PublishSettingsDTO | undefined): View {
  if (!dto?.enabled) return "off";
  return dto.status.state === "problem" && dto.status.lastError ? "problem" : "publishing";
}

export function PublicLinkCard({
  typeNames,
  layoutNames,
  pollMs = POLL_MS,
}: {
  typeNames: string[];
  layoutNames: string[];
  /** How often it asks how it is going. A seam for the test that watches it change. */
  pollMs?: number;
}) {
  const queryClient = useQueryClient();
  const { data: dto, error: readError, dataUpdatedAt } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => invoke<PublishSettingsDTO>("servicecue:getPublish"),
    refetchInterval: pollMs,
  });
  const branch = useUpdateStatus().data?.branch ?? null;
  // The clock now. The age is read off the SERVER's stamps and the browser's own time
  // since the answer arrived, so a browser whose clock is wrong still says how long ago.
  const [clock, setClock] = useState(() => Date.now());
  // What the operator has typed. null follows the server, so a value read back is
  // what shows until something is typed over it.
  const [addrDraft, setAddrDraft] = useState<string | null>(null);
  const [tokDraft, setTokDraft] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  // null follows the problem: open when the fix is in these fields, shut otherwise.
  const [connOpen, setConnOpen] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const { failed, fail, clear } = useFailedReads<"publish">("servicecue");

  useEffect(() => {
    if (readError) fail("publish", "the ServiceCue public link settings", readError);
    else clear("publish");
  }, [readError, fail, clear]);

  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  if (failed.has("publish") && !dto) {
    return (
      <section aria-labelledby="pub-title" className="mb-5 max-w-[760px]">
        <h2 id="pub-title" className="sr-only">Public link</h2>
        <ErrorNote>Couldn't load the public link settings.</ErrorNote>
      </section>
    );
  }

  const status = dto?.status ?? null;
  const view = viewOf(dto);
  const tokenStored = isMask(dto?.token);
  const addr = addrDraft ?? dto?.url ?? "";
  const tok = tokDraft ?? (tokenStored ? FORM_MASK : "");
  const typedToken = tokDraft !== null && tokDraft.trim() !== "" && !isMask(tokDraft) ? tokDraft.trim() : null;
  const canEnable = addr.trim() !== "" && (typedToken !== null || (tokDraft === null && tokenStored));
  const link = dto?.url ? `${dto.url}/servicecue` : "";
  // `now` and `lastSentAt` are the server's; what has passed since the answer came is the browser's own.
  const ageMs = status?.lastSentAt != null ? status.now - status.lastSentAt + Math.max(0, clock - dataUpdatedAt) : null;
  const connShown = connOpen ?? (view === "problem" && !!status?.lastError && FIXED_BELOW.has(status.lastError.kind));

  /** An answer from a write: newer than any read, so it replaces what was read, and the drafts it settled are dropped. */
  function adopt(next: PublishSettingsDTO) {
    queryClient.setQueryData(QUERY_KEY, next);
    setAddrDraft(null);
    setTokDraft(null);
    setDropped(next.dropped && !next.dropped.ok ? next.dropped.message : null);
  }

  async function write(action: () => Promise<void>) {
    setWorking(true);
    setHint(null);
    setNotice(null);
    setDropped(null);
    // A poll that lands in the middle of a write would put back what the write is changing.
    await queryClient.cancelQueries({ queryKey: QUERY_KEY });
    try {
      await action();
    } catch (err) {
      // Shown to the operator, in the place the problem text goes: a write that
      // failed is not a switch that quietly stayed where it was.
      setNotice(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  function turnOn() {
    return write(async () => {
      const url = addr.trim();
      const credentials = { url, ...(typedToken !== null ? { token: typedToken } : {}) };
      // The page is asked first, so a wrong address or token is said at the switch and
      // the card never claims to be publishing to nothing.
      const test = await invoke<PublishTestResult>("servicecue:testPublish", credentials);
      if (!test.ok) {
        setNotice(<ProblemText problem={problemOfTest(test)} />);
        return;
      }
      adopt(await invoke<PublishSettingsDTO>("servicecue:setPublish", { ...credentials, enabled: true }));
    });
  }

  function turnOff() {
    return write(async () => adopt(await invoke<PublishSettingsDTO>("servicecue:setPublish", { enabled: false })));
  }

  /** The two fields in "Cloudflare connection", saved when the operator leaves one. */
  async function saveConnection() {
    if (!dto || working) return;
    const changed = originOf(addr) !== originOf(dto.url);
    if (!changed && typedToken === null) return;
    if (changed && typedToken === null) {
      // The server would refuse it, and says so; this says it before anything is sent.
      setHint("A different address needs its token: paste it again.");
      return;
    }
    await write(async () =>
      adopt(await invoke<PublishSettingsDTO>("servicecue:setPublish", { ...(changed ? { url: addr.trim() } : {}), token: typedToken })),
    );
  }

  const fields = (
    <ConnectionFields
      setup={view === "off"}
      addr={addr}
      tok={tok}
      disabled={working}
      hint={hint}
      onAddr={setAddrDraft}
      onTok={setTokDraft}
      onLeave={() => void saveConnection()}
    />
  );

  return (
    <section
      aria-labelledby="pub-title"
      data-state={dto ? view : "loading"}
      className="mb-5 flex max-w-[760px] flex-col gap-3 rounded-xl border border-line-strong bg-surface px-[18px] py-4"
    >
      <div className="flex items-center gap-2.5">
        <h2 id="pub-title" className="text-subheadline font-semibold text-fg">Public link</h2>
        {dto && (
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-[9px] py-0.5 text-caption1 font-medium", pill[view].tone)}>
            <span aria-hidden="true" className="size-[7px] rounded-full bg-current" />
            {pill[view].word}
          </span>
        )}
        <Switch
          className="ml-auto"
          aria-label="Publish ServiceCue to the web"
          checked={view !== "off"}
          disabled={!dto || working || (view === "off" && !canEnable)}
          onCheckedChange={(on) => void (on ? turnOn() : turnOff())}
        />
      </div>

      <p className="max-w-[72ch] text-footnote text-fg-muted">
        Anyone with the link sees ServiceCue as it is here: every service type on the landing page, every layout, the live item and
        countdown. No login. Editing stays in the building.
      </p>

      {!dto && <SkeletonRows rows={2} />}

      {dto && view !== "off" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-[1_1_320px] rounded-lg border border-line bg-field px-2.5 py-1.5 font-mono text-caption1 text-fg [overflow-wrap:anywhere]">
              {link}
            </span>
            <Button
              variant="filled"
              size="small"
              className={RAISED_BUTTON}
              onClick={async () => {
                if (!(await copyText(link))) return;
                setCopied(true);
                if (copyTimer.current) clearTimeout(copyTimer.current);
                copyTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="filled" size="small" className={RAISED_BUTTON} aria-expanded={qrOpen} onClick={() => setQrOpen((o) => !o)}>
              QR code
            </Button>
          </div>
          {qrOpen && (
            <div className="flex items-center gap-3.5 rounded-[10px] border border-line bg-surface-raised p-3">
              <QrHint url={link} solid sizeCss="120px" />
              <small className="max-w-[40ch] text-caption1 text-fg-muted">
                Print it for the green room or the band area. Volunteers scan once and keep the bookmark. The links work exactly
                like they do here: <code>/servicecue/weekend/audio</code>, <code>?plan=</code>, text size.
              </small>
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption1 text-fg-muted">
            {ageMs === null ? (
              <span>Sending the first copy</span>
            ) : (
              <span>
                Last sent <Fact>{sentAgo(ageMs)}</Fact> ago
              </span>
            )}
            <Count n={status?.counts.types ?? 0} one="service type" />
            <Count n={status?.counts.plans ?? 0} one="plan" after=" in the next 60 days" />
            <Count n={status?.counts.layouts ?? 0} one="layout" />
          </div>
        </div>
      )}

      {dto && view === "problem" && status?.lastError && (
        <Note>
          <ProblemText problem={status.lastError} />
        </Note>
      )}

      {dto && dropped && (
        <Note>
          {view === "off" ? "Publishing is off" : "The address changed"}, but the page didn't answer, so it may still show the last
          rundown it was sent. {dropped}
        </Note>
      )}

      {dto && view === "off" && (
        <div className="flex flex-col gap-2.5">
          {notice && <Note>{notice}</Note>}
          {fields}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-caption2 text-fg-subtle">
              The switch turns on once both are filled in. Setting up the page takes one command; the guide walks through it.
            </span>
            <Button asChild variant="transparent" size="small" className="px-1 text-accent">
              <a href={docsPageUrl("ops/servicecue-on-the-web", branch)} target="_blank" rel="noreferrer">
                Setup guide
              </a>
            </Button>
          </div>
        </div>
      )}

      {dto && view !== "off" && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
          {notice && <Note>{notice}</Note>}
          <div className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">What the public sees</div>
          <ul className="flex list-disc flex-col gap-[3px] pl-[18px] text-footnote">
            <li>
              {typeNames.length > 0 ? typeNames.join(", ") : "No service types yet"}{" "}
              <span className="text-fg-muted">· follows "Shown on the landing page" above</span>
            </li>
            <li>
              {[...layoutNames, "All columns"].join(", ")} <span className="text-fg-muted">· every layout below</span>
            </li>
            <li>
              The live item, countdown and clock <span className="text-fg-muted">· as they change</span>
            </li>
          </ul>
          <div className="flex items-center gap-1.5">
            <Button
              variant="transparent"
              size="small"
              className="px-1 text-accent"
              aria-expanded={connShown}
              onClick={() => setConnOpen(!connShown)}
            >
              Cloudflare connection
            </Button>
          </div>
          {/* Not drawn at all while closed, so a closed disclosure holds nothing to tab to or to find. */}
          {connShown && fields}
        </div>
      )}
    </section>
  );
}

/** The card's one note: a problem, a refusal, a write that failed. */
function Note({ children }: { children: ReactNode }) {
  return <ErrorNote className="rounded-[9px] border-transparent bg-warn-9/12 px-3 py-[9px] text-caption1 text-warn-11">{children}</ErrorNote>;
}

/** A count with its unit as the facts line says it: the number in bold, `after` as plain text. */
function Count({ n, one, after = "" }: { n: number; one: string; after?: string }) {
  return (
    <span>
      <Fact>{n}</Fact> {plural(n, one).replace(/^\d+ /, "")}
      {after}
    </span>
  );
}

function Fact({ children }: { children: ReactNode }) {
  return <b className="font-medium tabular-nums text-fg">{children}</b>;
}

/**
 * The address and the token. In setup they carry their hints and are read when the switch is
 * thrown; behind "Cloudflare connection" they save themselves when one is left.
 */
function ConnectionFields({
  setup,
  addr,
  tok,
  disabled,
  hint,
  onAddr,
  onTok,
  onLeave,
}: {
  setup: boolean;
  addr: string;
  tok: string;
  disabled: boolean;
  hint: string | null;
  onAddr: (v: string) => void;
  onTok: (v: string) => void;
  onLeave: () => void;
}) {
  const leave = setup ? undefined : onLeave;
  return (
    <div className="flex flex-col gap-2.5">
      <ConnectionField label="Page address" hint={setup ? "Your Cloudflare Worker" : undefined} id={setup ? "pl-addr" : "pl-addr2"}>
        <Input
          id={setup ? "pl-addr" : "pl-addr2"}
          className="font-mono"
          placeholder={ADDRESS_PLACEHOLDER}
          value={addr}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onAddr(e.target.value)}
          onBlur={leave}
        />
      </ConnectionField>
      <ConnectionField label="Publishing token" hint={setup ? "The same one set on the page" : undefined} id={setup ? "pl-tok" : "pl-tok2"}>
        <Input
          id={setup ? "pl-tok" : "pl-tok2"}
          className="font-mono"
          type="password"
          placeholder="Paste the token"
          value={tok}
          disabled={disabled}
          autoComplete="off"
          onFocus={(e) => {
            // The mask is not a value to edit: typing into it would append to bullets.
            if (isMask(tok)) e.currentTarget.select();
          }}
          onChange={(e) => onTok(e.target.value)}
          onBlur={leave}
        />
      </ConnectionField>
      {hint && !setup && <p className="text-caption2 text-warn-11">{hint}</p>}
    </div>
  );
}

/** A label with its hint on the left and the input on the right, as the mockup lays it out. */
function ConnectionField({ label, hint, id, children }: { label: string; hint?: string; id: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-2.5 max-[560px]:grid-cols-1">
      <label htmlFor={id} className="text-footnote text-fg">
        {label}
        {hint && <span className="block text-caption2 text-fg-muted">{hint}</span>}
      </label>
      {children}
    </div>
  );
}
