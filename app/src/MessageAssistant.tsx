import { useId, useLayoutEffect, useRef } from "react";
import { ASSISTANT_NAME } from "./config";
import type { MessageRecord } from "./delivery";
import type { BoardItem } from "./messages";

// An open composer. message_id is set once Send was pressed; the composer then locks until it closes on a 2xx.
export type Draft = { text: string; message_id?: string };

type Props = {
  item: BoardItem;
  draft: Draft | undefined;
  // The newest message sent about this item, if any.
  latest: MessageRecord | undefined;
  webhookConfigured: boolean;
  onOpen: (item: BoardItem) => void;
  onText: (item: BoardItem, text: string) => void;
  onClose: (item: BoardItem) => void;
  onSend: (item: BoardItem, text: string) => void;
};

function localTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

export function messageStatusText(rec: MessageRecord, webhookConfigured: boolean): string {
  if (rec.status === "delivered") return `Sent to ${ASSISTANT_NAME} · ${localTime(rec.last_at ?? rec.payload.sent_at)}`;
  if (rec.status === "failed") return "Not delivered, will retry";
  return rec.attempts === 0 && webhookConfigured ? "Sending..." : "Not sent yet, retrying";
}

// "Message <assistant>" button, the latest note's delivery state, and an inline composer. Rendered as siblings so the
// glance row can put the button beside the item and the rest underneath. Never changes the item itself.
export function MessageAssistant({ item, draft, latest, webhookConfigured, onOpen, onText, onClose, onSend }: Props) {
  const fieldId = useId();
  const text = draft?.text ?? "";
  const locked = Boolean(draft?.message_id);
  const canSend = !locked && text.trim() !== "";
  const send = () => {
    if (canSend) onSend(item, text);
  };
  // Caret to restore after a Cmd/Ctrl+Enter newline, once the new text has rendered.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = document.getElementById(fieldId) as HTMLTextAreaElement | null;
    if (el && caret.current !== null) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text, fieldId]);

  return (
    <>
      <button
        type="button"
        className="msg-btn"
        aria-expanded={Boolean(draft)}
        aria-label={`Message ${ASSISTANT_NAME} about ${item.item_title}`}
        onClick={() => {
          onOpen(item);
          document.getElementById(fieldId)?.focus();
        }}
      >
        Message {ASSISTANT_NAME}
      </button>
      {latest && (
        <p className={`msg-status ${latest.status}`} aria-live="polite">
          {messageStatusText(latest, webhookConfigured)}
        </p>
      )}
      {draft && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            id={fieldId}
            className="composer-input"
            value={text}
            readOnly={locked}
            autoFocus
            aria-label={`Message to ${ASSISTANT_NAME} about ${item.item_title}`}
            aria-describedby={`${fieldId}-hint`}
            placeholder={`What should ${ASSISTANT_NAME} know or do about this?`}
            onChange={(e) => onText(item, e.target.value)}
            onKeyDown={(e) => {
              // Enter sends through the form, like Send. Shift+Enter, Cmd+Enter and Ctrl+Enter add a new line;
              // Alt+Enter and Enter while an IME is composing never send.
              if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.metaKey || e.ctrlKey) {
                // Browsers do not insert a newline for Cmd/Ctrl+Enter, so insert it at the caret.
                e.preventDefault();
                if (locked) return;
                const el = e.currentTarget;
                caret.current = el.selectionStart + 1;
                onText(item, text.slice(0, el.selectionStart) + "\n" + text.slice(el.selectionEnd));
                return;
              }
              if (e.shiftKey || e.altKey) return;
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="composer-actions">
            <button type="submit" className="btn" disabled={!canSend}>
              Send
            </button>
            <button type="button" className="btn ghost" onClick={() => onClose(item)}>
              {locked ? "Close" : "Cancel"}
            </button>
            <span className="hint" id={`${fieldId}-hint`}>
              Enter to send, Shift+Enter for a new line
            </span>
          </div>
        </form>
      )}
    </>
  );
}
