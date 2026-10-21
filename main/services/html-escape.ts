// html-escape.ts — text made safe to place in HTML or XML, as content or as a
// quoted attribute value, on the server. The log page's in-browser script keeps
// its own, since it runs in the page and cannot import this.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}
