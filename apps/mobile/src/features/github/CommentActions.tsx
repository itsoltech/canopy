import { useState } from "react";
import * as Crypto from "expo-crypto";
import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { mutationRequest, mutationUnconfirmed } from "@canopy/domain/github-mutations";
import { Notice } from "../../ui/components";
import { confirm } from "../../ui/Confirm";
import { GitHubActions } from "./GitHubActions";
import { CommentComposer } from "./CommentComposer";
import { useMutation } from "./useMutation";
import { invalidations } from "./invalidations";
import { OpenMutationSource } from "./OpenMutationSource";

export function CommentActions({
  snapshot,
  comment,
  kind,
}: {
  snapshot: github.PullRequestSnapshot;
  comment: github.PullRequestTimelineEntry;
  kind: string;
}) {
  const { client, send, busy, online, receipt } = useMutation(snapshot);

  const [editing, setEditing] = useState(false),
    [error, setError] = useState("");

  const [preparing, setPreparing] = useState(false);
  const own = comment.author.toLowerCase() === snapshot.viewerLogin.toLowerCase();
  const uncertain = receipt && mutationUnconfirmed(receipt);

  async function prepare() {
    if (!client || !online || busy || preparing || snapshot.stale) return;
    setPreparing(true);
    setError("");

    try {
      const r = mutationRequest(snapshot, Crypto.randomUUID(), "delete_comment", {
        resourceId: comment.id,
        commentKind: kind,
      });

      const value = await client.api.preparePullRequestMutation(r);
      confirm({
        title: "Delete comment?",
        description: `Delete your comment on ${snapshot.summary?.ref?.repositoryName} #${snapshot.summary?.ref?.number} as ${snapshot.viewerLogin}. This cannot be undone.`,
        confirm: "Delete comment",
        action: () =>
          void send("delete_comment", {}, { ...r, confirmationId: value.confirmationId }).then((result) => {
            if (result?.state === "succeeded") invalidations.publish(r.pullRequestId);
          }),
      });
    } catch {
      setError("Could not prepare deletion. Refresh and check account access.");
    } finally {
      setPreparing(false);
    }
  }

  if (!own || (!comment.viewerCanUpdate && !comment.viewerCanDelete)) return null;
  const disabled = busy || preparing || !online || snapshot.stale || !!uncertain;

  return (
    <View style={{ gap: 8 }}>
      <View style={{ alignItems: "flex-end" }}>
        <GitHubActions
          name="Comment"
          actions={[
            ...(comment.viewerCanUpdate ? [{ label: "Edit comment", disabled, run: () => setEditing(true) }] : []),
            ...(comment.viewerCanDelete
              ? [{ label: "Delete comment", disabled, danger: true, run: () => void prepare() }]
              : []),
          ]}
        />
      </View>
      {editing && (
        <CommentComposer
          snapshot={snapshot}
          resourceId={comment.id}
          commentKind={kind}
          initial={comment.body}
          onDone={() => setEditing(false)}
        />
      )}
      {!!(error || receipt?.detail) && <Notice error>{error || receipt?.detail}</Notice>}
      {uncertain && <OpenMutationSource snapshot={snapshot} />}
    </View>
  );
}
