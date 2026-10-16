// message-rules.ts — what stage messages refuse, said once.
//
// The messaging config (messaging-store.ts) and a send (messages-service.ts) both
// take text off the wire and both refuse it the same way: not text, empty once
// trimmed, too long. They used to say so twice with two classes for the same
// thing; routes answer both as a 400 with the reason, so there is one.

/**
 * The caller's mistake rather than ours: a body the rules refuse. Routes answer
 * it 400 with the message; anything else that throws out of the stores is a
 * failed write and is not dressed up as one.
 */
export class MessageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageRefused";
  }
}

/**
 * Text off the wire, trimmed: a string of 1 to `max` characters once trimmed.
 * `what` names it in the reason, as the subject of a sentence ("a group name",
 * "from").
 */
export function checkedText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw new MessageRefused(`${what} must be text`);
  const text = value.trim();
  if (text.length < 1) throw new MessageRefused(`${what} cannot be empty`);
  if (text.length > max) throw new MessageRefused(`${what} is at most ${max} characters (this one is ${text.length})`);
  return text;
}
