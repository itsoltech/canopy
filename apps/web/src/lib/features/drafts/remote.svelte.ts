import type { ui } from "@canopy/contracts";
import { loadComposerDraftPages } from "@canopy/domain/composer-drafts";
import { listDrafts } from "./api.ts";
import { webDrafts } from "./local.svelte.ts";
import { subscribeDraftChanges } from "./invalidation.ts";

/** One bounded list and one refresh per client, shared by composer tabs and sidebar markers. */
class RemoteDrafts {
  rows = $state<ui.ComposerDraft[]>([]);
  next = $state("");
  threadIds = $state<string[]>([]);
  #scope = "";
  #loaded = false;
  #pending: Promise<void> | undefined;
  #users = 0;
  #stop: (() => void) | undefined;
  async load(more = false): Promise<void> {
    if (!webDrafts.ready) return;

    if (this.#scope !== webDrafts.scope) {
      this.#scope = webDrafts.scope;
      this.rows = [];
      this.threadIds = [];
      this.next = "";
      this.#loaded = false;
    }

    if (this.#pending) {
      await this.#pending;

      if (!more) return;
    }

    if (!more && this.#loaded) return;
    const scope = this.#scope;
    const sourceIds = webDrafts.local.sourceDraftIds();
    this.#pending = loadComposerDraftPages(
      (token) => listDrafts(webDrafts.deviceId, "", token, sourceIds),
      more ? this.next : "",
    ).then((page) => {
      if (scope !== webDrafts.scope) return;
      webDrafts.acceptMoves(page.moves);
      this.threadIds = page.threadIds;
      this.rows = more
        ? [...new Map([...this.rows, ...page.drafts].map((row) => [row.id, row])).values()].slice(0, 100)
        : page.drafts;
      this.next = page.nextPageToken;
      this.#loaded = true;
    });

    try {
      await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }
  subscribe() {
    this.#users++;

    if (this.#users === 1)
      this.#stop = subscribeDraftChanges(() => {
        const pending = this.#pending;
        void Promise.resolve(pending)
          .catch(() => {})
          .then(() => {
            this.#loaded = false;

            return this.load();
          })
          .catch(() => {});
      });

    return () => {
      if (--this.#users === 0) {
        this.#stop?.();
        this.#stop = undefined;
      }
    };
  }
  invalidate() {
    this.#loaded = false;
  }
}

export const remoteDrafts = new RemoteDrafts();
