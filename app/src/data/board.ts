import type { Board } from "./types";
// An example board. Edit freely, but prefer bin/ab.mjs: it validates, locks and stamps every write.
// Everything between the two marker lines must stay valid JSON.
// Shape (types in ./types.ts):
//   { updated_at, decisions: Decision[], glance: { waiting, tickets, others } }
//   Decision: { id, title, context, question, details?, what_happens_after, options: [{ id, label }], card_ref (string or null),
//               multiSelect?, allowCustom?, priority?, created_at, updated_at?, answer? }
//   multiSelect: true makes options toggle with a Submit button; missing or false means one click answers.
//   allowCustom: missing means true (a free-text answer field shows); only false hides it.
//   priority: "high", "medium" or "low"; missing means medium.
//   answer: { answer, answer_label, answered_by: "chat" | "app", answered_at, custom_text? }, one of three shapes:
//     single  answer = option id,             answer_label = its label
//     multi   answer = [option ids],          answer_label = [labels], both in option order
//     custom  answer = "custom",              answer_label = the text, custom_text = the same text
//   A decision with any answer is hidden from "Needs you". The file's answer wins over the app's.
export const board: Board =
/* BOARD-JSON-START */
{
  "updated_at": "2026-11-23T15:00:00.000Z",
  "decisions": [
    {
      "id": "vendor-contract-q3",
      "title": "Q3 vendor contract renewal",
      "context": "The hosting vendor sent the Q3 contract. It renews at the same monthly price but adds a 12 month minimum term.",
      "question": "Approve the Q3 vendor contract?",
      "what_happens_after": "The assistant signs the contract and files it, or tells the vendor it is on hold.",
      "options": [
        {
          "id": "approve",
          "label": "Approve"
        },
        {
          "id": "hold",
          "label": "Hold for now"
        },
        {
          "id": "negotiate",
          "label": "Ask for a shorter term"
        }
      ],
      "card_ref": "https://example.com/contracts/q3-hosting",
      "priority": "high",
      "blocking": true,
      "blocks": "Signing the Q3 hosting contract before the vendor deadline",
      "created_at": "2026-11-23T14:00:00.000Z",
      "updated_at": "2026-11-23T14:00:00.000Z"
    },
    {
      "id": "launch-post-day",
      "title": "Launch blog post timing",
      "context": "The launch blog post for the new website is written and approved by marketing. It can go out with the launch or two days later.",
      "question": "Publish the launch blog post on Tuesday or Thursday?",
      "details": [
        "Tuesday is launch day",
        {
          "label": "Thursday",
          "items": [
            "Gives support two days to settle",
            "Misses the launch newsletter"
          ]
        }
      ],
      "what_happens_after": "The assistant schedules the post for the day you pick.",
      "options": [
        {
          "id": "tuesday",
          "label": "Tuesday"
        },
        {
          "id": "thursday",
          "label": "Thursday"
        }
      ],
      "card_ref": null,
      "priority": "medium",
      "blocking": false,
      "created_at": "2026-11-23T14:10:00.000Z",
      "updated_at": "2026-11-23T14:10:00.000Z"
    },
    {
      "id": "offsite-venue-quotes",
      "title": "Team offsite venue quotes",
      "context": "The team offsite is planned for March. Three venues have dates open and none have sent prices yet.",
      "question": "Which offsite venues should the assistant ask for quotes?",
      "what_happens_after": "The assistant emails each venue you pick for a quote.",
      "options": [
        {
          "id": "lakeside",
          "label": "Lakeside lodge"
        },
        {
          "id": "downtown",
          "label": "Downtown loft"
        },
        {
          "id": "farm",
          "label": "Farm retreat"
        }
      ],
      "multiSelect": true,
      "card_ref": null,
      "priority": "low",
      "blocking": false,
      "created_at": "2026-11-23T14:20:00.000Z",
      "updated_at": "2026-11-23T14:20:00.000Z"
    }
  ],
  "glance": {
    "waiting": [
      {
        "title": "Signed NDA from the design agency",
        "who": "Waiting on the agency",
        "link": "https://example.com/docs/nda"
      },
      {
        "title": "Q4 budget numbers",
        "who": "Waiting on finance"
      }
    ],
    "tickets": [
      {
        "id": "PROJ-118",
        "title": "Add a cookie banner to the new site",
        "status": "To Do",
        "link": "https://example.com/tickets/PROJ-118"
      },
      {
        "id": "PROJ-121",
        "title": "Fix the broken footer links",
        "status": "In Review",
        "link": "https://example.com/tickets/PROJ-121"
      }
    ],
    "others": [
      {
        "title": "Update the pricing page copy (#42)",
        "author": "Sam",
        "who": "Your review requested",
        "link": "https://github.com/acme/example/pull/42"
      },
      {
        "title": "Move images to the CDN (#40)",
        "author": "Jordan",
        "who": "You reviewed, waiting on Jordan",
        "link": "https://github.com/acme/example/pull/40"
      }
    ]
  }
}
/* BOARD-JSON-END */
;
