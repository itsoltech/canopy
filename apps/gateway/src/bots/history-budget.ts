import type { ModelMessage } from "./types.ts";

/**
 * History for a rebuilt harness session (docs/bots-harness.md#sesja-i-kontekst). A first input the model
 * cannot hold fails before the harness can compact, so history gets about half of the context window.
 * The worker catalog has no window per model, so the budget uses a window below every supported model's.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const HISTORY_SHARE = 0.5;

/** Conservative: real text averages more characters per token. */
const CHARS_PER_TOKEN = 3;

export type HistoryEntry = ModelMessage | { role: "canopy_note"; text: string };

const size = (entry: HistoryEntry) => JSON.stringify(entry).length;

/**
 * The newest messages that fit, and a marked note for the omitted ones. The current input (the last user
 * message and everything after it) is always kept whole; the current user message is sent separately.
 */
export function budgetedHistory(messages: readonly ModelMessage[]): HistoryEntry[] {
  const inputAt = Math.max(
    0,
    messages.findLastIndex((m) => m.role === "user"),
  );

  const current = messages.slice(inputAt);
  const budget = DEFAULT_CONTEXT_WINDOW_TOKENS * HISTORY_SHARE * CHARS_PER_TOKEN;
  let used = current.reduce((sum, m) => sum + size(m), 0) + (messages[inputAt]?.text.length ?? 0);
  let start = inputAt;

  for (let older = messages[start - 1]; older && used + size(older) <= budget; older = messages[start - 1]) {
    used += size(older);
    start -= 1;
  }

  if (start === 0) return [...messages];

  return [
    {
      role: "canopy_note",
      text: `${start} earlier messages are omitted here to fit the model's context window. Canopy keeps the full conversation; ask the user if you need something from it.`,
    },
    ...messages.slice(start, inputAt),
    ...current,
  ];
}
