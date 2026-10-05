// pco-person-id.ts — the Planning Center person ID a by-person slot matches on.
//
// The API identifies a person by a bare number (113920177). Planning Center's own
// pages show the same person as AC113920177 in the URL
// (services.planningcenteronline.com/people/AC113920177), and that is where an
// operator copies it from. Compared as typed, the AC form, a pasted URL or a
// trailing space matched nobody and the slot stayed empty with no explanation.
// All of them reduce to the number here. Anything else comes back trimmed and
// simply matches nobody; isPcoPersonId tells the editor to say so.

export function normalizePcoPersonId(raw: string): string {
  const s = raw.trim();
  const fromUrl = /\/people\/(?:AC)?(\d+)/i.exec(s);
  if (fromUrl) return fromUrl[1] ?? s;
  const prefixed = /^AC(\d+)$/i.exec(s);
  return prefixed ? (prefixed[1] ?? s) : s;
}

/** True for a normalised value that can be a person ID at all. */
export function isPcoPersonId(id: string): boolean {
  return /^\d+$/.test(id);
}
