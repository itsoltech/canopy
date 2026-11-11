import { useState } from "react";
import * as Crypto from "expo-crypto";
import type { github } from "@canopy/contracts";
import { reviewOutdated } from "@canopy/domain/github-review";
import { mutationRequest, mutationUnconfirmed } from "@canopy/domain/github-mutations";
import { confirm } from "../../ui/Confirm";
import { useMutation } from "./useMutation";
import { commentDrafts } from "./comment-drafts";
import { invalidations } from "./invalidations";
import type { ReviewDraft } from "./useReviewDraft";

export function useReviewForm(snapshot: github.PullRequestSnapshot, draft: ReviewDraft, onDone: () => void) {
  const key = commentDrafts.key(snapshot, draft.pendingId, "review-summary");
  const [saved] = useState(() => commentDrafts.read(key, draft.pages[0]?.body ?? ""));

  const [body, setBody] = useState(saved.body),
    [verdict, setVerdict] = useState("COMMENT");

  const [acknowledge, setAcknowledge] = useState(false),
    [error, setError] = useState("");

  const [preparing, setPreparing] = useState(false);
  const { client, send, receipt, busy, online, clear } = useMutation(snapshot, saved.receipt);
  const own = draft.pages[0]?.viewerIsAuthor ?? true;
  const outdated = reviewOutdated(draft.pages, snapshot.summary?.headSha ?? "");
  const uncertain = receipt && mutationUnconfirmed(receipt);
  const closed = !["open", "draft"].includes(snapshot.summary?.state ?? "");
  const blocked = busy || preparing || !!uncertain || !online || snapshot.stale || closed || !draft.complete;

  const options = [
    { value: "COMMENT", label: "Comment" },
    { value: "APPROVE", label: "Approve", disabled: own },
    { value: "REQUEST_CHANGES", label: "Request changes", disabled: own },
  ];

  function request(action: string) {
    return mutationRequest(snapshot, Crypto.randomUUID(), action, {
      resourceId: draft.pendingId,
      reviewRevision: draft.revision,
      body: action === "submit_review" ? body : "",
      verdict: action === "submit_review" ? verdict : "",
      acknowledgeOutdated: acknowledge,
    });
  }

  async function submit(r: github.PullRequestMutationRequest) {
    commentDrafts.pending(key, body, r);
    const result = await send(r.action, {}, r);
    commentDrafts.save(key, result?.state === "succeeded" ? "" : body, result);

    if (result?.state === "succeeded") {
      setBody("");
      invalidations.publish(`${draft.id}:reviews`);
      onDone();
    }
  }

  async function discard() {
    if (!client || blocked || !draft.pendingId) return;
    setPreparing(true);
    setError("");

    try {
      const r = request("discard_review"),
        confirmation = await client.api.preparePullRequestMutation(r);

      confirm({
        title: "Discard review?",
        description: `Delete all ${draft.count} pending comments as ${snapshot.viewerLogin}. This cannot be undone.`,
        confirm: "Discard review",
        action: () => void submit({ ...r, confirmationId: confirmation.confirmationId }),
      });
    } catch {
      setError("Could not prepare discarding this review. Refresh and check account access.");
    } finally {
      setPreparing(false);
    }
  }

  const changeBody = (text: string) => {
    setBody(text);
    commentDrafts.save(key, text, receipt);
  };

  const refresh = () => {
    setAcknowledge(false);
    void draft.refresh();
  };

  return {
    body,
    changeBody,
    verdict,
    setVerdict,
    acknowledge,
    setAcknowledge,
    error,
    receipt,
    busy,
    online,
    own,
    outdated,
    uncertain,
    closed,
    blocked,
    options,
    refresh,
    clear,
    discard,
    submit: () => submit(request("submit_review")),
  };
}
