import type { Decision } from "./data/types";

// A decision needs the user iff the file has no answer for it and they have not answered it in the app.
// When the file has an answer it wins; any local app answer for that id is ignored (and later dropped).
export function needsYou(decisions: Decision[], appAnswered: Record<string, unknown>): Decision[] {
  return decisions.filter((d) => !d.answer && !Object.prototype.hasOwnProperty.call(appAnswered, d.id));
}
