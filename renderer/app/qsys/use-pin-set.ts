// Whether a staff PIN is set, for the two places that ask: /qsys/manage's PIN
// section and a volunteer panel's PIN pad. Never the PIN or its hash: the server
// answers only `{ set }`.

import { useRead, type ReadState } from "../../lib/use-read";

export function usePinSet(): [ReadState<{ set: boolean }>, (value: { set: boolean }) => void] {
  return useRead<{ set: boolean }>("qsys:pin", "qsys", "whether a staff PIN is set");
}
