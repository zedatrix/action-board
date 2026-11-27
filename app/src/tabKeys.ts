// Cmd-1..9 pick a tab by its place in the tab list. Pure, so it can be tested without React.

export type TabKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

// Cmd (meta) plus a digit 1..9 with no other modifier gives that tab's index; anything else (or a digit
// past the last tab) is null.
export function tabIndexForKey(e: TabKey, count: number): number | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  const n = Number(e.key);
  return n <= count ? n - 1 : null;
}

// True where a keystroke is typing: an input, textarea or select, or anything inside contenteditable.
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).closest !== "function") return false;
  const node = el as HTMLElement;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return true;
  if (node.isContentEditable) return true;
  const editable = node.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}
