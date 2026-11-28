// pco-request.ts — answer a Planning Center client's private `request` from a
// test, without the network.
//
// Both clients (pcoService and pcoCalendarService) funnel every read through a
// private `request`. A test that assigns over it through an `as unknown as`
// cast keeps compiling after a rename: it sets a dead property and the call
// goes to the real API with "app"/"secret". Here the slot is named through an
// indexed access on the real class, which TypeScript resolves even for a
// private member, so renaming `request` breaks compilation in this file.

import type { pcoCalendarService } from "../pco-calendar-service.js";
import type { pcoService } from "../pco-service.js";

// The classes are not exported; the singletons are what tests hold.
type PcoService = typeof pcoService;
type PcoCalendarService = typeof pcoCalendarService;
type PcoClient = PcoService | PcoCalendarService;
/** Loose by design: tests answer with JSON:API fragments, not full responses. */
type Slot = { request: (url: string, appId: string, secret: string) => Promise<unknown> };

// Compile-time tie: each client's real `request` must be assignable to the slot
// the stub fills. A rename fails on the indexed access, a retype on the
// assignment.
// (url is branded in the real signature, so it is not compared.)
type Tie = (url: never, appId: string, secret: string) => Promise<unknown>;
const _tie: Tie[] = [null as unknown as PcoService["request"], null as unknown as PcoCalendarService["request"]];
void _tie;

export interface PcoRequestStub {
  /** Every url asked for, in order, since this stub was installed. */
  urls: string[];
  /** Put the real `request` back, so the next test (or the real transport) sees it. */
  restore(): void;
}

/** A JSON:API body, as `request` resolves it. */
export const jsonApi = (data: unknown[], included: unknown[] = []): { data: unknown[]; included: unknown[] } => ({ data, included });

// The first `request` seen per client. A stub installed over a stub must still
// restore the real transport, not the earlier stub.
const originals = new WeakMap<object, Slot["request"]>();

/** Put `service`'s real `request` back. A no-op when it was never stubbed. */
export function restorePcoRequest(service: PcoClient): void {
  const real = originals.get(service);
  if (real) (service as unknown as Slot).request = real;
}

/** Replace `service.request`; `respond` is called with each url. */
export function stubPcoRequest(service: PcoClient, respond: (url: string) => unknown | Promise<unknown>): PcoRequestStub {
  const slot = service as unknown as Slot;
  if (!originals.has(service)) originals.set(service, slot.request);
  const urls: string[] = [];
  slot.request = async (url: string) => {
    urls.push(url);
    return respond(url);
  };
  return { urls, restore: () => restorePcoRequest(service) };
}
