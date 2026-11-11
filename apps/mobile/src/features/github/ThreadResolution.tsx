import { useState } from "react";
import { View } from "react-native";
import * as Crypto from "expo-crypto";
import type { github } from "@canopy/contracts";
import { mutationRequest, mutationUnconfirmed, uncertainMutation } from "@canopy/domain/github-mutations";
import { Button, Notice } from "../../ui/components";
import { useMutation } from "./useMutation";
import { invalidations } from "./invalidations";
import { commentDrafts } from "./comment-drafts";
import { OpenMutationSource } from "./OpenMutationSource";

export function ThreadResolution({
  snapshot,
  thread,
}: {
  snapshot: github.PullRequestSnapshot;
  thread: github.PullRequestReviewThread;
}) {
  const key = commentDrafts.key(snapshot, thread.id, "resolve");
  const [saved] = useState(() => commentDrafts.read(key, ""));
  const { send, receipt, busy, online } = useMutation(snapshot, saved.receipt);
  const uncertain = receipt && mutationUnconfirmed(receipt);
  const allowed = thread.resolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;

  async function toggle() {
    const r = mutationRequest(snapshot, Crypto.randomUUID(), "resolve_thread", {
      resourceId: thread.id,
      resolved: !thread.resolved,
    });

    commentDrafts.pending(key, "", r);
    const result = await send(r.action, {}, r);
    commentDrafts.save(key, "", result);

    if (result?.state === "succeeded") invalidations.publish(`${r.pullRequestId}:reviews`);
  }

  return (
    <View style={{ gap: 8 }}>
      <Button
        title={thread.resolved ? "Unresolve conversation" : "Resolve conversation"}
        variant="ghost"
        disabled={busy || !allowed || !online || snapshot.stale || !!uncertain}
        onPress={() => void toggle()}
      />
      {!allowed && <Notice>GitHub does not allow you to change this conversation.</Notice>}
      {!!(receipt?.detail || (uncertain && !busy)) && (
        <Notice error={receipt?.state === "failed"}>{receipt?.detail || uncertainMutation}</Notice>
      )}
      {uncertain && <OpenMutationSource snapshot={snapshot} />}
    </View>
  );
}
