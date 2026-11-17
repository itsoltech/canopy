import { sendMessage } from "#lib/features/threads/api.ts";
import { HttpError } from "#lib/shared/http.ts";
import { diffDraft, diffScopeRevision, saveDiffDraft, type DiffBatch, type DiffComment } from "./diff-drafts.svelte.ts";

function reviewMessage(batch: DiffBatch): string {
  const comments = batch.comments.map((comment, index) => {
    const context = JSON.stringify({
      snapshotId: comment.snapshotId,
      path: comment.path,
      side: comment.side,
      line: comment.line,
      source: comment.source,
    });

    return `${index + 1}. ${comment.text}\nOriginal line context: ${context}`;
  });

  return ["Review of local Git changes against HEAD", batch.summary, ...comments].filter(Boolean).join("\n\n");
}

export class DiffReview {
  open = $state(false);
  sending = $state(false);
  error = $state("");
  notice = $state("");
  #abort?: AbortController;
  #generation = 0;

  constructor(readonly threadId: string) {}

  get draft() {
    return diffDraft(this.threadId);
  }

  save(summary: string): void {
    this.notice = saveDiffDraft(this.threadId, { ...this.draft, summary: summary.slice(0, 4000) });
  }

  add(context: Omit<DiffComment, "id" | "text">, text: string): boolean {
    const comments = [
      ...this.draft.comments,
      {
        ...context,
        source: context.source.slice(0, 48 * 1024),
        id: crypto.randomUUID(),
        text: text.trim().slice(0, 4000),
      },
    ];

    const previous = this.draft;
    this.notice = saveDiffDraft(this.threadId, { ...previous, comments });

    return this.draft !== previous;
  }

  edit(id: string, text: string): void {
    if (this.locked(id)) return;
    this.notice = saveDiffDraft(this.threadId, {
      ...this.draft,
      comments: this.draft.comments.map((comment) =>
        comment.id === id ? { ...comment, text: text.slice(0, 4000) } : comment,
      ),
    });
  }

  remove(id: string): void {
    if (this.locked(id)) return;
    this.notice = saveDiffDraft(this.threadId, {
      ...this.draft,
      comments: this.draft.comments.filter((comment) => comment.id !== id),
    });
  }

  locked(id: string): boolean {
    return Boolean(this.draft.pending?.comments.some((comment) => comment.id === id));
  }

  async send(): Promise<void> {
    if (this.sending) return;
    const draft = this.draft;

    if (!draft.pending && !draft.comments.length && !draft.summary.trim()) return;

    if ((draft.pending?.comments ?? draft.comments).some((comment) => !comment.text.trim())) {
      this.error = "A comment is empty. Write a comment or remove it before sending.";

      return;
    }

    const pending = draft.pending ?? {
      requestId: crypto.randomUUID(),
      summary: draft.summary,
      comments: draft.comments.map((comment) => ({ ...comment })),
    };

    const message = reviewMessage(pending);

    if (
      message.length > 100_000 ||
      new TextEncoder().encode(JSON.stringify({ text: message, clientRequestId: pending.requestId, delivery: "queue" }))
        .byteLength >
        400 * 1024
    ) {
      this.error = "The review is too large. Shorten or remove comments before sending.";

      return;
    }

    this.notice = saveDiffDraft(this.threadId, { ...draft, pending });

    if (this.draft.pending !== pending) return;
    const scope = diffScopeRevision();
    const generation = ++this.#generation;
    this.#abort = new AbortController();
    this.sending = true;
    this.error = "";

    try {
      await sendMessage(this.threadId, message, pending.requestId, {}, "queue", [], [], [], undefined, {
        signal: this.#abort.signal,
      });

      if (scope !== diffScopeRevision() || generation !== this.#generation) return;
      const current = this.draft;
      this.notice = saveDiffDraft(this.threadId, {
        comments: current.comments.filter(
          (comment) => !pending.comments.some((sent) => sent.id === comment.id && sent.text === comment.text),
        ),
        summary: current.summary === pending.summary ? "" : current.summary,
      });
      this.open = false;
    } catch (cause) {
      if (scope !== diffScopeRevision() || generation !== this.#generation) return;

      if (cause instanceof HttpError && !draft.pending && [400, 401, 403, 404, 409, 413, 422].includes(cause.status)) {
        this.notice = saveDiffDraft(this.threadId, { ...this.draft, pending: undefined });
        this.error = "The review was not sent. Edit the comments or reopen the thread, then retry.";
      } else {
        this.error = "The review could not be confirmed. Check the connection, then retry the saved review.";
      }
    } finally {
      if (generation === this.#generation) {
        this.sending = false;
        this.#abort = undefined;
      }
    }
  }

  dispose(): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = undefined;
    this.sending = false;
    this.open = false;
    this.error = "";
    this.notice = "";
  }
}
