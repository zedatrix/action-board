import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { board as bundledBoard } from "./data/board";
import type { Board, Decision, Priority } from "./data/types";
import { DecisionCard, type ClarifyState, type NotRelevantState } from "./DecisionCard";
import {
  buildClarifyPayload,
  buildNotRelevantPayload,
  buildPayload,
  choiceText,
  CLEAR_PATH,
  createDelivery,
  deliveryMarker,
  FALLBACK_PATH,
  loadAnswers,
  loadMessages,
  MESSAGES_KEY,
  STORAGE_KEY,
  type AppAnswers,
  type AppChoice,
  type AppMessages,
  type MessageRecord,
} from "./delivery";
import { buildMessagePayload, glanceItem, itemKey, newMessageId, type BoardItem, type GlanceSection } from "./messages";
import { MessageAssistant, type Draft } from "./MessageAssistant";
import { sortOthers } from "./others";
import { effectivePriority, groupByPriority, PRIORITY_LABEL, PRIORITY_PATH, sortByPriority } from "./priority";
import { headerDate } from "./stamp";
import { useLiveBoard } from "./useLiveBoard";
import { useNow } from "./useNow";
import { needsYou } from "./visibility";

const TOAST_MS = 5000;
const WEBHOOK_URL = import.meta.env.ACTION_BOARD_WEBHOOK_URL || undefined;
const WEBHOOK_AUTH = import.meta.env.ACTION_BOARD_WEBHOOK_AUTH || undefined;

type Toast = { id: number; text: string };

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// The card for "Explain this better" comparisons: a priority change is not a rewording.
const withoutPriority = ({ priority: _priority, ...rest }: Decision) => JSON.stringify(rest);

export default function App() {
  const board = useLiveBoard(bundledBoard);
  // One clock for every card's stamp and the header date, ticking each minute.
  const now = useNow();
  const [answers, setAnswers] = useState<AppAnswers>(() => loadAnswers(window.localStorage));
  const [messages, setMessages] = useState<AppMessages>(() => loadMessages(window.localStorage));
  // Open composers by itemKey, so typed text survives live board updates and reorders.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  // "Explain this better" per decision id, so it survives live updates and reorders.
  const [clarifying, setClarifying] = useState<Record<string, ClarifyState>>({});
  // Ids with a clarify POST in flight; a ref so two clicks in the same tick still send one request.
  const clarifyInFlight = useRef(new Set<string>());
  // Priority taps shown before the live board has them, by decision id; dropped once the board agrees.
  const [priorityOverride, setPriorityOverride] = useState<Record<string, Priority>>({});
  // Ids whose last priority save failed, for the card's error line.
  const [priorityFailed, setPriorityFailed] = useState<Record<string, true>>({});
  // Ids with a priority POST in flight: a ref for the same-tick guard, state so the override check reruns when one ends.
  const priorityInFlight = useRef(new Set<string>());
  const [prioritySaving, setPrioritySaving] = useState<Record<string, true>>({});
  // "Not relevant anymore" per decision id. The refs: ids with a try in flight (two taps in one tick send one
  // webhook POST), and ids whose webhook already got a 2xx (a retry then only clears).
  const [notRelevant, setNotRelevant] = useState<Record<string, NotRelevantState>>({});
  const notRelevantInFlight = useRef(new Set<string>());
  const notRelevantSent = useRef(new Set<string>());

  const delivery = useMemo(
    () =>
      createDelivery({
        fetch: window.fetch.bind(window),
        sleep,
        storage: window.localStorage,
        webhookUrl: WEBHOOK_URL,
        webhookAuth: WEBHOOK_AUTH,
        fallbackUrl: FALLBACK_PATH,
        onChange: setAnswers,
        onMessagesChange: setMessages,
      }),
    [],
  );

  // On load, after every live update of board.ts, and when the window comes back:
  // drop app answers the file has taken over, then retry any answer or message not yet delivered.
  useEffect(() => {
    const retry = () => {
      void delivery.deliverPending(board);
      void delivery.deliverPendingMessages();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAnswers(loadAnswers(window.localStorage));
      if (e.key === MESSAGES_KEY) setMessages(loadMessages(window.localStorage));
    };
    retry();
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [delivery, board]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  const choose = useCallback(
    (decision: Decision, pick: AppChoice) => {
      let payload;
      try {
        payload = buildPayload(decision, pick, new Date());
      } catch {
        return; // The card only offers valid picks; ignore anything else rather than record it.
      }
      toast(`Answered: ${choiceText(payload)}`);
      void delivery.answer(payload);
    },
    [delivery, toast],
  );

  const requestClarify = useCallback(
    (decision: Decision) => {
      const id = decision.id;
      if (clarifyInFlight.current.has(id) || clarifying[id]?.status === "rewording") return;
      clarifyInFlight.current.add(id);
      // The card as it was at click time; Rewording... lasts until the live board changes it (priority aside).
      const snapshot = withoutPriority(decision);
      setClarifying((cs) => ({ ...cs, [id]: { status: "sending" } }));
      void delivery.clarify(buildClarifyPayload(decision, new Date())).then(({ ok, http }) => {
        clarifyInFlight.current.delete(id);
        setClarifying((cs) => ({ ...cs, [id]: ok ? { status: "rewording", snapshot } : { status: "failed", http } }));
      });
    },
    [delivery, clarifying],
  );

  // Rewording... ends once the live board changes that decision (a re-raise), answers it or drops it.
  useEffect(() => {
    setClarifying((cs) => {
      const byId = new Map(board.decisions.map((d) => [d.id, d]));
      const done = Object.keys(cs).filter((id) => {
        const c = cs[id];
        if (c.status !== "rewording") return false;
        const d = byId.get(id);
        return !d || Boolean(d.answer) || withoutPriority(d) !== c.snapshot;
      });
      if (done.length === 0) return cs;
      const next = { ...cs };
      for (const id of done) delete next[id];
      return next;
    });
  }, [board, clarifying]);

  // Priority tap: show the new level at once (the queue re-sorts), save it through the dev server's
  // `ab priority`, and put the old level back with an error line if that fails. One save per card at a time.
  const changePriority = useCallback((decision: Decision, level: Priority) => {
    const id = decision.id;
    if (priorityInFlight.current.has(id) || effectivePriority(decision) === level) return;
    priorityInFlight.current.add(id);
    setPrioritySaving((s) => ({ ...s, [id]: true }));
    setPriorityOverride((o) => ({ ...o, [id]: level }));
    setPriorityFailed((f) => {
      if (!f[id]) return f;
      const next = { ...f };
      delete next[id];
      return next;
    });
    const without = <T,>(r: Record<string, T>) => {
      const next = { ...r };
      delete next[id];
      return next;
    };
    window
      .fetch(PRIORITY_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, priority: level }) })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        priorityInFlight.current.delete(id);
        setPrioritySaving(without);
        if (ok) return;
        setPriorityOverride(without);
        setPriorityFailed((f) => ({ ...f, [id]: true }));
      });
  }, []);

  // An override ends once the live board shows that level for the card (or the card is gone), after its save returned.
  useEffect(() => {
    setPriorityOverride((o) => {
      const byId = new Map(board.decisions.map((d) => [d.id, d]));
      const done = Object.keys(o).filter((id) => {
        if (prioritySaving[id]) return false;
        const d = byId.get(id);
        return !d || effectivePriority(d) === o[id];
      });
      if (done.length === 0) return o;
      const next = { ...o };
      for (const id of done) delete next[id];
      return next;
    });
  }, [board, prioritySaving]);

  // "Not relevant anymore": tell the assistant first (decision.not_relevant, with the usual retries and fallback), and only
  // after a 2xx clear the card through the dev server's `ab clear`. The card stays, with Clearing..., until the live
  // board drops it. A failure re-enables the control; after a sent webhook, the retry only clears.
  const markNotRelevant = useCallback(
    (decision: Decision) => {
      const id = decision.id;
      if (notRelevantInFlight.current.has(id) || notRelevant[id]?.status === "clearing") return;
      notRelevantInFlight.current.add(id);
      const sent = notRelevantSent.current.has(id);
      setNotRelevant((s) => ({ ...s, [id]: { status: "sending", sent } }));
      const tellAssistant = sent ? Promise.resolve(true) : delivery.notRelevant(buildNotRelevantPayload(decision, new Date())).then((r) => r.ok);
      void tellAssistant
        .then(async (ok): Promise<NotRelevantState> => {
          if (!ok) return { status: "failed", sent: false };
          notRelevantSent.current.add(id);
          const cleared = await window
            .fetch(CLEAR_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
            .then((r) => r.ok)
            .catch(() => false);
          return cleared ? { status: "clearing" } : { status: "failed", sent: true };
        })
        .then((next) => {
          notRelevantInFlight.current.delete(id);
          setNotRelevant((s) => ({ ...s, [id]: next }));
        });
    },
    [delivery, notRelevant],
  );

  // A card's not relevant state ends once the live board no longer has it open (cleared, or answered meanwhile).
  useEffect(() => {
    setNotRelevant((s) => {
      const open = new Set(board.decisions.filter((d) => !d.answer).map((d) => d.id));
      const done = Object.keys(s).filter((id) => !open.has(id) && !notRelevantInFlight.current.has(id));
      if (done.length === 0) return s;
      const next = { ...s };
      for (const id of done) {
        delete next[id];
        notRelevantSent.current.delete(id);
      }
      return next;
    });
  }, [board, notRelevant]);

  // A composer closes once its message is delivered (2xx).
  useEffect(() => {
    setDrafts((ds) => {
      const done = Object.keys(ds).filter((k) => ds[k].message_id && messages[ds[k].message_id!]?.status === "delivered");
      if (done.length === 0) return ds;
      const next = { ...ds };
      for (const k of done) delete next[k];
      return next;
    });
  }, [messages]);

  // The newest message for each item, for its "Sent to <assistant>" / retry line.
  const latest = useMemo(() => {
    const byItem = new Map<string, MessageRecord>();
    for (const rec of Object.values(messages)) {
      if (!rec?.payload?.item_id) continue;
      const k = itemKey(rec.payload);
      const prev = byItem.get(k);
      if (!prev || prev.payload.sent_at <= rec.payload.sent_at) byItem.set(k, rec);
    }
    return byItem;
  }, [messages]);

  const openComposer = useCallback((item: BoardItem) => {
    setDrafts((ds) => (ds[itemKey(item)] ? ds : { ...ds, [itemKey(item)]: { text: "" } }));
  }, []);
  const typeDraft = useCallback((item: BoardItem, text: string) => {
    setDrafts((ds) => ({ ...ds, [itemKey(item)]: { ...ds[itemKey(item)], text } }));
  }, []);
  const closeComposer = useCallback((item: BoardItem) => {
    setDrafts((ds) => {
      const next = { ...ds };
      delete next[itemKey(item)];
      return next;
    });
  }, []);
  const sendMessage = useCallback(
    (item: BoardItem, text: string) => {
      let payload;
      try {
        payload = buildMessagePayload(item, text, new Date(), newMessageId());
      } catch {
        return; // Blank text: Send is disabled, so this only guards against a stray submit.
      }
      setDrafts((ds) => ({ ...ds, [itemKey(item)]: { text: payload.text, message_id: payload.message_id } }));
      void delivery.message(payload);
    },
    [delivery],
  );

  const renderMessage = (item: BoardItem) => (
    <MessageAssistant
      item={item}
      draft={drafts[itemKey(item)]}
      latest={latest.get(itemKey(item))}
      webhookConfigured={Boolean(WEBHOOK_URL)}
      onOpen={openComposer}
      onText={typeDraft}
      onClose={closeComposer}
      onSend={sendMessage}
    />
  );

  // High first, then medium, then low; oldest first within a level. Unsaved taps count already.
  // Shown as one section per level that has cards.
  const queue = sortByPriority(
    needsYou(board.decisions, answers).map((d) => (priorityOverride[d.id] ? { ...d, priority: priorityOverride[d.id] } : d)),
  );
  // Without a webhook, pending messages also explain the "not set up" marker.
  const marker = deliveryMarker(WEBHOOK_URL ? answers : { ...answers, ...messages }, Boolean(WEBHOOK_URL));

  return (
    <div className="page">
      <header className="top">
        <h1 className="wordmark">
          <span className="dot" aria-hidden="true" />
          Action Board
        </h1>
        {marker && (
          <span className="marker" role="status">
            {marker}
          </span>
        )}
        <span className="top-meta">{headerDate(now)} · local</span>
      </header>

      <main className="shell">
        <section className="needs-you">
          <h2 className="kicker">
            Needs you <span className="n">{queue.length}</span>
          </h2>
          {queue.length === 0 ? (
            <p className="empty">Nothing needs you right now.</p>
          ) : (
            <>
              <div className="queue">
                {groupByPriority(queue).map(({ level, items }) => (
                  <section key={level} className="priority-section" data-level={level} aria-labelledby={`level-${level}`}>
                    <h3 className="priority-heading" id={`level-${level}`}>
                      {PRIORITY_LABEL[level]} <span className="n">{items.length}</span>
                    </h3>
                    <div className="queue-group">
                      {items.map((d) => (
                        <DecisionCard
                          key={d.id}
                          decision={d}
                          // Numbers run on across sections, in display order.
                          index={queue.indexOf(d) + 1}
                          onAnswer={choose}
                          onClarify={requestClarify}
                          clarify={clarifying[d.id]}
                          now={now}
                          onPriority={changePriority}
                          priorityError={Boolean(priorityFailed[d.id])}
                          onNotRelevant={markNotRelevant}
                          notRelevant={notRelevant[d.id]}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
              <div className="queue-end" aria-hidden="true">
                End of queue
              </div>
            </>
          )}
        </section>

        <GlanceStrip glance={board.glance} renderMessage={renderMessage} />
      </main>

      <footer className="footer">Board updated {new Date(board.updated_at).toLocaleString()}</footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Item({ link, children }: { link?: string; children: ReactNode }) {
  if (!link) return <div className="item">{children}</div>;
  return (
    <a className="item" href={link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Panel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>
        {title} <span className="n">{count}</span>
      </h3>
      {count === 0 ? <p className="panel-empty">Nothing here.</p> : <ul>{children}</ul>}
    </section>
  );
}

type RenderMessage = (item: BoardItem) => ReactNode;

// React keys from item_id, so list items (and their composers) follow the item, not its position.
// A repeated item_id within one list gets a suffix to keep keys unique.
function keyed<T extends NonNullable<Board["glance"][GlanceSection]>[number]>(section: GlanceSection, items: T[]): { key: string; item: T; ref: BoardItem }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const ref = glanceItem(section, item);
    const n = seen.get(ref.item_id) ?? 0;
    seen.set(ref.item_id, n + 1);
    return { key: n ? `${ref.item_id}#${n}` : ref.item_id, item, ref };
  });
}

function Row({ item, link, message, children }: { item: BoardItem; link?: string; message: RenderMessage; children: ReactNode }) {
  return (
    <li className="row" data-item-id={item.item_id} data-item-section={item.item_section}>
      <Item link={link}>{children}</Item>
      {message(item)}
    </li>
  );
}

function GlanceStrip({ glance, renderMessage }: { glance: Board["glance"]; renderMessage: RenderMessage }) {
  // Older files have no others list; treat it as empty.
  const others = sortOthers(glance.others ?? []);
  return (
    <aside className="glance">
      <Panel title="Waiting on others" count={glance.waiting.length}>
        {keyed("waiting", glance.waiting).map(({ key, item: w, ref }) => (
          <Row key={key} item={ref} link={w.link} message={renderMessage}>
            <span className="title">{w.title}</span>
            <span className="meta">{w.who}</span>
          </Row>
        ))}
      </Panel>
      <Panel title="Others' PRs with you" count={others.length}>
        {keyed("others", others).map(({ key, item: o, ref }) => (
          <Row key={key} item={ref} link={o.link} message={renderMessage}>
            <span className="title">{o.title}</span>
            <span className="meta">{`${o.author} · ${o.who}`}</span>
          </Row>
        ))}
      </Panel>
      <Panel title="Tickets with no PR yet" count={glance.tickets.length}>
        {keyed("tickets", glance.tickets).map(({ key, item: t, ref }) => (
          <Row key={key} item={ref} link={t.link} message={renderMessage}>
            <span className="title">
              <span className="tid">{t.id}</span>
              {t.title}
            </span>
            <span className={/review/i.test(t.status) ? "status review" : "status"}>{t.status}</span>
          </Row>
        ))}
      </Panel>
    </aside>
  );
}
