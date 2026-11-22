import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";
import type { MobileDrafts } from "../drafts/manager";
import type { MobileComposerState } from "../drafts/store";
import { createFromDraft } from "../drafts/create";
import { uncertainDelivery } from "../threads/pending-message";
import { streamThreadCreation } from "./creation-stream";

export interface ThreadCreation {
  id: string;
  request: ui.CreateThreadRequest;
  attachments: readonly ui.Attachment[];
  projectName: string;
  steps: readonly ui.CreateThreadProgress[];
  done: boolean;
  error: string;
  uncertain: boolean;
  threadId: string;
  confirmed: boolean;
  /** User's choice survives the route handoff and timeline row remounts for this job. */
  preparationExpanded?: boolean;
  /** Volatile reading position relative to both edges of the first-turn timeline. */
  preparationAnchor?: { fromOldest: number; distance: number };
}

interface CreationJob extends ThreadCreation {
  draft: MobileComposerState | undefined;
  controller: AbortController;
  running: boolean;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

const FAILED = "Could not start the thread. Return to your draft and try again.";
const UNCONFIRMED = "Thread start not confirmed. Return to your draft to check delivery before editing.";

/** Pairing-owned operations outlive screens. Only confirmed outcomes release the durable message. */
export class MobileThreadCreations {
  #jobs = new Map<string, CreationJob>();
  #listeners = new Set<() => void>();
  #version = 0;
  #closed = false;
  constructor(
    readonly api: Client<typeof ui.GatewayService>,
    readonly drafts: MobileDrafts,
  ) {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  snapshot = () => this.#version;
  get(id: string): ThreadCreation | undefined {
    return this.#jobs.get(id);
  }
  forThread(threadId: string): ThreadCreation | undefined {
    return threadId ? [...this.#jobs.values()].find((job) => job.threadId === threadId) : undefined;
  }
  prepare(
    request: ui.CreateThreadRequest,
    draft: MobileComposerState | undefined,
    attachments: readonly ui.Attachment[],
    projectName = "",
  ) {
    const outgoing =
      draft?.pendingCreate ??
      create(ui.CreateThreadRequestSchema, {
        ...request,
        clientRequestId: draft?.requestId ?? request.clientRequestId,
      });

    const previous = this.#jobs.get(outgoing.clientRequestId);

    if (previous && (!previous.done || previous.threadId || previous.uncertain)) return previous;

    if (this.#closed || !outgoing.clientRequestId || draft?.local.closed) return undefined;

    if (!previous && this.#jobs.size >= 40) {
      const oldest = [...this.#jobs.values()].find((job) => job.done && !job.uncertain);

      if (!oldest) return undefined;
      this.#jobs.delete(oldest.id);
    }

    const job: CreationJob = {
      id: outgoing.clientRequestId,
      request: clone(ui.CreateThreadRequestSchema, outgoing),
      attachments: attachments.map((file) => clone(ui.AttachmentSchema, file)),
      projectName,
      steps: [],
      done: false,
      error: "",
      uncertain: false,
      threadId: "",
      confirmed: false,
      draft,
      controller: new AbortController(),
      running: false,
      failures: 0,
    };

    if (draft) draft.creationRecoveryOwned = true;
    this.#jobs.set(job.id, job);
    this.#changed();

    return job;
  }
  start(id: string) {
    const job = this.#jobs.get(id);

    if (!job || job.running || this.#closed) return;

    if (job.uncertain) {
      job.failures = 0;
      void this.#recover(job);

      return;
    }

    if (job.done) return;

    // Restored immutable requests are checked, never blindly submitted again.
    if (job.draft?.pendingCreate) {
      job.uncertain = true;
      void this.#recover(job);

      return;
    }

    job.running = true;
    void this.#run(job);
  }
  restore(id: string): ThreadCreation | undefined {
    const existing = this.#jobs.get(id);

    if (existing || this.#closed) return existing;

    for (const entry of this.drafts.local.list()) {
      if (!entry.pendingCreate.length || !entry.draft?.target) continue;
      const draft = this.drafts.get(entry.draft.target);

      if (draft.pendingCreate?.clientRequestId !== id) continue;

      const job = this.prepare(
        draft.pendingCreate,
        draft,
        draft.files.current.flatMap((f) => (f.attachment ? [f.attachment] : [])),
      );

      if (job) this.start(job.id);

      return job;
    }

    return undefined;
  }
  reconnect() {
    if (this.#closed) return;

    for (const entry of this.drafts.local.list()) {
      if (!entry.pendingCreate.length || !entry.draft?.target) continue;
      const draft = this.drafts.get(entry.draft.target);

      if (draft.pendingCreate && !draft.preparing) this.restore(draft.pendingCreate.clientRequestId);
    }

    for (const job of this.#jobs.values()) if (job.uncertain && !job.running) void this.#recover(job);
  }
  dispose() {
    this.#closed = true;

    for (const job of this.#jobs.values()) {
      clearTimeout(job.timer);
      job.controller.abort();

      if (job.draft?.requestId === job.id) job.draft.creationRecoveryOwned = false;
    }

    this.#jobs.clear();
    this.#changed();
    this.#listeners.clear();
  }
  #changed() {
    this.#version++;

    for (const listener of this.#listeners) listener();
  }
  #progress(job: CreationJob, event: ui.CreateThreadProgress) {
    if (this.#closed) return;
    const previous = job.steps.findIndex((step) => step.step === event.step);
    job.steps =
      previous < 0 ? [...job.steps, event] : job.steps.map((step, index) => (index === previous ? event : step));
    this.#changed();
  }
  #completed(job: CreationJob, threadId: string) {
    if (this.#closed) return;
    job.threadId = threadId;
    job.confirmed = true;
    job.done = true;
    job.uncertain = false;
    job.error = threadId ? "" : "Thread started. Open it from your thread list.";
    job.steps = job.steps.filter((step) => step.status === "completed" || step.status === "skipped");

    if (job.draft && !job.draft.local.closed && job.draft.requestId === job.id) {
      job.draft.creationRecoveryOwned = false;
      job.draft.clear();
    }

    this.#changed();
  }
  async #run(job: CreationJob) {
    try {
      const result = await createFromDraft(this.api, job.draft, job.request, (outgoing) => {
        job.request = clone(ui.CreateThreadRequestSchema, outgoing);

        return streamThreadCreation(this.api, outgoing, (event) => this.#progress(job, event), job.controller.signal);
      });

      if (result.thread) this.#completed(job, result.thread.id);
      else throw new Error("Missing thread result");
    } catch (cause) {
      if (this.#closed) return;
      job.uncertain = uncertainDelivery(cause);
      job.done = !job.uncertain;
      job.error = job.uncertain ? "Connection lost. Checking whether the thread started…" : FAILED;

      if (!job.uncertain && job.draft?.requestId === job.id) job.draft.creationRecoveryOwned = false;
    } finally {
      job.running = false;

      if (!this.#closed) {
        this.#changed();

        if (job.uncertain) void this.#recover(job);
      }
    }
  }
  #allowDraftRecovery(job: CreationJob) {
    if (!job.draft || job.draft.local.closed || job.draft.requestId !== job.id) return;
    job.draft.deliveryChecked = true;
    job.draft.persist();
  }
  async #recover(job: CreationJob) {
    if (this.#closed || job.running) return;
    clearTimeout(job.timer);
    job.running = true;
    job.uncertain = true;
    job.done = false;
    job.error = "Checking whether the thread started…";

    if (job.draft && !job.draft.local.closed && job.draft.requestId === job.id) {
      job.draft.deliveryChecked = false;
      job.draft.persist();
    }

    this.#changed();

    try {
      const status = await this.api.getComposerDraftDelivery(
        {
          id: job.request.draftId,
          workspaceId: job.request.workspaceId,
          clientRequestId: job.id,
        },
        { signal: job.controller.signal, timeoutMs: 15_000 },
      );

      if (this.#closed) return;

      if (status.confirmed) {
        this.#progress(
          job,
          create(ui.CreateThreadProgressSchema, {
            step: "start_thread",
            label: "Start thread",
            status: "completed",
          }),
        );
        this.#completed(job, status.threadId);
      } else if (status.inFlight) {
        job.failures = 0;
        job.timer = setTimeout(() => void this.#recover(job), 3000);
      } else {
        job.done = true;
        job.error = UNCONFIRMED;
        this.#allowDraftRecovery(job);
      }
    } catch {
      if (!this.#closed) {
        job.failures++;
        job.done = true;
        job.error = UNCONFIRMED;
        this.#allowDraftRecovery(job);

        if (job.failures < 5)
          job.timer = setTimeout(() => void this.#recover(job), Math.min(3000 * 2 ** (job.failures - 1), 30_000));
      }
    } finally {
      job.running = false;

      if (!this.#closed) this.#changed();
    }
  }
}
