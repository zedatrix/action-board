import type { Board } from "../src/data/types";

export const board: Board = {
  updated_at: "2026-11-23T15:00:00Z",
  decisions: [
    {
      id: "sample-preview",
      title: "Website preview rollout",
      context: "The redesign is ready for a preview. The team can invite a small group before making it public.",
      question: "Who should see the preview first?",
      what_happens_after: "The assistant sends the preview link to the selected group.",
      options: [{ id: "team", label: "Internal team" }, { id: "pilot", label: "Pilot customers" }],
      card_ref: "https://example.com/preview",
      blocking: false,
      priority: "high",
      created_at: "2026-11-23T14:00:00Z",
    },
  ],
  glance: {
    waiting: [
      { title: "Fix checkout retry", who: "Waiting on CI", link: "https://github.com/acme/example-api/pull/11", base: "main" },
      { title: "Summarize build alerts", who: "Waiting on review", link: "https://github.com/acme/example-api/pull/731", hot: true },
      { title: "Add the preview banner", who: "Ready for QA", link: "https://github.com/acme/example-web/pull/14", base: "project" },
      { title: "Document preview commands", who: "Waiting on approval", link: "https://github.com/acme/example-tools/pull/3" },
    ],
    others: [{ title: "Update pricing page copy", author: "bob", who: "Your review requested", link: "https://github.com/acme/example-web/pull/42" }],
    tickets: [{ id: "PROJ-118", title: "Add a cookie banner", status: "To Do", link: "https://example.com/tickets/PROJ-118" }],
  },
};
