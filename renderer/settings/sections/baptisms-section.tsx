import { BaptismOperator } from "../../main/baptism-operator";

/**
 * A wrapper around <BaptismOperator/>, unrouted — /baptism renders that
 * component directly, and nothing links to this file. Kept rather than
 * deleted; see the NOT_ROUTED entry for "BaptismsSection" in
 * renderer/app/reachable.test.ts for why removing it is a separate decision.
 */
export function BaptismsSection() {
  return (
    <div className="flex flex-col gap-4">
      <BaptismOperator />
    </div>
  );
}
