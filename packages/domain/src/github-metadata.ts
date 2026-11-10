import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { mutationRequest, sendMutation, mutationUnconfirmed, type MutationApi } from "./github-mutations.ts";

export type MetadataKind = "title" | "description" | "reviewers" | "assignees" | "labels";

export const metadataField = (kind: MetadataKind) => (kind === "title" || kind === "description" ? "details" : kind);

export const metadataAction = (kind: MetadataKind) =>
  ({ details: "update_details", reviewers: "request_reviewers", assignees: "set_assignees", labels: "set_labels" })[
    metadataField(kind)
  ];

export interface MetadataState {
  busy: boolean;
  current?: github.PullRequestMetadata | undefined;
  conflict?: github.PullRequestMetadata | undefined;
  display?: github.PullRequestMetadata | undefined;
  title: string;
  body: string;
  ids: string[];
  reviewerAction: string;
  options: github.PullRequestMetadataOption[];
  next: string;
  detail: string;
  receipt?: github.PullRequestMutationReceipt | undefined;
}

interface MetadataApi extends MutationApi {
  getPullRequestMetadata: (r: github.PullRequestPageRequest) => Promise<github.PullRequestMetadataPage>;
}

/** Local draft and uncertainty survive closing an editor. Only Apply can send a mutation. */
export class GitHubMetadataEditor {
  state: MetadataState = {
    busy: false,
    title: "",
    body: "",
    ids: [],
    reviewerAction: "request",
    options: [],
    next: "",
    detail: "",
  };
  #listeners = new Set<() => void>();
  constructor(
    readonly kind: MetadataKind,
    private api: MetadataApi,
    public snapshot: github.PullRequestSnapshot,
    private uuid: () => string,
    private refused: (cause: unknown) => boolean,
    private detail: (cause: unknown) => string,
  ) {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  read = () => this.state;
  acceptSnapshot(snapshot: github.PullRequestSnapshot) {
    this.snapshot = snapshot;

    if (!this.state.busy && this.state.display) this.patch({ display: undefined });
  }
  patch(fields: Partial<MetadataState>) {
    this.state = { ...this.state, ...fields };

    for (const listener of this.#listeners) listener();
  }
  get blocked() {
    return (
      this.state.busy || !!this.state.conflict || !!(this.state.receipt && mutationUnconfirmed(this.state.receipt))
    );
  }
  private async page(cursor = "") {
    return this.api.getPullRequestMetadata(
      create(github.PullRequestPageRequestSchema, {
        pullRequestId: this.snapshot.summary?.ref?.id ?? "",
        kind: metadataField(this.kind),
        cursor,
        refresh: true,
      }),
    );
  }
  async load(reset = false) {
    if (this.state.busy) return;
    this.patch({ busy: true, detail: "" });

    try {
      const page = await this.page();
      const current = page.metadata;

      if (!current) throw new Error("Missing metadata");
      const fresh = reset || !this.state.current;
      const degraded = this.kind === "reviewers" && !page.membersAvailable;

      const options = degraded
        ? page.options
        : [
            ...new Map(
              [...(fresh ? [] : this.state.options), ...fieldOptions(current, this.kind), ...page.options].map((o) => [
                o.id,
                o,
              ]),
            ).values(),
          ];

      this.patch({
        current: fresh ? current : this.state.current,
        conflict: !fresh && current.revision !== this.state.current?.revision ? current : undefined,
        ...(fresh && {
          title: current.title,
          body: current.body,
          ids: this.kind === "reviewers" ? [] : fieldOptions(current, this.kind).map((o) => o.id),
          receipt: undefined,
          display: undefined,
        }),
        ...(!fresh && degraded && { ids: this.state.ids.filter((id) => options.some((o) => o.id === id)) }),
        options,
        next: page.page?.nextCursor ?? "",
        detail: page.page?.detail ?? "",
      });
    } catch (cause) {
      this.patch({ detail: this.detail(cause) || "Could not load these fields. Refresh to retry." });
    } finally {
      this.patch({ busy: false });
    }
  }
  async more() {
    if (this.state.busy || !this.state.next) return;
    this.patch({ busy: true });

    try {
      const page = await this.page(this.state.next);
      this.patch({
        options: [...new Map([...this.state.options, ...page.options].map((o) => [o.id, o])).values()],
        next: page.page?.nextCursor ?? "",
      });
    } catch (cause) {
      this.patch({ detail: this.detail(cause) || "Could not load more choices. Retry when connected." });
    } finally {
      this.patch({ busy: false });
    }
  }
  toggle(id: string) {
    this.patch({ ids: this.state.ids.includes(id) ? this.state.ids.filter((v) => v !== id) : [...this.state.ids, id] });
  }
  reviewAction(reviewerAction: string) {
    this.patch({ reviewerAction, ids: [] });
  }
  async apply() {
    const before = this.state.current;

    if (!before || this.blocked || this.snapshot.stale) return false;
    const field = metadataField(this.kind);

    if (!before.actions.includes(field)) return false;
    const selected = this.state.options.filter((o) => this.state.ids.includes(o.id));

    const reviewers =
      this.state.reviewerAction === "remove"
        ? before.reviewers.filter((o) => !this.state.ids.includes(o.id))
        : [...new Map([...before.reviewers, ...selected].map((o) => [o.id, o])).values()];

    const display = create(github.PullRequestMetadataSchema, {
      ...before,
      ...(field === "details"
        ? { title: this.state.title, body: this.state.body }
        : this.kind === "reviewers"
          ? { reviewers }
          : { [this.kind]: selected }),
    });

    this.patch({ busy: true, display, detail: "" });

    const request = mutationRequest(this.snapshot, this.uuid(), metadataAction(this.kind), {
      title: this.state.title,
      body: this.state.body,
      metadataRevision: before.revision,
      metadataIds: this.state.ids,
      reviewerAction: this.kind === "reviewers" ? this.state.reviewerAction : "",
    });

    try {
      const receipt = await sendMutation(this.api, request, this.refused, this.detail);
      this.patch({ receipt, detail: receipt.detail, ...(receipt.state !== "succeeded" && { display: undefined }) });

      if (receipt.state === "succeeded") {
        this.patch({ current: undefined });

        return true;
      }

      const page = await this.page();

      if (page.metadata && page.metadata.revision !== before.revision) this.patch({ conflict: page.metadata });

      return false;
    } catch (cause) {
      this.patch({
        display: undefined,
        detail: this.detail(cause) || "Could not check this change. Refresh to retry.",
      });

      return false;
    } finally {
      this.patch({ busy: false });
    }
  }
}

export function fieldOptions(current: github.PullRequestMetadata, kind: MetadataKind) {
  if (kind === "reviewers") return current.reviewers;

  if (kind === "assignees") return current.assignees;

  if (kind === "labels") return current.labels;

  return [];
}

/** Mark the changed block while retaining shared context in both versions. */
export function metadataComparison(state: MetadataState, kind: MetadataKind) {
  const current = state.conflict;
  let draft = `${state.title}\n\n${state.body}`;
  let upstream = `${current?.title ?? ""}\n\n${current?.body ?? ""}`;

  if (metadataField(kind) !== "details" && current && state.current) {
    let ids = state.ids;

    if (kind === "reviewers") {
      ids =
        state.reviewerAction === "remove"
          ? state.current.reviewers.filter((v) => !ids.includes(v.id)).map((v) => v.id)
          : [...new Set([...state.current.reviewers.map((v) => v.id), ...ids])];
    }

    draft = ids
      .map((id) => state.options.find((v) => v.id === id)?.name ?? id)
      .sort()
      .join("\n");
    upstream = fieldOptions(current, kind)
      .map((v) => v.name)
      .sort()
      .join("\n");
  }

  const left = draft.split("\n"),
    right = upstream.split("\n");

  let start = 0,
    end = 0;

  while (start < left.length && start < right.length && left[start] === right[start]) start++;

  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - end - 1] === right[right.length - end - 1]
  )
    end++;

  return {
    draft: left.map((text, i) => ({ text, changed: i >= start && i < left.length - end })),
    current: right.map((text, i) => ({ text, changed: i >= start && i < right.length - end })),
  };
}
