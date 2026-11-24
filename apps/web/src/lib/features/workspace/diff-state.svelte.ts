import { HttpError } from "#lib/shared/http.ts";
import type { Workspace } from "@canopy/domain/workspace";
import { listThreadDiff, ThreadDiffError, type ThreadDiffFile } from "./diff-api.ts";
import { DiffPages } from "./diff-pages.svelte.ts";
import { DiffReview } from "./diff-review.svelte.ts";
import { workspaceStore } from "./workspace.svelte.ts";
import { registerDiffState } from "./diff-drafts.svelte.ts";

export { connectDiffDrafts } from "./diff-drafts.svelte.ts";

const failures = new Map([
  [
    ThreadDiffError.NOT_REPOSITORY,
    "This directory has no Git repository. Open a thread in a Git directory to review changes.",
  ],
  [ThreadDiffError.TOO_LARGE, "These changes exceed the review limit. Reduce the changes, then refresh."],
  [ThreadDiffError.BUSY, "Git is busy. Wait for the current Git operation, then refresh."],
  [ThreadDiffError.CHANGED, "Files changed while loading. Refresh changes to try again."],
]);

export class DiffState {
  files = $state.raw<ThreadDiffFile[]>([]);
  snapshotId = $state("");
  loading = $state(false);
  loaded = $state(false);
  checkoutRevision = $state(0);
  error = $state("");
  activePath = $state("");
  target = $state<{ path: string; revision: number }>();
  scroll = 0;
  navigated = 0;
  readonly pages: DiffPages;
  readonly review: DiffReview;
  #read?: AbortController;
  #generation = 0;

  constructor(readonly view: Workspace) {
    this.pages = new DiffPages(view.threadId, () => this.accessEnded());
    this.review = new DiffReview(view.threadId);
    registerDiffState(this);
  }

  ensure(): void {
    if (!this.loaded && !this.loading) void this.refresh();
  }

  open(path = ""): void {
    this.view.openModule({ module: "diff", resource: "", label: "Diff" });

    if (path) {
      this.activePath = path;
      this.target = { path, revision: (this.target?.revision ?? 0) + 1 };
    }

    this.ensure();
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    const generation = ++this.#generation;
    this.#read = new AbortController();
    this.loading = true;
    this.error = "";

    try {
      const snapshot = await listThreadDiff(this.view.threadId, this.#read.signal);

      if (generation !== this.#generation) return;

      if (snapshot.error !== ThreadDiffError.UNSPECIFIED || !snapshot.complete) {
        this.error = failures.get(snapshot.error) ?? "Changes could not be loaded. Refresh changes to try again.";

        return;
      }

      this.pages.pause();
      this.files = snapshot.files;
      this.snapshotId = snapshot.snapshotId;
      this.scroll = 0;

      if (!snapshot.files.some((file) => file.path === this.activePath))
        this.activePath = snapshot.files[0]?.path ?? "";
    } catch (cause) {
      if (cause instanceof HttpError && [401, 403, 404].includes(cause.status) && generation === this.#generation) {
        this.accessEnded();

        return;
      }

      if (generation === this.#generation)
        this.error = "Changes could not be loaded. Check the worker connection, then refresh.";
    } finally {
      if (generation === this.#generation) {
        this.loaded = true;
        this.loading = false;
        this.#read = undefined;
      }
    }
  }

  changeCheckout(): void {
    this.dispose();
    this.checkoutRevision++;
  }

  private accessEnded(): void {
    this.dispose();
    this.loaded = true;
    this.error = "Access to these changes ended. Reopen the thread to check access.";
  }

  dispose(): void {
    this.#generation++;
    this.#read?.abort();
    this.#read = undefined;
    this.pages.pause();
    this.review.dispose();
    this.files = [];
    this.snapshotId = "";
    this.loaded = false;
    this.loading = false;
    this.error = "";
    this.activePath = "";
    this.target = undefined;
    this.scroll = 0;
    this.navigated = 0;
  }
}

const states = new WeakMap<Workspace, DiffState>();

workspaceStore.watchFiles((change) => {
  if (!change?.checkoutChanged) return;
  const view = workspaceStore.views.get(change.threadId);

  if (view) states.get(view)?.changeCheckout();
});

export function getDiffState(view: Workspace): DiffState {
  let state = states.get(view);

  if (!state) {
    state = new DiffState(view);
    states.set(view, state);
  }

  return state;
}
