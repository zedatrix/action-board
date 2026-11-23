import type { Board, Choice, Decision } from "./data/types";
import type { MessagePayload } from "./messages";

// App answers live in localStorage under this key until the board file records an answer for the decision.
export const STORAGE_KEY = "action-board:app-answers";
// Vite dev-server route (see vite.config.ts) that forwards the payload server-side when CORS blocks the browser.
export const FALLBACK_PATH = "/__ab/webhook";
// Vite dev-server route that appends one line per POST attempt to app/.delivery-log.jsonl.
export const DELIVERY_LOG_PATH = "/__ab/delivery-log";
// Vite dev-server route that clears a card from board.ts through `ab clear` (CLEAR_ROUTE in vite.config.ts).
// The app calls it only after the decision.not_relevant webhook got a 2xx.
export const CLEAR_PATH = "/__ab/clear";
// One delivery cycle: three tries, waiting this long before each.
export const RETRY_DELAYS_MS = [0, 500, 1500];
// "Message <assistant>" notes live here, separate from answers and never dropped because of board contents.
export const MESSAGES_KEY = "action-board:messages";
// Delivered notes beyond this many are dropped, oldest first; undelivered ones are always kept.
export const MESSAGE_RETENTION = 200;
const TIMEOUT_MS = 15000;

export type WebhookPayload = {
  event: "decision.answered";
  decision_id: string;
  card_ref: string | null;
  question: string;
} & Choice & {
  answered_by: "app";
  answered_at: string;
};

// "Explain this better" on a card: asks the assistant to reword the decision. Never stored and never answers it.
export type ClarifyPayload = {
  event: "decision.clarify";
  decision_id: string;
  question: string;
  context: string;
  clicked_at: string;
};

// "Not relevant anymore" on a card: tells the assistant the decision no longer matters; the app then clears it
// through /__ab/clear. Never stored and never answers it.
export type NotRelevantPayload = {
  event: "decision.not_relevant";
  decision_id: string;
  question: string;
  cleared_at: string;
};

// What the user picked in the app: one option id, several option ids (multiSelect), or their own text.
export type AppChoice = string | string[] | { custom: string };

const customAllowed = (d: Decision) => d.allowCustom !== false;

// Turns an app pick into the answer fields, validated against the decision. Throws on anything invalid.
export function toChoice(decision: Decision, pick: AppChoice): Choice {
  if (typeof pick === "object" && !Array.isArray(pick)) {
    if (!customAllowed(decision)) throw new Error(`Custom answers are off for ${decision.id}`);
    const text = pick.custom.trim();
    if (!text) throw new Error("Custom answer is blank");
    return { answer: "custom", answer_label: text, custom_text: text };
  }
  const ids = Array.isArray(pick) ? pick : [pick];
  for (const id of ids) {
    if (!decision.options.some((o) => o.id === id)) throw new Error(`Unknown option ${id} for ${decision.id}`);
  }
  if (decision.multiSelect) {
    if (!Array.isArray(pick)) throw new Error(`${decision.id} is multi-select; pass a list of option ids`);
    const picked = decision.options.filter((o) => ids.includes(o.id));
    if (picked.length === 0) throw new Error(`Pick at least one option for ${decision.id}`);
    return { answer: picked.map((o) => o.id), answer_label: picked.map((o) => o.label) };
  }
  if (Array.isArray(pick)) throw new Error(`${decision.id} is single-select; pass one option id`);
  const option = decision.options.find((o) => o.id === pick)!;
  return { answer: option.id, answer_label: option.label };
}

// Short text for the toast and the "already answered" messages.
export function choiceText(choice: Choice): string {
  return Array.isArray(choice.answer_label) ? choice.answer_label.join(", ") : choice.answer_label;
}

export type DeliveryStatus = "pending" | "delivered" | "failed";

// One stored webhook delivery. Answers and messages use the same record shape under different keys.
export type DeliveryRecord<P> = {
  payload: P;
  status: DeliveryStatus;
  attempts: number;
  last_http: number | null;
  last_at: string | null;
};

export type AppAnswerRecord = DeliveryRecord<WebhookPayload>;
export type AppAnswers = Record<string, AppAnswerRecord>;

// Keyed by message_id.
export type MessageRecord = DeliveryRecord<MessagePayload>;
export type AppMessages = Record<string, MessageRecord>;

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export type DeliveryVia = "direct" | "fallback";

type Outcome = {
  http: number | null;
  via: DeliveryVia | null;
  attempt: number;
  status: "delivered" | "failed" | "retrying";
  at: string;
};

// One POST attempt, as written to the delivery log. Never carries the webhook URL, auth or message text.
export type AnswerReport = {
  event: "decision.answered";
  decision_id: string;
  answer: Choice["answer"];
  answer_label: Choice["answer_label"];
} & Outcome;
export type MessageReport = {
  event: "item.message";
  message_id: string;
  item_id: string;
  item_section: string;
} & Outcome;
export type ClarifyReport = {
  event: "decision.clarify";
  decision_id: string;
} & Outcome;
export type NotRelevantReport = {
  event: "decision.not_relevant";
  decision_id: string;
} & Outcome;
export type DeliveryReport = AnswerReport | MessageReport | ClarifyReport | NotRelevantReport;

// How a clarify (or not relevant) request ended: ok means a 2xx from the receiver within one retry cycle.
export type ClarifyResult = { ok: boolean; http: number | null; via: DeliveryVia };
export type NotRelevantResult = ClarifyResult;

export type DeliveryReporter = (report: DeliveryReport) => unknown;

// Fire-and-forget POST to the dev-server delivery log; outside the dev server it just fails quietly.
export function logReporter(fetchFn: typeof fetch, url = DELIVERY_LOG_PATH): DeliveryReporter {
  return (report) =>
    fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }).catch(
      () => undefined,
    );
}

export type DeliveryDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  storage: KeyValueStorage;
  webhookUrl?: string;
  webhookAuth?: string;
  fallbackUrl: string;
  now?: () => Date;
  delaysMs?: number[];
  onChange?: (answers: AppAnswers) => void;
  onMessagesChange?: (messages: AppMessages) => void;
  // Called once after every POST attempt. Defaults to logReporter(fetch).
  report?: DeliveryReporter;
};

export function buildPayload(decision: Decision, pick: AppChoice, now: Date): WebhookPayload {
  const choice = toChoice(decision, pick);
  return {
    event: "decision.answered",
    decision_id: decision.id,
    card_ref: decision.card_ref ?? null,
    question: decision.question,
    answer: choice.answer,
    answer_label: choice.answer_label,
    answered_by: "app",
    answered_at: now.toISOString(),
    ...("custom_text" in choice ? { custom_text: choice.custom_text } : {}),
  } as WebhookPayload;
}

export function buildClarifyPayload(decision: Decision, now: Date): ClarifyPayload {
  return {
    event: "decision.clarify",
    decision_id: decision.id,
    question: decision.question,
    context: decision.context ?? "",
    clicked_at: now.toISOString(),
  };
}

export function buildNotRelevantPayload(decision: Decision, now: Date): NotRelevantPayload {
  return {
    event: "decision.not_relevant",
    decision_id: decision.id,
    question: decision.question,
    cleared_at: now.toISOString(),
  };
}

function loadRecords<R>(storage: KeyValueStorage, key: string): Record<string, R> {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function loadAnswers(storage: KeyValueStorage): AppAnswers {
  return loadRecords<AppAnswerRecord>(storage, STORAGE_KEY);
}

export function saveAnswers(storage: KeyValueStorage, answers: AppAnswers): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(answers));
}

export function loadMessages(storage: KeyValueStorage): AppMessages {
  return loadRecords<MessageRecord>(storage, MESSAGES_KEY);
}

export function saveMessages(storage: KeyValueStorage, messages: AppMessages): void {
  storage.setItem(MESSAGES_KEY, JSON.stringify(messages));
}

// Drops local entries the file has taken over: the file answered the decision, or the decision is gone
// from the file and its webhook already went out.
export function reconcile(answers: AppAnswers, board: Board): AppAnswers {
  const byId = new Map(board.decisions.map((d) => [d.id, d]));
  const kept: AppAnswers = {};
  for (const [id, rec] of Object.entries(answers)) {
    const d = byId.get(id);
    if (d?.answer) continue;
    if (!d && rec.status === "delivered") continue;
    kept[id] = rec;
  }
  return kept;
}

// Keeps at most `max` messages by dropping the oldest delivered ones. Undelivered messages are never dropped.
export function pruneMessages(messages: AppMessages, max = MESSAGE_RETENTION): AppMessages {
  const entries = Object.entries(messages);
  const excess = entries.length - max;
  if (excess <= 0) return messages;
  const sentAt = (r: MessageRecord) => String(r?.payload?.sent_at ?? "");
  const drop = new Set(
    entries
      .filter(([, r]) => r?.status === "delivered")
      .sort(([, a], [, b]) => (sentAt(a) < sentAt(b) ? -1 : sentAt(a) > sentAt(b) ? 1 : 0))
      .slice(0, excess)
      .map(([id]) => id),
  );
  return Object.fromEntries(entries.filter(([id]) => !drop.has(id)));
}

// Header marker text, or null when there is nothing to report.
export function deliveryMarker(answers: Record<string, { status: DeliveryStatus }>, webhookConfigured: boolean): string | null {
  const recs = Object.values(answers);
  if (!webhookConfigured) {
    return recs.some((r) => r.status !== "delivered") ? "Webhook not set up (app/.env.local)" : null;
  }
  const failed = recs.filter((r) => r.status === "failed").length;
  if (failed === 0) return null;
  return `${failed} ${failed === 1 ? "answer" : "answers"} not delivered`;
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export function createDelivery(deps: DeliveryDeps) {
  const now = deps.now ?? (() => new Date());
  const delays = deps.delaysMs ?? RETRY_DELAYS_MS;
  const reporter = deps.report ?? logReporter(deps.fetch);

  // Observability only: errors are swallowed so reporting can never affect delivery.
  function report(entry: DeliveryReport) {
    try {
      void Promise.resolve(reporter(entry)).catch(() => undefined);
    } catch {
      // ignored
    }
  }

  // One POST. Returns the receiver's HTTP status (null if it never answered) and which path carried it.
  // Without a webhook URL in the page (only clarify and not relevant post then) it goes straight to the fallback.
  async function post(body: string): Promise<{ http: number | null; via: DeliveryVia }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (deps.webhookAuth) headers.Authorization = deps.webhookAuth;
    if (deps.webhookUrl) {
      try {
        const res = await deps.fetch(deps.webhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        return { http: res.status, via: "direct" };
      } catch (err) {
        // A timeout may mean the receiver got it; don't send a second copy through the fallback.
        if (isTimeout(err)) return { http: null, via: "direct" };
      }
    }
    // Direct fetch threw: a CORS block or network error. Let the dev server forward it with the same headers.
    try {
      const res = await deps.fetch(deps.fallbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json().catch(() => null);
      return { http: typeof data?.status === "number" ? data.status : null, via: "fallback" };
    } catch {
      return { http: null, via: "fallback" };
    }
  }

  // A stored queue of payloads under one localStorage key, delivered with the shared retry cycle.
  // At most one cycle per id runs at a time, and a delivered record is never posted again.
  function queue<P>(
    load: () => Record<string, DeliveryRecord<P>>,
    save: (recs: Record<string, DeliveryRecord<P>>) => void,
    onChange: ((recs: Record<string, DeliveryRecord<P>>) => void) | undefined,
    describe: (id: string, payload: P) => Omit<AnswerReport, keyof Outcome> | Omit<MessageReport, keyof Outcome>,
  ) {
    const inFlight = new Set<string>();

    function write(recs: Record<string, DeliveryRecord<P>>) {
      save(recs);
      onChange?.(recs);
    }

    function update(id: string, fn: (rec: DeliveryRecord<P>) => DeliveryRecord<P>) {
      const recs = load();
      if (!recs[id]) return;
      write({ ...recs, [id]: fn(recs[id]) });
    }

    // Runs one delivery cycle for a stored record. Without a webhook URL it leaves the record pending.
    async function deliver(id: string): Promise<void> {
      if (!deps.webhookUrl || inFlight.has(id)) return;
      inFlight.add(id);
      try {
        for (let i = 0; i < delays.length; i++) {
          if (delays[i] > 0) await deps.sleep(delays[i]);
          const rec = load()[id];
          if (!rec || rec.status === "delivered") return;
          const { http, via } = await post(JSON.stringify(rec.payload));
          const ok = http !== null && http >= 200 && http < 300;
          const last = i === delays.length - 1;
          const at = now().toISOString();
          let attempt = rec.attempts + 1;
          update(id, (r) => {
            attempt = r.attempts + 1;
            return {
              ...r,
              attempts: attempt,
              last_http: http,
              last_at: at,
              status: ok ? "delivered" : last ? "failed" : r.status,
            };
          });
          report({ ...describe(id, rec.payload), http, via, attempt, status: ok ? "delivered" : last ? "failed" : "retrying", at } as DeliveryReport);
          if (ok) return;
        }
      } finally {
        inFlight.delete(id);
      }
    }

    return { write, deliver };
  }

  const answers = queue<WebhookPayload>(
    () => loadAnswers(deps.storage),
    (recs) => saveAnswers(deps.storage, recs),
    deps.onChange,
    (id, p) => ({ event: "decision.answered", decision_id: id, answer: p.answer, answer_label: p.answer_label }),
  );

  const messages = queue<MessagePayload>(
    () => loadMessages(deps.storage),
    (recs) => saveMessages(deps.storage, recs),
    deps.onMessagesChange,
    (id, p) => ({ event: "item.message", message_id: id, item_id: p.item_id, item_section: p.item_section }),
  );

  // Stores a new app answer as pending, then delivers it.
  function answer(payload: WebhookPayload): Promise<void> {
    const recs = loadAnswers(deps.storage);
    answers.write({
      ...recs,
      [payload.decision_id]: { payload, status: "pending", attempts: 0, last_http: null, last_at: null },
    });
    return answers.deliver(payload.decision_id);
  }

  // Drops answers the file has taken over, then retries everything still pending or failed.
  async function deliverPending(board: Board): Promise<void> {
    const before = loadAnswers(deps.storage);
    const recs = reconcile(before, board);
    if (Object.keys(recs).length !== Object.keys(before).length) answers.write(recs);
    const due = Object.entries(recs).filter(([, r]) => r.status !== "delivered");
    await Promise.all(due.map(([id]) => answers.deliver(id)));
  }

  // Stores a new message as pending (once per message_id), then delivers it.
  function message(payload: MessagePayload): Promise<void> {
    const recs = loadMessages(deps.storage);
    if (!recs[payload.message_id]) {
      messages.write(
        pruneMessages({ ...recs, [payload.message_id]: { payload, status: "pending", attempts: 0, last_http: null, last_at: null } }),
      );
    }
    return messages.deliver(payload.message_id);
  }

  // Retries every message still pending or failed. Messages are never dropped because of board contents.
  async function deliverPendingMessages(): Promise<void> {
    const due = Object.entries(loadMessages(deps.storage)).filter(([, r]) => r && r.status !== "delivered" && r.payload);
    await Promise.all(due.map(([id]) => messages.deliver(id)));
  }

  // Sends one unstored request with the shared retry cycle and resolves with how it ended.
  // Each attempt is reported with the event and decision id only, never the question or context text.
  async function sendOnce(payload: ClarifyPayload | NotRelevantPayload): Promise<ClarifyResult> {
    const body = JSON.stringify(payload);
    let result: ClarifyResult = { ok: false, http: null, via: "direct" };
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await deps.sleep(delays[i]);
      const { http, via } = await post(body);
      const ok = http !== null && http >= 200 && http < 300;
      const last = i === delays.length - 1;
      result = { ok, http, via };
      report({ event: payload.event, decision_id: payload.decision_id, http, via, attempt: i + 1, status: ok ? "delivered" : last ? "failed" : "retrying", at: now().toISOString() });
      if (ok) break;
    }
    return result;
  }

  // "Explain this better". Nothing is stored.
  const clarify = (payload: ClarifyPayload): Promise<ClarifyResult> => sendOnce(payload);
  // "Not relevant anymore". Nothing is stored; the caller clears the card only when this is ok.
  const notRelevant = (payload: NotRelevantPayload): Promise<NotRelevantResult> => sendOnce(payload);

  return { answer, clarify, notRelevant, deliver: answers.deliver, deliverPending, message, deliverMessage: messages.deliver, deliverPendingMessages };
}
