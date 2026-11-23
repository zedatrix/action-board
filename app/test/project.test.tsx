// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { project } from "../src/data/project";
import { projectTotals, zonedTime } from "../src/project";
import { ProjectTab, ProjectTabLabel } from "../src/ProjectTab";

afterEach(cleanup);

const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);

describe("project.ts", () => {
  it("holds 4 example milestones whose done + left = total and in_progress <= left", () => {
    expect(project.title).toBe("Website relaunch");
    expect(project.milestones).toHaveLength(4);
    for (const m of project.milestones) {
      expect(m.done + m.left).toBe(m.total);
      expect(m.in_progress).toBeLessThanOrEqual(m.left);
      expect(m.url).toBe(`https://example.com/tickets/${m.id}`);
    }
    expect(project.parent).toEqual({ id: "PROJ-100", url: "https://example.com/tickets/PROJ-100" });
  });

  it("sums to 23 done, 4 in progress, 21 left, 44 total", () => {
    expect(projectTotals(project.milestones)).toEqual({ done: 23, in_progress: 4, left: 21, total: 44 });
  });
});

describe("zonedTime", () => {
  it("formats in the board's time zone (default America/New_York) with a plain space before PM", () => {
    expect(zonedTime("2026-11-23T18:35:00Z")).toBe("Nov 23, 2026, 1:35 PM EST");
    expect(zonedTime("2026-07-04T04:05:00Z")).toBe("Jul 4, 2026, 12:05 AM EDT");
  });
  it("shows an unparseable stamp as written", () => {
    expect(zonedTime("soon")).toBe("soon");
  });
});

describe("ProjectTab", () => {
  it("uses the stored title as the heading and the tab label", () => {
    render(<ProjectTab />);
    expect(screen.getByRole("heading", { name: /Website relaunch\s*4/ })).toBeTruthy();
    cleanup();
    render(<ProjectTabLabel />);
    expect(document.body.textContent).toBe("Website relaunch");
  });

  it("renders one row per milestone and a bold total row summed from them", () => {
    render(<ProjectTab />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Milestone", "Done", "In progress", "Left", "Total"]);
    const [body, foot] = [table.querySelector("tbody")!, table.querySelector("tfoot")!];
    const lines = within(body).getAllByRole("row");
    expect(lines).toHaveLength(4);
    expect(cells(lines[0])).toEqual(["12", "0", "0", "12"]);
    expect(cells(lines[1])).toEqual(["9", "3", "6", "15"]);
    const total = within(foot).getByRole("row");
    expect(within(total).getByRole("rowheader").textContent).toBe("All milestones");
    expect(cells(total)).toEqual(["23", "4", "21", "44"]);
    expect(total.className).toBe("project-total");
  });

  it("links each milestone name, with its ticket id, to its ticket in a new tab", () => {
    render(<ProjectTab />);
    const lines = within(screen.getByRole("table").querySelector("tbody")!).getAllByRole("row");
    project.milestones.forEach((m, n) => {
      const link = within(lines[n]).getByRole("link");
      expect(link.textContent).toBe(`${m.key} ${m.title}${m.id}`);
      expect(link.getAttribute("href")).toBe(m.url);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener");
    });
    const m1 = screen.getByRole("link", { name: /M1 Design and content/ });
    expect(m1.querySelector(".project-name")!.textContent).toBe("M1 Design and content");
    expect(m1.querySelector(".project-id")!.textContent).toBe("PROJ-101");
  });

  it("shows the counting note and the last update in the board's time zone", () => {
    render(<ProjectTab />);
    expect(screen.getByText(/Left includes in progress\. Duplicate and canceled tickets excluded\./)).toBeTruthy();
    const time = document.querySelector("time")!;
    expect(time.textContent).toBe("Nov 23, 2026, 1:35 PM EST");
    expect(time.getAttribute("dateTime")).toBe(project.updated_at);
    expect(time.parentElement!.textContent).toContain("Last updated Nov 23, 2026, 1:35 PM EST");
  });
});
