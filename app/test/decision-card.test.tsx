// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/data/types";
import { DecisionCard } from "../src/DecisionCard";

const base: Decision = {
  id: "merge-42",
  card_ref: "PROJ-4382",
  question: "Merge now or wait?",
  what_happens_after: "The assistant merges it.",
  options: [
    { id: "merge", label: "Merge now" },
    { id: "wait", label: "Wait for Riley" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
};
const multi: Decision = {
  ...base,
  id: "notify-1550",
  options: [
    { id: "riley", label: "Riley" },
    { id: "kai", label: "Kai" },
    { id: "blake", label: "Blake" },
  ],
  multiSelect: true,
};

afterEach(cleanup);

function renderCard(decision: Decision) {
  const onAnswer = vi.fn();
  render(<DecisionCard decision={decision} index={1} onAnswer={onAnswer} />);
  return onAnswer;
}

describe("DecisionCard: single select", () => {
  it("answers with one click and has no Submit button", () => {
    const onAnswer = renderCard(base);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wait for Riley" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(base, "wait");
  });
});

describe("DecisionCard: blocks", () => {
  it("shows Blocks: <text> only when the card has blocks", () => {
    renderCard({ ...base, blocking: true, priority: "high", blocks: "Signing the Q3 hosting contract" });
    expect(screen.getByText("Blocks: Signing the Q3 hosting contract")).toBeTruthy();
    cleanup();
    renderCard(base);
    expect(screen.queryByText(/^Blocks:/)).toBeNull();
  });
});

describe("DecisionCard: multi select", () => {
  it("toggles options with aria-pressed and keeps Submit disabled until something is picked", () => {
    const onAnswer = renderCard(multi);
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    const blake = screen.getByRole("button", { name: "Blake" });
    const riley = screen.getByRole("button", { name: "Riley" });
    expect(submit.disabled).toBe(true);
    expect(blake.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(submit);
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.click(blake);
    expect(blake.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(false);
    fireEvent.click(blake);
    expect(blake.getAttribute("aria-pressed")).toBe("false");
    expect(submit.disabled).toBe(true);

    fireEvent.click(blake);
    fireEvent.click(riley);
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][1]).toEqual(["blake", "riley"]);
  });
});

describe("DecisionCard: free text", () => {
  it("shows the field when allowCustom is missing or true, and hides it when false", () => {
    renderCard(base);
    expect(screen.getByRole("textbox", { name: "Your own answer" })).toBeTruthy();
    cleanup();
    renderCard({ ...base, allowCustom: true });
    expect(screen.getByRole("textbox", { name: "Your own answer" })).toBeTruthy();
    cleanup();
    renderCard({ ...base, allowCustom: false });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });

  it("rejects blank and whitespace-only text, and sends trimmed text", () => {
    const onAnswer = renderCard(multi);
    const input = screen.getByRole("textbox", { name: "Your own answer" });
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "   \t " } });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    fireEvent.submit(input.closest("form")!);
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  Ask Sage instead  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(multi, { custom: "Ask Sage instead" });
  });
});

describe("DecisionCard: details", () => {
  const detailed: Decision = {
    ...base,
    details: [
      "Reads CRM contacts nightly",
      "Writes nothing back",
      { label: "Defaults", items: ["Sync every 24h", "Read-only"] },
      { label: "Tradeoffs", ordered: true, items: ["Cheaper", "Slower to show changes"] },
    ],
  };
  const items = (list: Element) => [...list.querySelectorAll("li")].map((li) => li.textContent);

  it("groups consecutive bare strings into one unlabeled bullet list", () => {
    const { container } = render(<DecisionCard decision={detailed} index={1} onAnswer={vi.fn()} />);
    const blocks = container.querySelectorAll(".details > .details-block");
    expect(blocks.length).toBe(3);
    expect(blocks[0].querySelector(".details-label")).toBeNull();
    expect(blocks[0].querySelector("ul")).not.toBeNull();
    expect(items(blocks[0])).toEqual(["Reads CRM contacts nightly", "Writes nothing back"]);
  });

  it("renders labeled sections as bullets, or numbered when ordered", () => {
    const { container } = render(<DecisionCard decision={detailed} index={1} onAnswer={vi.fn()} />);
    const [, defaults, tradeoffs] = container.querySelectorAll(".details > .details-block");
    expect(defaults.querySelector(".details-label")?.textContent).toBe("Defaults");
    expect(defaults.querySelector("ul")).not.toBeNull();
    expect(defaults.querySelector("ol")).toBeNull();
    expect(items(defaults)).toEqual(["Sync every 24h", "Read-only"]);
    expect(tradeoffs.querySelector(".details-label")?.textContent).toBe("Tradeoffs");
    expect(tradeoffs.querySelector("ol")).not.toBeNull();
    expect(items(tradeoffs)).toEqual(["Cheaper", "Slower to show changes"]);
  });

  it("sits between the question and After you answer", () => {
    const { container } = render(<DecisionCard decision={detailed} index={1} onAnswer={vi.fn()} />);
    const details = container.querySelector(".details")!;
    expect(details.previousElementSibling?.className).toBe("card-top");
    expect(details.nextElementSibling?.className).toBe("after");
  });

  it("renders no details element, and the same DOM, when details is absent", () => {
    const { container } = render(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} />);
    expect(container.querySelector(".details")).toBeNull();
    expect(container.querySelector("ul, ol, li")).toBeNull();
    expect(container.querySelector(".card-top")?.nextElementSibling?.className).toBe("after");
  });

  it("skips malformed entries from a bad board edit instead of crashing", () => {
    const bad = { ...base, details: ["ok", 7, null, { label: "", items: ["x"] }, { label: "L", items: "nope" }] } as unknown as Decision;
    const { container } = render(<DecisionCard decision={bad} index={1} onAnswer={vi.fn()} />);
    expect(items(container.querySelector(".details")!)).toEqual(["ok"]);
    cleanup();
    const notArray = { ...base, details: "text" } as unknown as Decision;
    const r = render(<DecisionCard decision={notArray} index={1} onAnswer={vi.fn()} />);
    expect(r.container.querySelector(".details")).toBeNull();
  });
});

describe("DecisionCard: context", () => {
  const context =
    "Ticket PROJ-5054 asks for a required asterisk on the Address field of the employee emergency contact form. Product (Quinlan) says Address is optional.";

  it("renders the context first, above the question", () => {
    const { container } = render(<DecisionCard decision={{ ...base, context }} index={1} onAnswer={vi.fn()} />);
    const el = container.querySelector(".context")!;
    expect(el.textContent).toBe(context);
    expect(container.querySelector(".card")!.firstElementChild).toBe(el);
    expect(el.nextElementSibling?.className).toBe("card-top");
    expect(el.compareDocumentPosition(screen.getByText(base.question)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no context element when context is absent or blank", () => {
    const { container } = render(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} />);
    expect(container.querySelector(".context")).toBeNull();
    expect(container.querySelector(".card")!.firstElementChild?.className).toBe("card-top");
    cleanup();
    const r = render(<DecisionCard decision={{ ...base, context: "  " }} index={1} onAnswer={vi.fn()} />);
    expect(r.container.querySelector(".context")).toBeNull();
  });
});

describe("DecisionCard: title", () => {
  const title = "Checkout guarded write merge order";
  const context = "Two checkout PRs touch the guarded write path and must merge in one order.";

  it("renders the title as the first element, a bold h3 above the context", () => {
    const { container } = render(<DecisionCard decision={{ ...base, title, context }} index={1} onAnswer={vi.fn()} />);
    const el = container.querySelector(".card-title")!;
    expect(el.tagName).toBe("H3");
    expect(el.textContent).toBe(title);
    expect(el.id).toBe("t-merge-42");
    expect(container.querySelector(".card")!.firstElementChild).toBe(el);
    expect(el.nextElementSibling?.className).toBe("context");
    expect(screen.getByRole("heading", { level: 3, name: title })).toBe(el);
  });

  it("is plain text: a URL in the title is not linked", () => {
    const { container } = render(<DecisionCard decision={{ ...base, title: "Billing banner https://example.com/pr/2" }} index={1} onAnswer={vi.fn()} />);
    expect(container.querySelector(".card-title a")).toBeNull();
  });

  it("labels the card by title and question when there is a title", () => {
    render(<DecisionCard decision={{ ...base, title }} index={1} onAnswer={vi.fn()} />);
    const card = screen.getByRole("article");
    expect(card.getAttribute("aria-labelledby")).toBe("t-merge-42 q-merge-42");
    expect(screen.getByRole("article", { name: `${title} ${base.question}` })).toBe(card);
  });

  it("renders no title and labels by the question alone when title is absent or blank", () => {
    const { container } = render(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} />);
    expect(container.querySelector(".card-title")).toBeNull();
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector(".card")!.getAttribute("aria-labelledby")).toBe("q-merge-42");
    expect(container.querySelector(".card")!.firstElementChild?.className).toBe("card-top");
    cleanup();
    const r = render(<DecisionCard decision={{ ...base, title: "   " }} index={1} onAnswer={vi.fn()} />);
    expect(r.container.querySelector(".card-title")).toBeNull();
    expect(r.container.querySelector(".card")!.getAttribute("aria-labelledby")).toBe("q-merge-42");
  });
});

describe("DecisionCard: when it came in", () => {
  // Fri Nov 13 2026, 10:00 AM Eastern.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T15:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const stampOn = (decision: Decision) => {
    const { container } = render(<DecisionCard decision={decision} index={1} onAnswer={vi.fn()} />);
    return container.querySelector(".stamp");
  };

  it("shows added with the Eastern time today, in the question row", () => {
    const el = stampOn({ ...base, created_at: "2026-11-13T14:14:00.000Z", updated_at: "2026-11-13T14:14:00.000Z" })!;
    expect(el.textContent).toBe("added 9:14 AM");
    expect(el.parentElement?.className).toBe("card-meta");
    expect(el.parentElement?.parentElement?.className).toBe("card-top");
    expect(el.nextElementSibling?.className).toBe("priority");
    expect(el.nextElementSibling?.nextElementSibling?.textContent).toBe("Explain this better");
    const time = el.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe("2026-11-13T14:14:00.000Z");
    expect(time.getAttribute("title")).toBe("Fri, Nov 13, 2026, 9:14 AM EST");
  });

  it("shows updated with the date when the newer stamp is from another day", () => {
    const el = stampOn({ ...base, created_at: "2026-11-10T09:00:00.000Z", updated_at: "2026-11-12T19:40:00.000Z" })!;
    expect(el.textContent).toBe("updated Nov 12, 2:40 PM");
    expect(el.querySelector("time")!.getAttribute("dateTime")).toBe("2026-11-12T19:40:00.000Z");
  });

  it("renders no stamp element when the card has no usable stamp", () => {
    expect(stampOn({ ...base, created_at: undefined } as unknown as Decision)).toBeNull();
    cleanup();
    expect(stampOn({ ...base, created_at: "garbage", updated_at: "" })).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });
});

describe("DecisionCard: Explain this better", () => {
  it("is a .clarify-btn named exactly Explain this better, with an aria-hidden sparkle", () => {
    render(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Explain this better" });
    expect(btn.classList.contains("clarify-btn")).toBe(true);
    expect(btn.textContent).toBe("Explain this better");
    const icons = btn.querySelectorAll("svg");
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("aria-hidden")).toBe("true");
    expect(icons[0].textContent).toBe("");
  });
});

describe("DecisionCard: links", () => {
  const pr = "https://github.com/acme/example/pull/1800";
  const card = (decision: Decision) => render(<DecisionCard decision={decision} index={1} onAnswer={vi.fn()} />).container;
  const expectNewTab = (a: Element | null | undefined, href: string) => {
    expect(a?.tagName).toBe("A");
    expect(a!.getAttribute("href")).toBe(href);
    expect(a!.textContent).toBe(href);
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
  };

  it("makes a URL card_ref the .evidence link itself", () => {
    const c = card({ ...base, card_ref: pr });
    const ev = c.querySelector(".evidence");
    expectNewTab(ev, pr);
    expect(ev!.className).toBe("evidence");
    expect(ev!.querySelector("a")).toBeNull();
  });

  it("keeps a non-URL card_ref as a plain span with the same text", () => {
    const ev = card(base).querySelector(".evidence")!;
    expect(ev.tagName).toBe("SPAN");
    expect(ev.textContent).toBe("PROJ-4382");
    expect(ev.querySelector("a")).toBeNull();
  });

  it("puts the card_ref and Not relevant anymore in the footer row, the card's last child", () => {
    const c = card({ ...base, card_ref: pr }).querySelector("article")!;
    const foot = c.lastElementChild!;
    expect(foot.className).toBe("card-foot");
    expect([...foot.children].map((e) => e.className)).toEqual(["evidence", "not-relevant"]);
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Not relevant anymore"]);
    // Without a card_ref the control is still there, alone in the row.
    const bare = card({ ...base, id: "bare-1", card_ref: null }).querySelector("article")!;
    expect([...bare.lastElementChild!.children].map((e) => e.className)).toEqual(["not-relevant"]);
  });

  it("calls onNotRelevant with the decision, and disables the control while clearing", () => {
    const onNotRelevant = vi.fn();
    const { rerender, container } = render(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} onNotRelevant={onNotRelevant} />);
    const b = () => container.querySelector<HTMLButtonElement>(".not-relevant-btn")!;
    fireEvent.click(b());
    expect(onNotRelevant).toHaveBeenCalledWith(base);
    for (const [state, disabled, text] of [
      [{ status: "sending", sent: false }, true, "Clearing..."],
      [{ status: "clearing" }, true, "Clearing..."],
      [{ status: "failed", sent: false }, false, "Could not send. Try again."],
      [{ status: "failed", sent: true }, false, "Sent to your assistant, but could not clear. Try again."],
    ] as const) {
      rerender(<DecisionCard decision={base} index={1} onAnswer={vi.fn()} onNotRelevant={onNotRelevant} notRelevant={state} />);
      expect(b().disabled).toBe(disabled);
      expect(container.querySelector(".not-relevant")!.textContent).toBe(text + "Not relevant anymore");
    }
  });

  it("links a URL inside context and keeps the surrounding text", () => {
    const context = `Backend change is in ${pr} and needs review.`;
    const el = card({ ...base, context }).querySelector(".context")!;
    expect(el.textContent).toBe(context);
    expect(el.querySelectorAll("a").length).toBe(1);
    expectNewTab(el.querySelector("a"), pr);
  });

  it("leaves a trailing period out of the href and link text", () => {
    const el = card({ ...base, context: "See https://example.com/path." }).querySelector(".context")!;
    const a = el.querySelector("a")!;
    expectNewTab(a, "https://example.com/path");
    expect(a.nextSibling?.textContent).toBe(".");
    expect(el.textContent).toBe("See https://example.com/path.");
  });

  it("links URLs in the question, details items and labels, and After you answer", () => {
    const c = card({
      ...base,
      question: `Merge ${pr}?`,
      details: ["Plain item", "Spec: https://example.com/spec, page 2", { label: "From https://example.com/l", items: ["x"] }],
      what_happens_after: "The assistant posts to https://example.com/after.",
    });
    const q = c.querySelector(".question")!;
    expect(q.textContent).toBe(`Merge ${pr}?`);
    expectNewTab(q.querySelector("a"), pr);
    const lis = c.querySelectorAll(".details li");
    expect(lis[0].textContent).toBe("Plain item");
    expect(lis[0].querySelector("a")).toBeNull();
    expect(lis[1].textContent).toBe("Spec: https://example.com/spec, page 2");
    expectNewTab(lis[1].querySelector("a"), "https://example.com/spec");
    expectNewTab(c.querySelector(".details-label a"), "https://example.com/l");
    expectNewTab(c.querySelector(".after a"), "https://example.com/after");
  });

  it("adds no links to text without URLs", () => {
    const context = "Ticket PROJ-5054 asks for a required asterisk. Product (Quinlan) says Address is optional.";
    expect(card({ ...base, context }).querySelector("a")).toBeNull();
  });
});
