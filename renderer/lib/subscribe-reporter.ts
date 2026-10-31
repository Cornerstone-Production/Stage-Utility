// One channel-filter report in flight at a time, per client.
//
// The server overwrites a client's filter with whichever report it handles last,
// and reports sent in parallel travel over several HTTP/1.1 connections, so they
// are handled in no particular order. A mount burst sends dozens; a stale one that
// lands last drops every channel added after it, and a widget on such a channel
// never receives a push until the next subscribe change — on a quiet page, never.
//
// So: send one, and while it is out only note that something changed. When it
// settles, send a single trailing report built from the channels as they are THEN.
// A failed report still releases the trailing one, so a transient error cannot
// freeze the filter.

export interface SubscribeReporter {
  /** Ask for the current channel set to be reported. Cheap to call repeatedly. */
  report: () => void;
}

export function createSubscribeReporter(
  channels: () => string[],
  send: (channels: string[]) => Promise<unknown>,
  onFailure: (err: unknown) => void,
): SubscribeReporter {
  let inFlight = false;
  let pending = false;

  function sendNow(): void {
    inFlight = true;
    let request: Promise<unknown>;
    try {
      request = send(channels());
    } catch (err) {
      request = Promise.reject(err);
    }
    request
      .catch(onFailure)
      .finally(() => {
        inFlight = false;
        if (pending) {
          pending = false;
          sendNow();
        }
      });
  }

  return {
    report() {
      if (inFlight) {
        pending = true;
        return;
      }
      sendNow();
    },
  };
}
