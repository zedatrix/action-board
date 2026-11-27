// Shared by the Board's quick-add input and the CLI's todo-add command.
import type { TodoPriority } from "./data/types";

export type QuickAdd = { name: string; priority?: TodoPriority };

// "!urgent" "!high" "!medium" "!low", or p1 (urgent) to p4 (low), with or without "!", as a word of its own.
const PRIORITY_TOKEN = /(^|\s)(?:!(urgent|high|medium|low)|!?p([1-4]))(?=\s|$)/gi;
const BY_NUMBER: TodoPriority[] = ["urgent", "high", "medium", "low"];

export function parseQuickAdd(text: string): QuickAdd {
  let priority: TodoPriority | undefined;
  const name = text.replace(PRIORITY_TOKEN, (_match, _lead: string, word?: string, num?: string) => {
    priority ??= word ? (word.toLowerCase() as TodoPriority) : BY_NUMBER[Number(num) - 1];
    return "";
  }).trim();
  return { name, ...(priority ? { priority } : {}) };
}
