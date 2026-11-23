import { afterEach, describe, expect, it } from "vitest";
import type { Board, Decision } from "../src/data/types";
import {
  buildPayload,
  createDelivery,
  DELIVERY_LOG_PATH,
  deliveryMarker,
  loadAnswers,
  loadMessages,
  MESSAGE_RETENTION,
  MESSAGES_KEY,
  pruneMessages,
  STORAGE_KEY,
  type AnswerReport,
  type AppAnswers,
  type DeliveryDeps,
  type DeliveryReport,
  type KeyValueStorage,
  type MessageReport,
} from "../src/delivery";
import { buildMessagePayload, decisionItem, glanceItem, type MessagePayload } from "../src/messages";
import { startReceiver } from "./receiver";

const AUTH = "Bearer s3cr3t  with=two spaces";
const NOW = new Date("2026-11-10T12:34:56.789Z");

const decision: Decision = {
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
  id: "notify-1550",
  card_ref: null,
  question: "Who should look?",
  what_happens_after: "The assistant pings them.",
  options: [
    { id: "riley", label: "Riley" },
    { id: "kai", label: "Kai" },
    { id: "blake", label: "Blake" },
  ],
  multiSelect: true,
  created_at: "2026-11-10T09:00:00.000Z",
};
const boardWith =(...decisions: Decision[]): Board => ({
  updated_at: "2026-11-10T09:00:00.000Z",
  decisions,
  glance: { waiting: [], tickets: [] },
});

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const receivers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(receivers.splice(0).map((r) => r.close()));
});

async function setup(statuses: number[], overrides: Partial<DeliveryDeps> = {}) {
  const receiver = await startReceiver(statuses);
  receivers.push(receiver);
  const storage = memoryStorage();
  const sleeps: number[] = [];
  const changes: AppAnswers[] = [];
  const reports: DeliveryReport[] = [];
  const delivery = createDelivery({
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    storage,
    webhookUrl: receiver.url,
    webhookAuth: AUTH,
    fallbackUrl: "http://127.0.0.1:1/unused",
    now: () => NOW,
    onChange: (a) => void changes.push(a),
    report: (r) => void reports.push(r),
    ...overrides,
  });
  return { receiver, storage, sleeps, changes, reports, delivery };
}

describe("buildPayload", () => {
  it("builds exactly the documented payload", () => {
    expect(buildPayload(decision, "wait", NOW)).toStrictEqual({
      event: "decision.answered",
      decision_id: "merge-42",
      card_ref: "PROJ-4382",
      question: "Merge now or wait?",
      answer: "wait",
      answer_label: "Wait for Riley",
      answered_by: "app",
      answered_at: "2026-11-10T12:34:56.789Z",
    });
  });

  it("rejects an unknown option", () => {
    expect(() => buildPayload(decision, "nope", NOW)).toThrow();
  });

  it("builds a multi-select payload: ids and labels as arrays in option order", () => {
    expect(JSON.stringify(buildPayload(multi, ["blake", "riley"], NOW))).toBe(
      '{"event":"decision.answered","decision_id":"notify-1550","card_ref":null,"question":"Who should look?",' +
        '"answer":["riley","blake"],"answer_label":["Riley","Blake"],"answered_by":"app","answered_at":"2026-11-10T12:34:56.789Z"}',
    );
  });

  it("builds a custom payload with the trimmed text in answer_label and custom_text", () => {
    expect(JSON.stringify(buildPayload(decision, { custom: "  Wait until Monday  " }, NOW))).toBe(
      '{"event":"decision.answered","decision_id":"merge-42","card_ref":"PROJ-4382","question":"Merge now or wait?",' +
        '"answer":"custom","answer_label":"Wait until Monday","answered_by":"app","answered_at":"2026-11-10T12:34:56.789Z",' +
        '"custom_text":"Wait until Monday"}',
    );
  });

  it("rejects blank custom text, custom when allowCustom is false, and the wrong shape for the decision", () => {
    expect(() => buildPayload(decision, { custom: "   " }, NOW)).toThrow(/blank/);
    expect(() => buildPayload({ ...decision, allowCustom: false }, { custom: "x" }, NOW)).toThrow(/off/);
    expect(buildPayload({ ...decision, allowCustom: true }, { custom: "x" }, NOW).answer).toBe("custom");
    expect(() => buildPayload(decision, ["merge", "wait"], NOW)).toThrow(/single-select/);
    expect(() => buildPayload(multi, "riley", NOW)).toThrow(/multi-select/);
    expect(() => buildPayload(multi, [], NOW)).toThrow(/at least one/);
    expect(() => buildPayload(multi, ["riley", "nope"], NOW)).toThrow(/Unknown option/);
  });
});

describe("delivery against a real local receiver", () => {
  it("posts the exact payload with the Authorization header verbatim, and records delivered", async () => {
    const { receiver, storage, changes, delivery } = await setup([200]);
    const payload = buildPayload(decision, "merge", NOW);
    const pending = delivery.answer(payload);
    // Stored and reported as pending before any network round trip.
    expect(changes[0][decision.id].status).toBe("pending");
    await pending;

    expect(receiver.received).toHaveLength(1);
    const req = receiver.received[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe(AUTH);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toStrictEqual(payload);
    expect(Object.keys(JSON.parse(req.body))).toEqual([
      "event", "decision_id", "card_ref", "question", "answer", "answer_label", "answered_by", "answered_at",
    ]);

    const rec = loadAnswers(storage)[decision.id];
    expect(rec).toMatchObject({ status: "delivered", attempts: 1, last_http: 200, last_at: NOW.toISOString() });
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)[decision.id].payload).toStrictEqual(payload);
  });

  it("posts multi and custom payloads exactly, with the Authorization header verbatim", async () => {
    const { receiver, storage, delivery } = await setup([200]);
    const multiPayload = buildPayload(multi, ["blake", "riley"], NOW);
    const customPayload = buildPayload(decision, { custom: "Wait until Monday" }, NOW);
    await delivery.answer(multiPayload);
    await delivery.answer(customPayload);

    expect(receiver.received).toHaveLength(2);
    for (const req of receiver.received) {
      expect(req.headers.authorization).toBe(AUTH);
      expect(req.headers["content-type"]).toBe("application/json");
    }
    expect(receiver.received[0].body).toBe(
      '{"event":"decision.answered","decision_id":"notify-1550","card_ref":null,"question":"Who should look?",' +
        '"answer":["riley","blake"],"answer_label":["Riley","Blake"],"answered_by":"app","answered_at":"2026-11-10T12:34:56.789Z"}',
    );
    expect(receiver.received[1].body).toBe(
      '{"event":"decision.answered","decision_id":"merge-42","card_ref":"PROJ-4382","question":"Merge now or wait?",' +
        '"answer":"custom","answer_label":"Wait until Monday","answered_by":"app","answered_at":"2026-11-10T12:34:56.789Z",' +
        '"custom_text":"Wait until Monday"}',
    );
    const answers = loadAnswers(storage);
    expect(answers[multi.id]).toMatchObject({ status: "delivered", payload: multiPayload });
    expect(answers[decision.id]).toMatchObject({ status: "delivered", payload: customPayload });
  });

  it("drops a local answer of another shape once the file answers (file wins)", async () => {
    const { receiver, storage, delivery } = await setup([500]);
    await delivery.answer(buildPayload(multi, ["riley"], NOW));
    expect(loadAnswers(storage)[multi.id].status).toBe("failed");
    const sent = receiver.received.length;
    const answered = {
      ...multi,
      answer: { answer: "custom" as const, answer_label: "Nobody", custom_text: "Nobody", answered_by: "chat" as const, answered_at: NOW.toISOString() },
    };
    await delivery.deliverPending(boardWith(answered));
    expect(receiver.received.length).toBe(sent);
    expect(loadAnswers(storage)).toEqual({});
  });

  it("sends no Authorization header when auth is unset", async () => {
    const { receiver, delivery } = await setup([204], { webhookAuth: undefined });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(receiver.received[0].headers.authorization).toBeUndefined();
  });

  it("retries 500, 500, 200 and is delivered after 3 attempts", async () => {
    const { receiver, storage, sleeps, delivery } = await setup([500, 500, 200]);
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(receiver.received).toHaveLength(3);
    expect(sleeps).toEqual([500, 1500]);
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 3, last_http: 200 });
  });

  it("marks failed after a full cycle of errors, then delivers on a later cycle", async () => {
    const { receiver, storage, delivery } = await setup([503, 503, 503, 200]);
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(receiver.received).toHaveLength(3);
    let answers = loadAnswers(storage);
    expect(answers[decision.id]).toMatchObject({ status: "failed", attempts: 3, last_http: 503 });
    expect(deliveryMarker(answers, true)).toBe("1 answer not delivered");

    await delivery.deliverPending(boardWith(decision));
    answers = loadAnswers(storage);
    expect(answers[decision.id]).toMatchObject({ status: "delivered", attempts: 4, last_http: 200 });
    expect(deliveryMarker(answers, true)).toBeNull();
  });

  it("with no webhook URL stays pending and sends nothing", async () => {
    const { receiver, storage, delivery } = await setup([200], { webhookUrl: undefined });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    await delivery.deliverPending(boardWith(decision));
    expect(receiver.received).toHaveLength(0);
    const answers = loadAnswers(storage);
    expect(answers[decision.id]).toMatchObject({ status: "pending", attempts: 0, last_http: null });
    expect(deliveryMarker(answers, false)).toBe("Webhook not set up (app/.env.local)");
  });

  it("never posts for decisions the file already answered (chat), and drops the local entry", async () => {
    const { receiver, storage } = await setup([200]);
    // A local app answer that never went out, for a decision the assistant has since marked answered in chat.
    const payload = buildPayload(decision, "wait", NOW);
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [decision.id]: { payload, status: "failed", attempts: 3, last_http: 500, last_at: NOW.toISOString() } }),
    );
    const answered = {
      ...decision,
      answer: { answer: "merge", answer_label: "Merge now", answered_by: "chat" as const, answered_at: NOW.toISOString() },
    };
    const { delivery } = await setup([200], { storage });
    await delivery.deliverPending(boardWith(answered));
    expect(receiver.received).toHaveLength(0);
    expect(loadAnswers(storage)).toEqual({});
  });

  it("falls back to the dev-server route when the direct fetch throws (CORS block)", async () => {
    const route = await startReceiver([200]);
    receivers.push(route);
    // Stand-in for the browser: the direct URL throws like a CORS failure; everything else goes over real fetch.
    const corsBlocked: typeof fetch = (input, init) =>
      String(input).includes("/hook-direct") ? Promise.reject(new TypeError("Failed to fetch")) : fetch(input, init);
    const { storage, delivery } = await setup([200], {
      fetch: corsBlocked,
      webhookUrl: "http://127.0.0.1:9/hook-direct",
      fallbackUrl: route.url,
    });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    // The mock route replies "ok" (not {status}), so this counts as undelivered; check what the app sent it.
    expect(route.received.length).toBe(3);
    expect(route.received[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(route.received[0].body)).toStrictEqual(buildPayload(decision, "merge", NOW));
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "failed", last_http: null });
  });

  it("counts the route's {status} as the receiver's status", async () => {
    const corsBlocked: typeof fetch = async (input) => {
      if (String(input).includes("/hook-direct")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: 202 }), { status: 200 });
    };
    const { storage, delivery } = await setup([200], {
      fetch: corsBlocked,
      webhookUrl: "http://127.0.0.1:9/hook-direct",
      fallbackUrl: "/__ab/webhook",
    });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 1, last_http: 202 });
  });
});

// The delivery log entry expected for one attempt on `decision`; defaults to a direct 200 on attempt 1.
function report(r: Partial<AnswerReport>): AnswerReport {
  return {
    event: "decision.answered",
    decision_id: decision.id,
    answer: "merge",
    answer_label: "Merge now",
    http: 200,
    via: "direct",
    attempt: 1,
    status: "delivered",
    at: NOW.toISOString(),
    ...r,
  };
}

describe("delivery log reports", () => {
  const noSecrets = (reports: DeliveryReport[], url: string) => {
    const text = JSON.stringify(reports);
    expect(text).not.toContain(url);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain(AUTH);
    for (const r of reports) expect(Object.keys(r).sort()).toEqual(Object.keys(report({})).sort());
  };

  it("reports one direct attempt on a direct success", async () => {
    const { receiver, reports, delivery } = await setup([200]);
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(reports).toStrictEqual([report({})]);
    noSecrets(reports, receiver.url);
  });

  it("reports via fallback with the receiver's status when the direct POST is CORS-blocked", async () => {
    const corsBlocked: typeof fetch = async (input) => {
      if (String(input).includes("/hook-direct")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: 202 }), { status: 200 });
    };
    const url = "http://127.0.0.1:9/hook-direct";
    const { storage, reports, delivery } = await setup([200], { fetch: corsBlocked, webhookUrl: url, fallbackUrl: "/__ab/webhook" });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(reports).toStrictEqual([report({ via: "fallback", http: 202 })]);
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 1, last_http: 202 });
    noSecrets(reports, url);
  });

  it("reports every attempt of a failing fallback cycle: retrying, retrying, failed", async () => {
    const corsBlocked: typeof fetch = async (input) => {
      if (String(input).includes("/hook-direct")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: 500 }), { status: 200 });
    };
    const url = "http://127.0.0.1:9/hook-direct";
    const { reports, delivery } = await setup([200], { fetch: corsBlocked, webhookUrl: url, fallbackUrl: "/__ab/webhook" });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(reports).toStrictEqual([
      report({ via: "fallback", http: 500, attempt: 1, status: "retrying" }),
      report({ via: "fallback", http: 500, attempt: 2, status: "retrying" }),
      report({ via: "fallback", http: 500, attempt: 3, status: "failed" }),
    ]);
    noSecrets(reports, url);
  });

  it("reports each retry with its attempt number, http and status, across cycles", async () => {
    const { receiver, storage, reports, delivery } = await setup([500, 503, 500, 200]);
    await delivery.answer(buildPayload(decision, "merge", NOW));
    await delivery.deliverPending(boardWith(decision));
    expect(reports).toStrictEqual([
      report({ http: 500, attempt: 1, status: "retrying" }),
      report({ http: 503, attempt: 2, status: "retrying" }),
      report({ http: 500, attempt: 3, status: "failed" }),
      report({ http: 200, attempt: 4, status: "delivered" }),
    ]);
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 4, last_http: 200 });
    noSecrets(reports, receiver.url);
  });

  it("reports nothing when no webhook URL is set", async () => {
    const { reports, delivery } = await setup([200], { webhookUrl: undefined });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(reports).toEqual([]);
  });

  it("a throwing or rejecting reporter never changes delivery", async () => {
    for (const bad of [
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      const { receiver, storage, sleeps, delivery } = await setup([500, 200], { report: bad });
      await delivery.answer(buildPayload(decision, "merge", NOW));
      expect(receiver.received).toHaveLength(2);
      expect(sleeps).toEqual([500]);
      expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 2, last_http: 200 });
    }
  });

  it("by default posts the report as JSON to /__ab/delivery-log through deps.fetch, without the URL or auth", async () => {
    const receiver = await startReceiver([200]);
    receivers.push(receiver);
    const logged: { url: string; init?: RequestInit }[] = [];
    const spy: typeof fetch = (input, init) => {
      if (String(input) === DELIVERY_LOG_PATH) {
        logged.push({ url: String(input), init });
        return Promise.reject(new TypeError("no dev server"));
      }
      return fetch(input, init);
    };
    const storage = memoryStorage();
    const delivery = createDelivery({
      fetch: spy,
      sleep: async () => undefined,
      storage,
      webhookUrl: receiver.url,
      webhookAuth: AUTH,
      fallbackUrl: "http://127.0.0.1:1/unused",
      now: () => NOW,
    });
    await delivery.answer(buildPayload(decision, "merge", NOW));
    expect(loadAnswers(storage)[decision.id]).toMatchObject({ status: "delivered", attempts: 1, last_http: 200 });
    expect(logged).toHaveLength(1);
    expect(logged[0].init?.method).toBe("POST");
    expect(logged[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(logged[0].init?.body))).toStrictEqual(report({}));
    expect(String(logged[0].init?.body)).not.toContain(receiver.url);
    expect(String(logged[0].init?.body)).not.toContain("s3cr3t");
  });
});

describe("pending answers across a reload", () => {
  it("an answer stored while no URL was configured is delivered once a URL is configured, same storage format", async () => {
    // First page load: no webhook configured, so the answer stays pending in localStorage.
    const { receiver, storage, delivery: unconfigured } = await setup([200], { webhookUrl: undefined });
    const payload = buildPayload(decision, "wait", NOW);
    await unconfigured.answer(payload);
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    expect(Object.keys(stored)).toEqual([decision.id]);
    expect(stored[decision.id]).toStrictEqual({ payload, status: "pending", attempts: 0, last_http: null, last_at: null });
    expect(receiver.received).toHaveLength(0);

    // Reload with .env.local filled in: a fresh delivery instance over the same storage flushes it on load.
    const reports: DeliveryReport[] = [];
    const configured = createDelivery({
      fetch,
      sleep: async () => undefined,
      storage,
      webhookUrl: receiver.url,
      webhookAuth: AUTH,
      fallbackUrl: "http://127.0.0.1:1/unused",
      now: () => NOW,
      report: (r) => void reports.push(r),
    });
    await configured.deliverPending(boardWith(decision));
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0].headers.authorization).toBe(AUTH);
    expect(JSON.parse(receiver.received[0].body)).toStrictEqual(payload);
    const after = JSON.parse(storage.data.get(STORAGE_KEY)!);
    expect(Object.keys(after)).toEqual([decision.id]);
    expect(after[decision.id]).toStrictEqual({ payload, status: "delivered", attempts: 1, last_http: 200, last_at: NOW.toISOString() });
    expect(reports).toStrictEqual([report({ answer: "wait", answer_label: "Wait for Riley" })]);
  });
});

describe("deliveryMarker", () => {
  it("is quiet when everything is delivered or nothing was answered", () => {
    expect(deliveryMarker({}, true)).toBeNull();
    expect(deliveryMarker({}, false)).toBeNull();
  });

  it("counts failed answers", () => {
    const rec = (status: "failed" | "pending") => ({ payload: buildPayload(decision, "merge", NOW), status, attempts: 3, last_http: 500, last_at: null });
    expect(deliveryMarker({ a: rec("failed"), b: rec("failed"), c: rec("pending") }, true)).toBe("2 answers not delivered");
  });
});

describe("Message your assistant delivery", () => {
  const waiting = glanceItem("waiting", { title: "Analytics dashboard (#101)", who: "Blake's re-review", link: "https://github.com/acme/example/pull/101" });
  const msg = (id: string, text = "Nudge Blake", at = NOW) => buildMessagePayload(waiting, text, at, id);
  const msgReport = (r: Partial<MessageReport>): MessageReport => ({
    event: "item.message",
    message_id: "m-1",
    item_id: waiting.item_id,
    item_section: "waiting",
    http: 200,
    via: "direct",
    attempt: 1,
    status: "delivered",
    at: NOW.toISOString(),
    ...r,
  });

  it("posts the exact payload with Authorization verbatim, stores it under its own key as delivered, and reports without the text", async () => {
    const { receiver, storage, reports, delivery } = await setup([200]);
    const payload = msg("m-1");
    await delivery.message(payload);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0].headers.authorization).toBe(AUTH);
    expect(receiver.received[0].headers["content-type"]).toBe("application/json");
    expect(receiver.received[0].body).toBe(JSON.stringify(payload));
    expect(JSON.parse(storage.data.get(MESSAGES_KEY)!)).toStrictEqual({
      "m-1": { payload, status: "delivered", attempts: 1, last_http: 200, last_at: NOW.toISOString() },
    });
    // Answers are untouched: no answers key written at all.
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    expect(reports).toStrictEqual([msgReport({})]);
    expect(JSON.stringify(reports)).not.toContain("Nudge Blake");
    expect(JSON.stringify(reports)).not.toContain(receiver.url);
    expect(JSON.stringify(reports)).not.toContain("s3cr3t");
  });

  it("retries 500, 500, 200 and is delivered after 3 attempts, reporting each one", async () => {
    const { receiver, storage, sleeps, reports, delivery } = await setup([500, 500, 200]);
    await delivery.message(msg("m-1"));
    expect(receiver.received).toHaveLength(3);
    expect(sleeps).toEqual([500, 1500]);
    expect(loadMessages(storage)["m-1"]).toMatchObject({ status: "delivered", attempts: 3, last_http: 200 });
    expect(reports.map((r) => [r.attempt, r.http, r.status])).toEqual([
      [1, 500, "retrying"],
      [2, 500, "retrying"],
      [3, 200, "delivered"],
    ]);
  });

  it("is failed after a full cycle, and a later flush (reload) delivers it", async () => {
    const { receiver, storage, delivery } = await setup([503, 503, 503, 200]);
    await delivery.message(msg("m-1"));
    expect(loadMessages(storage)["m-1"]).toMatchObject({ status: "failed", attempts: 3, last_http: 503 });
    await delivery.deliverPendingMessages();
    expect(receiver.received).toHaveLength(4);
    expect(loadMessages(storage)["m-1"]).toMatchObject({ status: "delivered", attempts: 4, last_http: 200 });
  });

  it("without a webhook URL stays pending; a fresh instance with a URL flushes it on load", async () => {
    const { receiver, storage, delivery } = await setup([200], { webhookUrl: undefined });
    const payload = msg("m-1");
    await delivery.message(payload);
    expect(receiver.received).toHaveLength(0);
    expect(loadMessages(storage)["m-1"]).toStrictEqual({ payload, status: "pending", attempts: 0, last_http: null, last_at: null });

    const reloaded = createDelivery({
      fetch,
      sleep: async () => undefined,
      storage,
      webhookUrl: receiver.url,
      webhookAuth: AUTH,
      fallbackUrl: "http://127.0.0.1:1/unused",
      now: () => NOW,
      report: () => undefined,
    });
    await reloaded.deliverPendingMessages();
    expect(receiver.received.map((r) => r.body)).toEqual([JSON.stringify(payload)]);
    expect(loadMessages(storage)["m-1"]).toMatchObject({ status: "delivered", attempts: 1, last_http: 200 });
  });

  it("dedupes on message_id: one cycle in flight, delivered never re-sent, re-adding the same id is a no-op", async () => {
    const { receiver, storage, delivery } = await setup([200]);
    const payload = msg("m-1");
    await Promise.all([delivery.message(payload), delivery.message(payload), delivery.deliverPendingMessages()]);
    expect(receiver.received).toHaveLength(1);
    await delivery.message({ ...payload, text: "changed" });
    await delivery.deliverPendingMessages();
    await delivery.deliverMessage("m-1");
    expect(receiver.received).toHaveLength(1);
    expect(loadMessages(storage)["m-1"].payload.text).toBe("Nudge Blake");
  });

  it("goes through the /__ab/webhook fallback when the direct POST throws, reporting via fallback", async () => {
    const corsBlocked: typeof fetch = async (input) => {
      if (String(input).includes("/hook-direct")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: 202 }), { status: 200 });
    };
    const { storage, reports, delivery } = await setup([200], { fetch: corsBlocked, webhookUrl: "http://127.0.0.1:9/hook-direct", fallbackUrl: "/__ab/webhook" });
    await delivery.message(msg("m-1"));
    expect(loadMessages(storage)["m-1"]).toMatchObject({ status: "delivered", last_http: 202 });
    expect(reports).toStrictEqual([msgReport({ via: "fallback", http: 202 })]);
  });

  it("is never dropped by board contents, and leaves answers byte-for-byte alone", async () => {
    const { storage, delivery } = await setup([500]);
    await delivery.answer(buildPayload(decision, "merge", NOW));
    const answersBefore = storage.data.get(STORAGE_KEY);
    const onDecision = buildMessagePayload(decisionItem(decision), "Why this one?", NOW, "m-2");
    await delivery.message(msg("m-1"));
    await delivery.message(onDecision);
    // The decision is gone from the board and the waiting item never was on it: messages stay.
    await delivery.deliverPending(boardWith());
    await delivery.deliverPendingMessages();
    expect(Object.keys(loadMessages(storage)).sort()).toEqual(["m-1", "m-2"]);
    expect(Object.values(loadMessages(storage)).every((r) => r.status === "failed")).toBe(true);
    // Answers were reconciled by their own rules only; messages never wrote to their key.
    const after = JSON.parse(storage.data.get(STORAGE_KEY)!);
    expect(Object.keys(after)).toEqual([decision.id]);
    expect(after[decision.id].payload).toStrictEqual(JSON.parse(answersBefore!)[decision.id].payload);
  });

  it("keeps answer records in exactly the old format while messages are in flight", async () => {
    const { storage, delivery } = await setup([200]);
    const answer = buildPayload(decision, "wait", NOW);
    await Promise.all([delivery.answer(answer), delivery.message(msg("m-1"))]);
    expect(storage.data.get(STORAGE_KEY)).toBe(
      JSON.stringify({ [decision.id]: { payload: answer, status: "delivered", attempts: 1, last_http: 200, last_at: NOW.toISOString() } }),
    );
  });

  it("caps retention: drops the oldest delivered messages beyond the limit, never undelivered ones", () => {
    const rec = (i: number, status: "delivered" | "failed" | "pending") => ({
      payload: { ...msg(`m-${i}`), sent_at: new Date(NOW.getTime() + i * 1000).toISOString() } as MessagePayload,
      status,
      attempts: 1,
      last_http: status === "delivered" ? 200 : 500,
      last_at: NOW.toISOString(),
    });
    const all = Object.fromEntries(
      Array.from({ length: MESSAGE_RETENTION + 5 }, (_, i) => [`m-${i}`, rec(i, i < 3 ? "failed" : i === 3 ? "pending" : "delivered")]),
    );
    const kept = pruneMessages(all);
    expect(Object.keys(kept)).toHaveLength(MESSAGE_RETENTION);
    for (const id of ["m-0", "m-1", "m-2", "m-3"]) expect(kept[id]).toBeDefined();
    for (const id of ["m-4", "m-5", "m-6", "m-7", "m-8"]) expect(kept[id]).toBeUndefined();
    expect(kept[`m-${MESSAGE_RETENTION + 4}`]).toBeDefined();
    expect(pruneMessages({ a: rec(1, "delivered") })).toStrictEqual({ a: rec(1, "delivered") });
  });
});
