import { BaptismOperator } from "../../main/baptism-operator";

/**
 * Settings "Baptisms" tab. This and the standalone /baptism page render the SAME
 * <BaptismOperator/> against the same live session, so an operator can run it
 * from a tablet while this tab mirrors it. The link to that page is the standard
 * header action, as on every other tab with a standalone page.
 */
export function BaptismsSection() {
  return (
    <div className="flex flex-col gap-4">
      <BaptismOperator />
    </div>
  );
}
