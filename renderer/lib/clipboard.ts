import { toast } from "../components/ui";
import { logToServer } from "./client-log";

/**
 * Copy text to the clipboard, returning true on success.
 *
 * `navigator.clipboard` only exists in a secure context (https / localhost).
 * Stage Utility is typically served over plain HTTP on a LAN address, where it's
 * undefined — so fall back to the legacy textarea + execCommand("copy") path.
 */
export async function copyText(text: string, container?: HTMLElement | null): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  // execCommand("copy") copies the CURRENT selection, so this only works while
  // the textarea still holds both focus and the selection. Anything that moves
  // focus first - a menu closing and returning focus to its trigger, say -
  // leaves nothing selected and the copy silently does nothing. Callers inside
  // a menu must therefore keep it open across this call.
  try {
    const previous = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    // Where the textarea is mounted decides whether this works at all. A
    // component with a FOCUS TRAP - a Radix menu or dialog - forces focus back
    // inside itself the instant anything outside takes it, so a textarea on
    // document.body loses focus and its selection before execCommand runs, and
    // the copy silently does nothing. Mounting inside the trap keeps both.
    const host = container ?? document.body;
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    host.appendChild(ta);
    ta.focus();
    ta.select();
    // iOS ignores select() on a readonly textarea; this is the documented way.
    ta.setSelectionRange(0, text.length);
    // execCommand returns true even when the selection was stolen and nothing
    // was copied, which is how this reported "URL copied" while copying
    // nothing. Confirm the textarea actually held focus and a selection.
    const reallySelected =
      document.activeElement === ta && ta.selectionEnd - ta.selectionStart === text.length;
    const ok = document.execCommand("copy") && reallySelected;
    host.removeChild(ta);
    // Put focus back where the operator left it, or the menu they were in loses
    // its keyboard position.
    previous?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

/**
 * {@link copyText}, and say which way it went: `ok` as a success toast, `fail` as
 * an error toast and a line on /log under `tag`. Returns the result, for a caller
 * that has more to do on failure (select a field so it can be copied by hand).
 *
 * The line names the failure and never the text: what is copied may be a token
 * that is shown once, or a URL carrying one.
 */
export async function copyWithToast(
  text: string,
  { ok, fail, tag, container }: { ok: string; fail: string; tag: string; container?: HTMLElement | null },
): Promise<boolean> {
  const copied = await copyText(text, container);
  if (copied) toast.success(ok);
  else {
    toast.error(fail);
    logToServer(tag, "could not copy to the clipboard");
  }
  return copied;
}
