import type { ReactNode } from "react";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING = /[.,;:!?)]+$/;

// A URL found in text, minus trailing sentence punctuation, or null when only a bare scheme is left.
function clean(match: string): string | null {
  const url = match.replace(TRAILING, "");
  return /^https?:\/\/./.test(url) ? url : null;
}

export function* findUrls(text: string) {
  for (const match of text.matchAll(URL_RE)) {
    const url = clean(match[0]);
    if (url) yield { url, start: match.index! };
  }
}

// Card text links open in a new tab and never get the opener.
export function Link({ href, className, children }: { href: string; className?: string; children?: ReactNode }) {
  return (
    <a className={className ?? "card-link"} href={href} target="_blank" rel="noopener noreferrer">
      {children ?? href}
    </a>
  );
}

// Text with every http(s) URL turned into a Link. Other text is passed through as plain strings, so
// textContent is unchanged.
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const { url, start } of findUrls(text)) {
    if (start > last) out.push(text.slice(last, start));
    out.push(<Link key={start} href={url} />);
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// The URL when the whole text (trimmed) is a single URL, else null.
export function bareUrl(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^https?:\/\/[^\s<>"')\]]+$/);
  return m && clean(m[0]) === t ? t : null;
}
