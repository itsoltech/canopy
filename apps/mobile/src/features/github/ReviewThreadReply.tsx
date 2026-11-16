import { useState } from "react";
import type { github } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { CommentComposer } from "./CommentComposer";
import { commentDrafts } from "./comment-drafts";

export function ReviewThreadReply({
  snapshot,
  resourceId,
}: {
  snapshot: github.PullRequestSnapshot;
  resourceId: string;
}) {
  const [replying, setReplying] = useState(() => {
    const saved = commentDrafts.read(commentDrafts.key(snapshot, resourceId, ""), "");

    return Boolean(saved.body || saved.receipt);
  });

  return replying ? (
    <CommentComposer snapshot={snapshot} resourceId={resourceId} onDone={() => setReplying(false)} />
  ) : (
    <Button title="Reply" variant="ghost" onPress={() => setReplying(true)} />
  );
}
