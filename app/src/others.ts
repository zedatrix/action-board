import type { OtherPR } from "./data/types";

// Items waiting on the user's review come first; each group keeps the file's order.
export function sortOthers(items: OtherPR[]): OtherPR[] {
  const review = (o: OtherPR) => /review requested/i.test(o.who);
  return [...items.filter(review), ...items.filter((o) => !review(o))];
}
