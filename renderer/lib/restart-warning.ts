// What to tell an operator before an action that exits the server.
//
// Every "restart" in this app is `process.exit(0)` plus a service manager
// starting us again. Where there is no service manager — a checkout somebody
// runs by hand — the exit is the whole story: the server stops and stays
// stopped, while the dialog that authorised it promised "a few seconds".
//
// That is exactly how it read from outside: a config restore on a hand-run
// checkout applied every file, answered `{ ok: true, restarting: true }`, exited
// zero, and left a log that simply stopped mid-sentence. The only available
// reading was that it had crashed. It had not crashed; nothing was watching.
//
// Four actions exit this way — a config import, a snapshot recall, an update,
// and the Restart button — so the sentence lives here once rather than being
// written four times and kept in step by luck.

/**
 * The consequence, in the operator's terms.
 *
 * @param selfRecovers `UpdateStatus.selfRecovers`. `undefined` means an older
 *   server that does not report it; treated as "it will come back", which is
 *   what every supervised install does and what the UI said before this existed.
 */
export function restartConsequence(selfRecovers: boolean | undefined): string {
  return selfRecovers === false
    ? "The server will then STOP. This copy is run by hand rather than by a service manager, so nothing will start it again — you will need to start it yourself."
    : "The displays go blank and reload for a few seconds while the server restarts.";
}

/** The toast after the action has been accepted, matching the same fact. */
export function restartOutcome(selfRecovers: boolean | undefined, done: string): string {
  return selfRecovers === false
    ? `${done} The server has now stopped — start it again to finish.`
    : `${done} The server is restarting.`;
}
