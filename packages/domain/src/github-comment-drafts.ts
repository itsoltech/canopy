import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";

interface Draft {
  body: string;
  receipt?: github.PullRequestMutationReceipt | undefined;
}

/** Client memory only. A remounted editor must not lose text or an uncertain send. */
export class GitHubCommentDrafts {
  #drafts = new Map<string, Draft>();
  key(snapshot: github.PullRequestSnapshot, resource: string, kind: string) {
    return `${snapshot.accountId}:${snapshot.summary?.ref?.id}:${resource}:${kind}`;
  }
  read(key: string, initial: string): Draft {
    const draft = this.#drafts.get(key);

    return draft?.receipt?.state === "succeeded" ? { body: initial } : (draft ?? { body: initial });
  }
  save(key: string, body: string, receipt?: github.PullRequestMutationReceipt) {
    this.#drafts.delete(key);
    this.#drafts.set(key, { body, receipt });

    if (this.#drafts.size > 100) this.#drafts.delete(this.#drafts.keys().next().value ?? "");
  }
  pending(key: string, body: string, request: github.PullRequestMutationRequest) {
    this.save(
      key,
      body,
      create(github.PullRequestMutationReceiptSchema, {
        clientRequestId: request.clientRequestId,
        action: request.action,
        state: "in_flight",
      }),
    );
  }
}
