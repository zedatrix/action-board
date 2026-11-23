import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import App from "./App";
import { ProjectTab, ProjectTabLabel } from "./ProjectTab";

type TabId = "board" | "project";
const TABS: { id: TabId; label: ReactNode }[] = [
  { id: "board", label: "Board" },
  // The project tab's label is the title stored in data/project.ts.
  { id: "project", label: <ProjectTabLabel /> },
];

// #project opens the project tab; no hash (or any other) is the Board.
const fromHash = (): TabId => (window.location.hash === "#project" ? "project" : "board");

// The page: a tab bar, then the Board (App, unchanged) or the project tab. The Board stays mounted
// while hidden, so open composers, typed text and the live feed survive a switch.
export default function Tabs() {
  const [tab, setTab] = useState<TabId>(fromHash);
  const buttons = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (next: TabId, focus = false) => {
    setTab(next);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", next === "project" ? "#project" : pathname + search);
    if (focus) buttons.current[next]?.focus();
  };

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
        <App />
      </div>
      <div role="tabpanel" id="panel-project" className="tabpanel" aria-labelledby="tab-project" hidden={tab !== "project"}>
        <ProjectTab />
      </div>
    </>
  );
}
