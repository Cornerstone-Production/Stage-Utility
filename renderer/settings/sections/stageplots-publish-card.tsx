// stageplots-publish-card.tsx — the editor's Publish card: the selected venue on the
// ServiceCue public page behind a secret link, or not.
//
// Off: what publishing does, and Publish <venue>. Published: when it was last published,
// the link with Copy, Regenerate… and Unpublish… behind their confirms, the backgrounds
// not yet published with Publish now, and the last error. What each action does, and
// what it says when the page refuses, is the server's (stageplots-publish.ts); the card
// shows the venue as the server saved it, followed live on stageplots:updated.
//
// The page's host is the venue's own once published, and the Public link card's address
// before that. Copy uses the clipboard where the browser has one; over plain HTTP, where
// it has none and the older copy command does not work, the link is put in a field and
// selected, to be copied by hand.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleXIcon, CopyIcon, GlobeIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import type { PublishSettingsDTO } from "@main/types/servicecue-publish-status";
import type { Venue } from "@main/types/stageplots";
import { STAGEPLOTS_PATH } from "@main/types/servicecue-publish";
import { plural } from "@main/services/plural";

import { Button } from "../../components/ui/button";
import { confirm } from "../../components/ui/confirm-dialog";
import { invoke } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { formatClock } from "../../lib/clock-format";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";
import { Mono } from "../../main/stageplots/mono";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { zonedDayLabel } from "./plan-date-label";
import { CardHeader, iconButton, type Save } from "./stageplots-shared";

type Action = "publish" | "regenerate" | "unpublish" | "publishNow";

/** "q7Hk2v…Rb4w": enough of a secret to tell two links apart, short enough for the card. */
export function shortSecret(secret: string): string {
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** "Thu 12 Nov, 14:32", in the app's zone and hour cycle. */
function whenLabel(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  return `${zonedDayLabel(ms, timeZone)}, ${formatClock(ms, { timeZone })}`;
}

const pill = "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] leading-[13px] font-medium";
const statusLine = "flex items-start gap-[7px] text-caption1 [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0";

export function PublishCard({ venue, save, timeZone }: { venue: Venue; save: Save; timeZone: string }) {
  const pub = venue.publish ?? null;
  // The Public link card's address, for the host and whether there is a page to publish to.
  const target = useQuery({
    queryKey: ["stageplots", "publish-target"],
    queryFn: () => invoke<PublishSettingsDTO>("servicecue:getPublish"),
    staleTime: 60_000,
  });
  const [working, setWorking] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the server said beside a success: a copy left on a page this server cannot reach. Kept until another venue. */
  const [notice, setNotice] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "select">("idle");
  const fieldRef = useRef<HTMLInputElement>(null);

  // A new venue, or the same one published, unpublished or moved to a new link, starts clean.
  useResyncOn([venue.id, pub?.secret ?? ""], () => {
    setError(null);
    setCopy("idle");
  });
  useResyncOn([venue.id], () => setNotice(null));

  useEffect(() => {
    if (copy !== "select") return;
    const field = fieldRef.current;
    field?.focus();
    field?.select();
  }, [copy]);

  const savedUrl = target.data?.url ?? "";
  const pageSetUp = savedUrl !== "" && target.data?.token !== "";
  const host = pub ? new URL(pub.origin).host : savedUrl ? new URL(savedUrl).host : "the public page";
  const link = pub ? `${pub.origin}${STAGEPLOTS_PATH}/${pub.secret}` : "";

  const run = async (action: Action) => {
    setWorking(action);
    const r = await save(() => stageplotsApi[action](venue.id));
    setWorking(null);
    setError(r.ok ? null : r.error);
    setNotice(r.ok ? (r.value.notice ?? null) : null);
  };

  const onCopy = async () => {
    if (await copyText(link)) {
      setCopy("copied");
      return;
    }
    // No clipboard here (plain HTTP) and the older copy command did nothing: select it for the operator.
    setCopy("select");
  };

  const onRegenerate = async () => {
    const ok = await confirm({
      title: "Regenerate the link?",
      message: `${venue.name} is published under a new secret link. The old link stops working as soon as the new one is up, so anyone using it will need the new one.`,
      confirmLabel: "Regenerate link",
      destructive: true,
    });
    if (ok) await run("regenerate");
  };

  const onUnpublish = async () => {
    const ok = await confirm({
      title: `Unpublish ${venue.name}?`,
      message: `Its page and backgrounds are removed from ${host} and the link stops working. The plots stay here. Publishing again makes a new link.`,
      confirmLabel: "Unpublish",
      destructive: true,
    });
    if (ok) await run("unpublish");
  };

  const lastError = pub?.lastError ?? null;
  const notYet = pub?.unpublishedImages.length ?? 0;
  // One button, one rule: anything left to send or to take down. It sits in the backgrounds line
  // when there is one (the mockup's place for it), else under the error.
  const needsPublishNow = !!pub && (notYet > 0 || lastError !== null || pub.retired.length > 0);
  const publishNow = (
    <button type="button" className="underline underline-offset-2" disabled={working !== null} onClick={() => void run("publishNow")}>
      {working === "publishNow" ? "Publishing…" : "Publish now"}
    </button>
  );

  return (
    <section className="su-card flex flex-col gap-2.5 px-3.5 py-3" aria-label="Publish">
      <CardHeader title="Publish">
        {pub ? (
          <span className={cn(pill, "bg-ok-9/15 text-ok-11")} data-testid="publish-pill">
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            Published
          </span>
        ) : (
          <span className={cn(pill, "bg-fill text-fg-muted")} data-testid="publish-pill">
            Off
          </span>
        )}
      </CardHeader>

      {!pub ? (
        <>
          <p className="text-caption1 text-fg-muted">
            Put {venue.name} on {host} behind a secret link. Anyone with the link can view its plots, read-only. Nothing lists it.
          </p>
          {target.data && !pageSetUp && (
            <p className="text-caption1 text-fg-subtle">
              Set up the public link first, under{" "}
              <a href="/servicecue/presets" className="text-accent underline underline-offset-2">
                Public link
              </a>{" "}
              on the ServiceCue layouts page.
            </p>
          )}
          <Button variant="accent" className="self-start" disabled={working !== null || (target.data !== undefined && !pageSetUp)} onClick={() => void run("publish")}>
            <GlobeIcon className="size-4" aria-hidden />
            {working === "publish" ? "Publishing…" : `Publish ${venue.name}`}
          </Button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] text-caption1">
            <dt className="text-fg-subtle">Last published</dt>
            <dd className="text-right text-fg-soft">
              <Mono text={whenLabel(pub.publishedAt, timeZone)} />
            </dd>
          </dl>
          <div
            className="flex h-[30px] min-w-0 items-center gap-1 rounded-md border border-line-strong bg-field pr-[3px] pl-[9px] text-caption1"
            title={link.replace(/^https?:\/\//, "")}
          >
            {copy === "select" ? (
              <input
                ref={fieldRef}
                readOnly
                value={link}
                aria-label="Link"
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent font-mono text-fg outline-none"
              />
            ) : (
              // The host gives way and the secret's ends never do: a workers.dev host is long, and the
              // short secret is what tells this link from the last one.
              <span className="flex min-w-0 flex-1 font-mono text-fg" data-testid="publish-link">
                <span className="min-w-0 truncate">{host}</span>
                <span className="shrink-0">{`${STAGEPLOTS_PATH}/${shortSecret(pub.secret)}`}</span>
              </span>
            )}
            <button type="button" className={cn(iconButton, "size-6")} title="Copy link" aria-label="Copy link" onClick={() => void onCopy()}>
              <CopyIcon className="size-3.5" />
            </button>
          </div>
          {copy === "copied" && (
            <p role="status" className="-mt-1.5 text-caption1 text-fg-subtle">
              Copied.
            </p>
          )}
          {copy === "select" && (
            <p role="status" className="-mt-1.5 text-caption1 text-fg-subtle">
              Selected: press Ctrl+C (⌘C on a Mac) to copy it.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="small" variant="filled" disabled={working !== null} onClick={() => void onRegenerate()}>
              <RefreshCwIcon className="size-3.5" aria-hidden />
              {working === "regenerate" ? "Regenerating…" : "Regenerate…"}
            </Button>
            <Button size="small" className="text-danger-11 hover:text-danger-11" disabled={working !== null} onClick={() => void onUnpublish()}>
              {working === "unpublish" ? "Unpublishing…" : "Unpublish…"}
            </Button>
          </div>
          {notYet > 0 && (
            <p className={cn(statusLine, "text-warn-11")}>
              <TriangleAlertIcon aria-hidden />
              <span>
                <Mono text={`${plural(notYet, "background")} not yet published.`} /> {publishNow}
              </span>
            </p>
          )}
          {lastError && (
            <p className={cn(statusLine, "text-danger-11")} role="alert">
              <CircleXIcon aria-hidden />
              <span>
                <Mono text={`Last error ${formatClock(Date.parse(lastError.at), { timeZone })}: ${lastError.message} Your plots are saved here.`} />
              </span>
            </p>
          )}
          {needsPublishNow && notYet === 0 && <p className="text-caption1 text-accent">{publishNow}</p>}
        </>
      )}
      {notice && (
        <p className={cn(statusLine, "text-warn-11")} role="status">
          <TriangleAlertIcon aria-hidden />
          <span>{notice}</span>
        </p>
      )}
      {error && !(pub && lastError?.message === error) && (
        <p className={cn(statusLine, "text-danger-11")} role="alert">
          <CircleXIcon aria-hidden />
          <span>
            {pub ? error : `${error} Your plots are saved here.`}
          </span>
        </p>
      )}
    </section>
  );
}
