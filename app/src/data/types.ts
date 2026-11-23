export type Option = { id: string; label: string };

export type Priority = "high" | "medium" | "low";

// One entry of a decision's details. A bare string is a bullet (consecutive strings share one list).
// An object is a labeled section; ordered: true numbers its items.
export type DetailSection = { label: string; items: string[]; ordered?: boolean };
export type Detail = string | DetailSection;

// What was chosen. Single: one option. Multi (multiSelect decisions): option ids and labels in option order.
// Custom (free text): answer is "custom" and the text is in both answer_label and custom_text.
export type SingleChoice = { answer: string; answer_label: string };
export type MultiChoice = { answer: string[]; answer_label: string[] };
export type CustomChoice = { answer: "custom"; answer_label: string; custom_text: string };
export type Choice = SingleChoice | MultiChoice | CustomChoice;

export type Answer = Choice & {
  answered_by: "chat" | "app";
  answered_at: string;
};

export type Decision = {
  id: string;
  // Short bold topic shown at the top of the card. ab raise requires it; answered and older cards lack it.
  title?: string;
  card_ref: string | null;
  // 1 to 3 plain sentences shown first: what the item is and what happened. ab raise requires it; older cards lack it.
  context?: string;
  question: string;
  // Optional structure under the question: bullets and labeled lists.
  details?: Detail[];
  what_happens_after: string;
  options: Option[];
  // true: options toggle and a Submit button confirms. Missing or false: one click answers.
  multiSelect?: boolean;
  // Free-text answer field. Missing means true; only false hides it.
  allowCustom?: boolean;
  // How much it matters; sorts the Needs you queue. Missing means medium. Set by ab raise or ab priority.
  priority?: Priority;
  // true: the card blocks a PR, merge, ticket or task, so ab keeps it high. ab raise requires it; older cards lack it (unknown).
  blocking?: boolean;
  created_at: string;
  // Last raise or answer (ISO UTC), set by ab; equals created_at until the card changes. Older cards lack it.
  updated_at?: string;
  answer?: Answer;
};

export type WaitingItem = { title: string; who: string; link?: string };
export type Ticket = { id: string; title: string; status: string; link?: string };
// Someone else's open PR that involves the user. who says what it waits on ("Your review requested", "Waiting on the author"); link is the PR URL.
export type OtherPR = { title: string; author: string; who: string; link: string };

export type Board = {
  updated_at: string;
  decisions: Decision[];
  // parked is a retired key: always empty, kept optional so older files still load. Parked things are decisions now.
  // others is optional so older files still load; missing means [].
  glance: { waiting: WaitingItem[]; tickets: Ticket[]; others?: OtherPR[]; parked?: never[] };
};

// Project tab (data in ./project.ts). Counts leave out duplicate and canceled tickets;
// left includes in_progress, so done + left = total. title is the tab's label and heading.
export type ProjectCounts = { done: number; in_progress: number; left: number; total: number };
export type ProjectMilestone = ProjectCounts & { key: string; id: string; title: string; url: string };
export type Project = {
  title: string;
  updated_at: string;
  parent: { id: string; url: string };
  milestones: ProjectMilestone[];
};
