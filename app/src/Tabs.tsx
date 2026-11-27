import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import App from "./App";
import { ProjectTab } from "./ProjectTab";
import { project } from "./data/project";
import { isEditableTarget, tabIndexForKey } from "./tabKeys";

declare global {
  interface Window {
    // For the desktop app's Go menu (desktop/main.js): the tab labels in order, and select by index.
    actionBoardTabs?: { labels(): string[]; select(i: number): boolean };
  }
}

type TabId = "board" | "prs" | "project";
const TABS: { id: TabId; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "prs", label: "PRs" },
  { id: "project", get label() { return project.title; } },
];

// #prs opens the PRs tab and #project the project tab; no hash (or any other) is the Board.
const fromHash = (): TabId => TABS.find((t) => t.id !== "board" && window.location.hash === `#${t.id}`)?.id ?? "board";

// The page: a tab bar, then the Board (App), the PRs tab or the project tab. The Board stays mounted
// while hidden, so open composers, typed text and the live feed survive a switch. App also fills the PRs
// panel (see App), so PR entries share the Board's live feed and composers.
export default function Tabs() {
  const [tab, setTab] = useState<TabId>(fromHash);
  const [prsPanel, setPrsPanel] = useState<HTMLDivElement | null>(null);
  const buttons = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (next: TabId, focus = false) => {
    setTab(next);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", next === "board" ? pathname + search : `#${next}`);
    if (focus) buttons.current[next]?.focus();
  };

  // Cmd-1..9 open the tabs in TABS order (Cmd-1 is the first tab), except while typing in a field.
  // The desktop app's Go menu calls window.actionBoardTabs.select, which refuses the same way.
  useEffect(() => {
    const typing = (target: EventTarget | null) => isEditableTarget(target) || isEditableTarget(document.activeElement);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      const i = tabIndexForKey(e, TABS.length);
      if (i === null) return;
      e.preventDefault();
      select(TABS[i].id);
    };
    window.addEventListener("keydown", onKey);
    window.actionBoardTabs = {
      labels: () => TABS.map((t) => t.label),
      select: (i) => {
        if (!Number.isInteger(i) || i < 0 || i >= TABS.length || typing(null)) return false;
        select(TABS[i].id);
        return true;
      },
    };
    return () => {
      window.removeEventListener("keydown", onKey);
      delete window.actionBoardTabs;
    };
  }, []);

  // Arrow keys, Home and End move between tabs (and select), per the WAI-ARIA tabs pattern.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(TABS[(to + TABS.length) % TABS.length].id, true);
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              buttons.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-board" className="tabpanel" aria-labelledby="tab-board" hidden={tab !== "board"}>
        <App prsPanel={prsPanel} />
      </div>
      <div ref={setPrsPanel} role="tabpanel" id="panel-prs" className="tabpanel" aria-labelledby="tab-prs" hidden={tab !== "prs"} />
      <div role="tabpanel" id="panel-project" className="tabpanel" aria-labelledby="tab-project" hidden={tab !== "project"}>
        <ProjectTab />
      </div>
    </>
  );
}
