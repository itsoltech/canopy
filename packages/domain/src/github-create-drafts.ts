import type { github } from "@canopy/contracts";

export interface CreateDraft {
  title: string;
  body: string;
  draft: boolean;
  consent: boolean;
  receipt?: github.PullRequestMutationReceipt | undefined;
}

/** Client memory only; a remount must retain the text and any unresolved effect. */
export class GitHubCreateDrafts {
  #drafts = new Map<string, CreateDraft>();
  read(thread: string): CreateDraft {
    return this.#drafts.get(thread) ?? { title: "", body: "", draft: true, consent: false };
  }
  save(thread: string, draft: CreateDraft) {
    this.#drafts.delete(thread);

    if (draft.receipt?.state !== "succeeded") this.#drafts.set(thread, draft);

    if (this.#drafts.size > 100) this.#drafts.delete(this.#drafts.keys().next().value ?? "");
  }
}
