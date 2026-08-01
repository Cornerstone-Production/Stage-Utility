import { useEffect, useState } from "react";

import { invoke } from "../lib/api";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue, toast } from "../components/ui";
import { usePlanItems } from "./use-plan-items";

/**
 * Which items in THIS plan start each phase of the timer.
 *
 * Bound per plan rather than by name because the two ends differ: the testimonies
 * happen during an item called the same thing every week, which the keyword in
 * Settings already catches, but the baptisms happen during whichever songs are on
 * that week — no rule can find those, so they are picked.
 *
 * Only worth opening on a baptism weekend; an ordinary plan is left unbound and the
 * timer stays manual.
 */
export function BaptismTriggersPanel() {
  const plan = usePlanItems();
  const [testimonyItemId, setTestimony] = useState<string>("");
  const [baptismItemId, setBaptism] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

  const planId = plan?.planId ?? null;

  useEffect(() => {
    if (!planId) return;
    let cancelled = false;
    invoke<{ testimonyItemId?: string | null; baptismItemId?: string | null }>("baptism:getTriggers", { planId })
      .then((t) => {
        if (cancelled) return;
        setTestimony(t?.testimonyItemId ?? "");
        setBaptism(t?.baptismItemId ?? "");
        setLoaded(true);
      })
      .catch(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [planId]);

  async function save(next: { testimonyItemId: string; baptismItemId: string }) {
    if (!planId) return;
    try {
      await invoke("baptism:setTriggers", {
        planId,
        testimonyItemId: next.testimonyItemId || null,
        baptismItemId: next.baptismItemId || null,
      });
    } catch (err) {
      toast.error(`Couldn't save: ${String(err)}`);
    }
  }

  if (!planId || !plan?.items?.length) return null;

  // Headers are section markers, not things that go live on their own.
  const options = plan.items.filter((i) => i.itemType !== "header");

  const picker = (value: string, onPick: (v: string) => void, label: string) => (
    <Select
      value={value}
      onValueChange={(v: string) => {
        const id = v === "__none__" ? "" : v;
        onPick(id);
        void save({
          testimonyItemId: label === "testimony" ? id : testimonyItemId,
          baptismItemId: label === "baptism" ? id : baptismItemId,
        });
      }}
    >
      <SelectTrigger className="w-full sm:w-64">
        <SelectValue placeholder="Not set" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">Not set</SelectItem>
        {options.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-5 bg-gray-2 p-4">
      <span className="text-caption1 font-medium text-gray-11">Start from this plan</span>
      <span className="text-caption2 text-gray-9">
        When one of these items goes live in Planning Center, the timer moves itself on — so the
        producer isn&rsquo;t starting two things at once. Leave unset to run it by hand.
      </span>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="w-32 shrink-0 text-caption1 text-gray-11">Testimonies</span>
        {picker(testimonyItemId, setTestimony, "testimony")}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="w-32 shrink-0 text-caption1 text-gray-11">Baptisms</span>
        {picker(baptismItemId, setBaptism, "baptism")}
      </div>
      {loaded && !baptismItemId && testimonyItemId && (
        <span className="text-caption2 text-amber-11">
          Testimonies will start themselves, but the switch to baptisms is still manual — pick the
          item the baptisms happen during, usually the first song after the prayer.
        </span>
      )}
    </div>
  );
}
