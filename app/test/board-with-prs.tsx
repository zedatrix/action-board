import { useState, type ComponentType } from "react";

// The Board (App) with its PRs tab panel after it, both shown, wired the way Tabs wires them. Takes App as an
// argument because tests import it after mocking the board.
export function withPrs(App: ComponentType<{ prsPanel?: HTMLElement | null }>) {
  return function BoardAndPrs() {
    const [panel, setPanel] = useState<HTMLDivElement | null>(null);
    return (
      <>
        <App prsPanel={panel} />
        <div id="panel-prs" ref={setPanel} />
      </>
    );
  };
}

// The PRs panel and its section headings ("Hotfixes 0", ...), in order.
export const prsPanel = () => document.getElementById("panel-prs")!;
export const sectionHeadings = () => [...prsPanel().querySelectorAll(".panel h3")].map((h) => h.textContent?.replace(/\s+/g, " ").trim());
