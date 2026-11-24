interface ProjectSecretFilter {
  values(): Iterable<string>;
  hasValues?(): boolean;
  journalValues?(): Iterable<string>;
  retains(turnId: string): boolean;
  fence(): void;
}

const readyThreads = new Set<string>();
const sessions = new Map<string, number>();
const filters = new Map<string, ProjectSecretFilter>();

/** The adapter calls ready only after verifying the current session's synchronous tool output filter. */
export function projectSecretGuard(threadId: string) {
  const currentSession = () => sessions.get(threadId) ?? 0;
  let session = currentSession();

  return {
    ready: () => {
      if (session === currentSession()) readyThreads.add(threadId);
    },
    reset: () => {
      if (session !== currentSession()) return;
      session++;
      sessions.set(threadId, session);
      readyThreads.delete(threadId);
      filters.get(threadId)?.fence();
    },
    isReady: () => session === currentSession() && readyThreads.has(threadId),
    hasValues: () =>
      filters.get(threadId)?.hasValues?.() ?? !projectSecretValues(threadId)[Symbol.iterator]().next().done,
    redact: (text: string) => redactSecretText(text, secretPatterns(projectSecretValues(threadId))),
  };
}

export function bindProjectSecretFilter(threadId: string, filter: ProjectSecretFilter): () => void {
  filters.set(threadId, filter);

  return () => {
    if (filters.get(threadId) === filter) filters.delete(threadId);
  };
}

export function projectSecretValues(threadId: string): Iterable<string> {
  return filters.get(threadId)?.values() ?? [];
}

export function projectSecretJournalValues(threadId: string): Iterable<string> {
  return filters.get(threadId)?.journalValues?.() ?? projectSecretValues(threadId);
}

export function retainsProjectSecretOutput(threadId: string, turnId: string): boolean {
  return filters.get(threadId)?.retains(turnId) ?? false;
}

export function secretPatterns(values: Iterable<string>): string[] {
  const patterns = new Set<string>();

  for (const value of values) {
    if (!value) continue;
    patterns.add(value);
    patterns.add(JSON.stringify(value).slice(1, -1));
  }

  return [...patterns].sort((a, b) => b.length - a.length);
}

export function redactSecretText(text: string, patterns: readonly string[]): string {
  for (const pattern of patterns) text = text.split(pattern).join("[REDACTED]");

  return text;
}
