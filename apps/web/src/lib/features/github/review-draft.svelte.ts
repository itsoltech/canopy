import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { reviewComplete, reviewRevision } from "@canopy/domain/github-review";
import * as api from "./api.ts";

export class ReviewDraft {
  pages = $state<github.PullRequestReviewDraft[]>([]);
  busy = $state(false);
  error = $state("");
  #generation = 0;
  constructor(
    readonly id: string,
    readonly head: string,
  ) {}
  get pendingId() {
    return this.pages[0]?.id ?? "";
  }
  get count() {
    return this.pages[0]?.totalCount ?? 0;
  }
  get complete() {
    return !this.error && !this.busy && reviewComplete(this.pages);
  }
  get revision() {
    return reviewRevision(this.pages);
  }
  async read(more = false) {
    if (this.busy) return;
    const version = ++this.#generation;
    this.busy = true;
    this.error = "";

    try {
      const page = await api.page(
        "review-draft",
        github.PullRequestReviewDraftSchema,
        create(github.PullRequestPageRequestSchema, {
          pullRequestId: this.id,
          headSha: this.head,
          cursor: more ? (this.pages.at(-1)?.page?.nextCursor ?? "") : "",
          refresh: true,
        }),
      );

      if (version === this.#generation)
        this.pages = more
          ? [...this.pages, page]
          : this.pages[0]?.revision === page.revision
            ? [page, ...this.pages.slice(1)]
            : [page];
    } catch {
      if (version === this.#generation)
        this.error = "Could not load the pending review. Refresh and check account access.";
    } finally {
      if (version === this.#generation) this.busy = false;
    }
  }
  close() {
    this.#generation++;
  }
}
