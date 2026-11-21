import { create, fromJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import { ui } from "@canopy/contracts";
import { DEFAULT_ATTACHMENT_LIMITS } from "@canopy/domain";
import { Schema } from "effect";
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { draftDelivery } from "#lib/features/drafts/api.ts";
import { webDrafts } from "#lib/features/drafts/local.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import type { WebComposerDraft } from "#lib/features/drafts/state.svelte.ts";
import { prepareDraftForm } from "#lib/features/drafts/form.ts";
import { bodyJson } from "#lib/shared/json.ts";
import { FEED_POSITION_TIMEOUT_MS } from "#lib/shared/ui/virtual/feed-scroll-memory.svelte.ts";

const Step = Schema.Struct({
  step: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "skipped", "failed"]),
  detail: Schema.String,
});

const Snapshot = Schema.Struct({
  requestId: Schema.String,
  message: Schema.String,
  projectId: Schema.String,
  workspaceId: Schema.optionalKey(Schema.String),
  steps: Schema.Array(Step),
  threadId: Schema.String,
  done: Schema.Boolean,
  error: Schema.String,
  preparationRejected: Schema.optionalKey(Schema.Boolean),
});

const Accepted = Schema.Struct({ requestId: Schema.String });

const Rejected = Schema.Struct({ message: Schema.String });

export type PreparationStep = typeof Step.Type;

export type CreationSnapshot = typeof Snapshot.Type;

export const startingPath = (id: string) => `/threads/starting/${encodeURIComponent(id)}`;

/** A job outlives its page. Only a confirmed thread consumes the draft. */
export class ThreadCreation {
  readonly at = timestampFromMs(Date.now());
  readonly model: string;
  scroll: ThreadScrollPosition = { mode: "anchor", key: "creation:start", offset: -8 };
  handoff = $state(false);
  capture: (() => void) | undefined;
  snapshot = $state<CreationSnapshot>();
  content = $state<ui.ComposerDraftContent>();
  notice = $state("");
  submitting = $state(false);
  unavailable = $state(false);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #handoffTimer: ReturnType<typeof setTimeout> | undefined;
  #polling = false;
  #stopped = false;
  #rejected = false;
  #draft = $state.raw<WebComposerDraft>();
  readonly #local = webDrafts.local;
  readonly #scope = webDrafts.scope;

  constructor(
    readonly requestId: string,
    draft?: WebComposerDraft,
    form?: FormData,
  ) {
    this.#draft = draft;
    const pending = draft?.pendingForm ? new URLSearchParams(draft.pendingForm) : undefined;
    const encoded = pending?.get("composerContent") ?? form?.get("composerContent");
    this.model = pending?.get("model") ?? String(form?.get("model") ?? "");
    this.content = encoded ? fromJsonString(ui.ComposerDraftContentSchema, String(encoded)) : draft?.outgoing();
    this.snapshot = {
      requestId,
      message: this.content?.text ?? "",
      projectId: pending?.get("projectId") ?? String(form?.get("projectId") ?? ""),
      workspaceId: pending?.get("workspaceId") ?? String(form?.get("workspaceId") ?? ""),
      steps: [{ step: "check_workspace", label: "Check workspace", status: "running", detail: "" }],
      threadId: "",
      done: false,
      error: "",
      preparationRejected: false,
    };

    this.#updateDraft();
  }

  get hasDraft() {
    return Boolean(this.#draft && !this.#draft.retired);
  }

  #matchingDraft() {
    const draft = this.#draft;

    return draft?.requestId === this.requestId && !draft.retired ? draft : undefined;
  }

  attachDraft(draft: WebComposerDraft) {
    this.#draft = draft;
    this.#updateDraft();
  }

  #updateDraft() {
    const draft = this.#matchingDraft();
    const snapshot = this.snapshot;

    if (snapshot?.threadId && this.current && !devicePreferences.view.onboardingSent)
      devicePreferences.setView({ onboardingSent: true });

    if (
      !draft ||
      (draft.pendingForm && new URLSearchParams(draft.pendingForm).get("clientRequestId") !== this.requestId)
    )
      return;

    const wasPreparing = draft.preparing;
    draft.preparing = this.submitting || Boolean(snapshot && !snapshot.done && !this.unavailable && !this.notice);

    if (draft.preparing || !draft.pendingForm) return;

    if (snapshot?.threadId) {
      draft.clear();
      this.#draft = undefined;
    } else if (snapshot?.preparationRejected) draft.rejectForm(this.requestId);
    else if (wasPreparing && !this.unavailable) void draft.reconcile();
  }

  get current() {
    void webDrafts.generation;

    return !this.#stopped && !this.#local.closed && this.#local === webDrafts.local && this.#scope === webDrafts.scope;
  }

  get retryable() {
    return this.#rejected && !this.submitting && this.current;
  }

  finishHandoff(feed: CreationFeedReader | undefined, expectsAnchor: boolean) {
    if (this.handoff || !this.current || !feed) return;
    this.capture?.();

    if (!expectsAnchor || feed.restorePosition(this.scroll)) {
      clearTimeout(this.#handoffTimer);
      this.handoff = true;
    } else if (!this.#handoffTimer) {
      // An absent row must not keep the confirmed thread inert indefinitely.
      this.#handoffTimer = setTimeout(() => {
        if (!this.current || this.handoff) return;
        this.capture?.();
        feed.restorePosition(this.scroll);
        this.handoff = true;
      }, FEED_POSITION_TIMEOUT_MS);
    }
  }

  stop() {
    this.#stopped = true;
    this.capture = undefined;
    clearTimeout(this.#timer);
    clearTimeout(this.#handoffTimer);

    const draft = this.#matchingDraft();

    if (draft) draft.preparing = false;
    this.#draft = undefined;
    this.content = undefined;
    this.snapshot = undefined;
  }

  async submit(form: FormData) {
    const draft = this.#matchingDraft();

    if (!draft || !this.current) return;
    this.submitting = true;
    draft.preparing = true;
    this.#rejected = false;
    this.notice = "";
    this.unavailable = false;

    if (this.snapshot)
      this.snapshot = {
        ...this.snapshot,
        steps: [{ step: "check_workspace", label: "Check workspace", status: "running", detail: "" }],
        done: false,
        error: "",
        preparationRejected: false,
      };

    try {
      await prepareDraftForm(draft, form);

      if (!this.current || this.#matchingDraft() !== draft) return;

      const response = await fetch("/api/thread-creations", {
        method: "POST",
        body: form,
        headers: { "x-requested-with": "canopy" },
        signal: AbortSignal.timeout(40_000),
      });

      if (!this.current) return;

      if (!response.ok) {
        if (response.status < 500 && ![408, 409].includes(response.status)) {
          // These BFF responses precede job admission. Never infer rejection from a lost response or GET 404.
          this.#rejected = [400, 403, 413, 429].includes(response.status);

          const rejected = await bodyJson(response)
            .then(Schema.decodeUnknownSync(Rejected))
            .catch(() => ({ message: "Canopy could not accept this message." }));

          if (this.current && this.#matchingDraft() === draft && this.snapshot)
            this.snapshot = { ...this.snapshot, steps: [], done: true, error: rejected.message };
        } else {
          this.notice = "Could not confirm the thread started. Your draft is saved.";
        }
      } else {
        const accepted = Schema.decodeUnknownSync(Accepted)(await bodyJson(response));

        if (accepted.requestId !== this.requestId) throw new Error("Unexpected creation response");
      }
    } catch {
      if (this.current) this.notice = "Could not confirm the thread started. Your draft is saved.";
    } finally {
      this.submitting = false;

      if (this.current) {
        this.#updateDraft();
        void this.refresh();
      }
    }
  }

  async refresh() {
    clearTimeout(this.#timer);

    if (!this.current || this.#polling || this.submitting || this.snapshot?.done) return;
    this.#polling = true;
    let delay = 400;

    try {
      const response = await fetch(`/api/thread-creations/${encodeURIComponent(this.requestId)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });

      if (!this.current) return;

      if (response.status === 404) {
        this.unavailable = true;
        this.notice = "Thread progress is unavailable.";
        this.#updateDraft();
        await this.#recoverDelivery();

        return;
      }

      if (!response.ok) throw new Error("Progress unavailable");
      const snapshot = Schema.decodeUnknownSync(Snapshot)(await bodyJson(response));

      if (!this.current || snapshot.requestId !== this.requestId) return;
      this.snapshot = { ...snapshot, workspaceId: snapshot.workspaceId || this.snapshot?.workspaceId || "" };
      this.notice = "";
      this.unavailable = false;

      if (!this.content) this.content = create(ui.ComposerDraftContentSchema, { text: snapshot.message });
    } catch {
      if (this.current) this.notice = "Progress updates paused. Checking the connection…";
      delay = 2000;
    } finally {
      this.#polling = false;

      if (this.current) this.#updateDraft();

      if (this.current && !this.unavailable && !this.snapshot?.done)
        this.#timer = setTimeout(() => void this.refresh(), delay);
    }
  }

  async #recoverDelivery() {
    const draft = this.#matchingDraft();

    if (!draft?.pendingForm) return;
    const form = new URLSearchParams(draft.pendingForm);

    const delivery = await draftDelivery(
      create(ui.GetComposerDraftDeliveryRequestSchema, {
        id: form.get("draftId") || draft.id,
        workspaceId: form.get("workspaceId") ?? "",
        clientRequestId: this.requestId,
      }),
    ).catch(() => undefined);

    if (!this.current || this.#matchingDraft() !== draft || !this.snapshot) return;

    if (delivery?.confirmed && delivery.threadId) {
      this.snapshot = { ...this.snapshot, done: true, threadId: delivery.threadId, steps: [] };
    } else if (delivery?.inFlight) {
      this.#timer = setTimeout(() => void this.refresh(), 3000);
    } else if (delivery?.confirmed) draft.clear();
    else draft.deliveryChecked = true;
  }
}

class ThreadCreations {
  #local = webDrafts.local;
  #jobs = new SvelteMap<string, ThreadCreation>();

  constructor() {
    $effect.root(() => {
      $effect(() => {
        void webDrafts.generation;
        untrack(() => this.#scoped());
      });
    });
  }

  #scoped() {
    void webDrafts.generation;

    if (this.#local === webDrafts.local && !this.#local.closed) return;

    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
    this.#local = webDrafts.local;
  }

  #remember(job: ThreadCreation) {
    while (this.#jobs.size >= 40) {
      const oldest = this.#jobs.entries().next().value;

      if (!oldest) break;
      oldest[1].stop();
      this.#jobs.delete(oldest[0]);
    }

    this.#jobs.set(job.requestId, job);

    return job;
  }

  resume(id: string, draft?: WebComposerDraft) {
    this.#scoped();
    const existing = this.#jobs.get(id);

    if (existing) {
      if (draft) existing.attachDraft(draft);

      if (existing.unavailable) void existing.refresh();

      return existing;
    }

    const entry = draft
      ? undefined
      : webDrafts.local.list().find((value) => value.pendingForm && value.draft?.content?.clientRequestId === id);

    if (entry?.draft?.target) draft = webDrafts.get(entry.draft.target, () => DEFAULT_ATTACHMENT_LIMITS);
    draft?.activate();
    const job = this.#remember(new ThreadCreation(id, draft));
    void job.refresh();

    return job;
  }

  async start(draft: WebComposerDraft, form: FormData) {
    this.#scoped();
    // Editing a pending draft rotates its key before hidden form fields update.
    let requestId = new URLSearchParams(draft.pendingForm).get("clientRequestId") || draft.requestId;
    let existing = this.#jobs.get(requestId);

    existing?.attachDraft(draft);

    if (existing?.snapshot?.preparationRejected && draft.requestId !== requestId) {
      requestId = draft.requestId;
      existing = undefined;
    }

    form.set("clientRequestId", requestId);
    const job = existing ?? this.#remember(new ThreadCreation(requestId, draft, form));
    const submit = !existing || existing.retryable;

    // The send survives an interrupted navigation to the progress view.
    const opening = goto(startingPath(job.requestId));

    if (submit) {
      await Promise.all([opening, job.submit(form)]);
    } else {
      void job.refresh();
      await opening;
    }
  }

  forThread(threadId: string) {
    return [...this.#jobs.values()].find((job) => job.current && job.snapshot?.threadId === threadId);
  }

  completed(threadId: string) {
    const snapshot = this.forThread(threadId)?.snapshot;

    return snapshot?.steps.length ? snapshot : undefined;
  }
}

export const threadCreations = new ThreadCreations();

export function threadCreationHandoff(read: () => { threadId: string; requestId?: string | undefined }) {
  const target = $derived(read());
  let observed = $state.raw<{ threadId: string; job: ThreadCreation }>();

  $effect(() => {
    const { threadId, requestId } = target;
    void webDrafts.generation;

    if (requestId && webDrafts.ready) {
      observed = { threadId, job: untrack(() => threadCreations.resume(requestId)) };
    }
  });

  const job = $derived(
    threadCreations.forThread(target.threadId) ??
      (observed?.threadId === target.threadId && (!target.requestId || observed.job.requestId === target.requestId)
        ? observed.job
        : undefined),
  );

  return () => (job?.current && !job.handoff && !job.unavailable ? job : undefined);
}

export interface CreationFeedReader {
  restorePosition(position: ThreadScrollPosition): boolean;
}

export function finishCreationHandoff(
  job: ThreadCreation | undefined,
  feed: CreationFeedReader | undefined,
  expectsAnchor: boolean,
) {
  job?.finishHandoff(feed, expectsAnchor);
}
