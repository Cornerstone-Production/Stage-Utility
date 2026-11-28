/** An inline link inside a sentence: the accent, underlined, losing the underline on hover. One place, so the
 *  ServiceCue launcher, the layouts page and the Embedded view inspector cannot drift apart. */
export const INLINE_LINK = "text-accent underline underline-offset-2 hover:no-underline";

/** A quiet link or text button: the accent, underlined only on hover. Size, weight and spacing stay with the
 *  caller (`cn(QUIET_LINK, "text-caption1")`). */
export const QUIET_LINK = "text-accent hover:underline";

/** QUIET_LINK for a link that sits alone in a toolbar or banner and is reached by keyboard: the standard focus ring. */
export const QUIET_LINK_RING = `${QUIET_LINK} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`;
