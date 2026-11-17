import { num, objectsOf, parseObject, str } from "#lib/shared/json.ts";

export interface DiffComment {
  id: string;
  snapshotId: string;
  path: string;
  side: "old" | "new";
  line: number;
  source: string;
  text: string;
}

export interface DiffBatch {
  requestId: string;
  summary: string;
  comments: DiffComment[];
}

export interface DiffDraft {
  comments: DiffComment[];
  summary: string;
  pending?: DiffBatch;
}

const EMPTY: DiffDraft = { comments: [], summary: "" };
const MAX_BYTES = 2 * 1024 * 1024;
let records = $state.raw<ReadonlyMap<string, DiffDraft>>(new Map());
let storageKey = "";
let scopeRevision = 0;
const privateStates = new Set<WeakRef<{ dispose(): void }>>();

export function registerDiffState(state: { dispose(): void }): void {
  privateStates.add(new WeakRef(state));
}

function clearPrivateState(): void {
  for (const reference of privateStates) reference.deref()?.dispose();
  privateStates.clear();
}

export const diffScopeRevision = () => scopeRevision;
export const diffDraft = (threadId: string): DiffDraft => records.get(threadId) ?? EMPTY;

function decodeComments(value: Parameters<typeof objectsOf>[0]): DiffComment[] {
  return objectsOf(value)
    .slice(0, 100)
    .flatMap((entry) => {
      const side = str(entry.side);
      const line = num(entry.line);

      if ((side !== "old" && side !== "new") || !Number.isSafeInteger(line) || line < 1) return [];

      return [
        {
          id: str(entry.id),
          snapshotId: str(entry.snapshotId),
          path: str(entry.path),
          side,
          line,
          source: str(entry.source).slice(0, 48 * 1024),
          text: str(entry.text).slice(0, 4000),
        },
      ];
    });
}

function restore(raw: string): Map<string, DiffDraft> {
  const restored = new Map<string, DiffDraft>();

  for (const entry of objectsOf(parseObject(raw).threads).slice(0, 100)) {
    const threadId = str(entry.threadId);
    const comments = decodeComments(entry.comments);
    const summary = str(entry.summary).slice(0, 4000);
    const pendingValue = objectsOf(entry.pending)[0];

    const pending = pendingValue
      ? {
          requestId: str(pendingValue.requestId),
          summary: str(pendingValue.summary).slice(0, 4000),
          comments: decodeComments(pendingValue.comments),
        }
      : undefined;

    if (threadId && (comments.length || summary || pending?.requestId))
      restored.set(threadId, { comments, summary, pending });
  }

  return restored;
}

/** Only the trusted owner + endpoint scope used by the workspace may enable persistence. */
export function connectDiffDrafts(scope: string): () => void {
  clearPrivateState();
  scopeRevision++;
  storageKey = `canopy.diff-drafts.v1.${encodeURIComponent(scope)}`;
  records = new Map();

  try {
    const raw = localStorage.getItem(storageKey);

    if (raw && raw.length <= MAX_BYTES && new TextEncoder().encode(raw).byteLength <= MAX_BYTES) records = restore(raw);
  } catch {
    // An unavailable browser store still permits an in-memory review.
  }

  return () => {
    clearPrivateState();
    scopeRevision++;
    storageKey = "";
    records = new Map();
  };
}

/** Reject oversized edits without dropping another thread's draft. */
export function saveDiffDraft(threadId: string, draft: DiffDraft): string {
  const next = new Map(records);

  if (draft.comments.length || draft.summary || draft.pending) next.set(threadId, draft);
  else next.delete(threadId);

  const raw = JSON.stringify({
    threads: [...next].map(([threadId, entry]) => ({
      threadId,
      ...entry,
      pending: entry.pending ? [entry.pending] : [],
    })),
  });

  if (
    raw.length > MAX_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_BYTES ||
    next.size > 100 ||
    draft.comments.length > 100
  )
    return "Review storage is full. Send or remove comments before adding more.";
  records = next;

  if (storageKey) {
    try {
      localStorage.setItem(storageKey, raw);
    } catch {
      return "This review is saved only in this window. Allow browser storage to keep it after closing.";
    }
  }

  return "";
}
