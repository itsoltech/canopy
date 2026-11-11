import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { mutationUnconfirmed, mutationRequest } from "@canopy/domain/github-mutations";
import { Button, Notice } from "../../ui/components";
import { MarkdownEditor } from "../../ui/MarkdownEditor";
import { useColors, useTypography } from "../../ui/theme";
import { useMutation } from "./useMutation";
import { invalidations } from "./invalidations";
import { OpenMutationSource } from "./OpenMutationSource";
import { commentDrafts } from "./comment-drafts";
import * as Crypto from "expo-crypto";

export function CommentComposer({
  snapshot,
  resourceId = "",
  commentKind = "",
  initial = "",
  onDone,
}: {
  snapshot: github.PullRequestSnapshot;
  resourceId?: string;
  commentKind?: string;
  initial?: string;
  onDone?: () => void;
}) {
  const key = commentDrafts.key(snapshot, resourceId, commentKind);
  const [saved] = useState(() => commentDrafts.read(key, initial));
  const [body, setBody] = useState(saved.body);
  const { send, receipt, busy, online, clear } = useMutation(snapshot, saved.receipt);

  const c = useColors(),
    type = useTypography();

  const uncertain = receipt && mutationUnconfirmed(receipt);
  const label = commentKind ? "Save comment" : resourceId ? "Reply" : "Post comment";

  async function submit() {
    if (!body.trim() || uncertain || busy || !online || snapshot.stale) return;

    const request = mutationRequest(
      snapshot,
      Crypto.randomUUID(),
      commentKind ? "update_comment" : resourceId ? "reply" : "create_comment",
      {
        body,
        resourceId,
        commentKind,
      },
    );

    commentDrafts.pending(key, body, request);
    const result = await send(request.action, {}, request);
    commentDrafts.save(key, result?.state === "succeeded" ? "" : body, result);

    if (result?.state === "succeeded") {
      setBody("");
      const id = snapshot.summary?.ref?.id ?? "";
      invalidations.publish(commentKind === "review" || request.action === "reply" ? `${id}:reviews` : id);
      onDone?.();
    }
  }

  return (
    <View style={{ gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={2} style={[type.meta, { flex: 1, color: c.muted }]}>
          {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
        </Text>
      </View>
      <MarkdownEditor
        label={resourceId ? "Reply or edit comment" : "Comment"}
        value={body}
        onChange={(text) => {
          setBody(text);
          commentDrafts.save(key, text, receipt);
        }}
        placeholder="Write a comment in Markdown…"
        disabled={busy || !!uncertain}
      />
      {!!receipt?.detail && <Notice error={receipt.state === "failed"}>{receipt.detail}</Notice>}
      {uncertain && <OpenMutationSource snapshot={snapshot} />}
      {(!online || snapshot.stale) && <Notice>Connect and refresh before sending. Your draft stays here.</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        {uncertain && (
          <Button
            title={commentKind ? "Edit again" : resourceId ? "Start a new reply" : "Start a new comment"}
            variant="ghost"
            onPress={() => {
              clear();
              setBody("");
              commentDrafts.save(key, "");
            }}
          />
        )}
        {onDone && <Button title="Cancel" variant="ghost" onPress={onDone} />}
        <Button
          title={busy ? "Saving…" : label}
          variant={resourceId ? "secondary" : "primary"}
          disabled={busy || !online || snapshot.stale || !!uncertain || !body.trim()}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
