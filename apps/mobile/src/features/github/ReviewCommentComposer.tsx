import { useState } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { github } from "@canopy/contracts";
import type { DiffRange } from "@canopy/domain/diff-anchors";
import { anchorLabel } from "@canopy/domain/github-review";
import { mutationRequest, mutationUnconfirmed, uncertainMutation } from "@canopy/domain/github-mutations";
import { Button, Field, Notice } from "../../ui/components";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { useMutation } from "./useMutation";
import { commentDrafts } from "./comment-drafts";
import { invalidations } from "./invalidations";
import { OpenMutationSource } from "./OpenMutationSource";
import { toast } from "../../ui/Toast";
import type { ReviewDraft } from "./useReviewDraft";

export function ReviewCommentComposer({
  snapshot,
  file,
  sha,
  range,
  draft,
  onRange,
  onDone,
}: {
  snapshot: github.PullRequestSnapshot;
  file: github.PullRequestFile;
  sha: string;
  range: DiffRange;
  draft: ReviewDraft;
  onRange: () => void;
  onDone: () => void;
}) {
  const key = commentDrafts.key(snapshot, `${file.path}:${sha}`, "inline");
  const [saved] = useState(() => commentDrafts.read(key, ""));

  const [body, setBody] = useState(saved.body),
    [preview, setPreview] = useState(false);

  const { send, receipt, busy, online, clear } = useMutation(snapshot, saved.receipt);

  const c = useColors(),
    type = useTypography();

  const uncertain = receipt && mutationUnconfirmed(receipt);

  const disabled =
    busy ||
    !!uncertain ||
    !online ||
    snapshot.stale ||
    sha !== snapshot.summary?.headSha ||
    !draft.pages.length ||
    !!draft.error ||
    !body.trim();

  async function submit(singleComment: boolean) {
    if (disabled) return;

    const r = mutationRequest(snapshot, Crypto.randomUUID(), "add_review_comment", {
      ...range,
      body,
      path: file.path,
      commitSha: sha,
      sourcePage: file.sourcePage,
      resourceId: singleComment ? "" : draft.pendingId,
      singleComment,
    });

    commentDrafts.pending(key, body, r);
    const result = await send(r.action, {}, r);
    commentDrafts.save(key, result?.state === "succeeded" ? "" : body, result);

    if (result?.state === "succeeded") {
      setBody("");
      invalidations.publish(`${draft.id}:reviews`);
      onDone();
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text
        style={[type.mono, { color: c.text }]}
        onLongPress={() => toast(sha.slice(0, 7))}
        accessibilityHint={`Commit ${sha.slice(0, 7)}`}
      >
        {file.path} · {anchorLabel(range)}
      </Text>
      <Text style={[type.meta, { color: c.muted }]}>
        {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
      </Text>
      <Button title="Extend range" variant="ghost" onPress={onRange} disabled={busy || !!uncertain} />
      {preview ? (
        <Markdown text={body || "Nothing to preview"} />
      ) : (
        <Field
          label="Inline comment"
          value={body}
          multiline
          editable={!busy && !uncertain}
          placeholder="Write a comment in Markdown…"
          style={{ minHeight: 112, textAlignVertical: "top" }}
          onChangeText={(text) => {
            setBody(text);
            commentDrafts.save(key, text, receipt);
          }}
        />
      )}
      {!!(receipt?.detail || (uncertain && !busy)) && (
        <Notice error={receipt?.state === "failed"}>{receipt?.detail || uncertainMutation}</Notice>
      )}
      {uncertain && <OpenMutationSource snapshot={snapshot} />}
      {(!online || snapshot.stale || sha !== snapshot.summary?.headSha) && (
        <Notice>Connect and open the current changes before sending. Your draft stays here.</Notice>
      )}
      {!!draft.error && <Notice error>{draft.error}</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        <Button title={preview ? "Write" : "Preview"} variant="ghost" onPress={() => setPreview(!preview)} />
        {uncertain && (
          <Button
            title="Start a new comment"
            variant="ghost"
            onPress={() => {
              clear();
              setBody("");
              commentDrafts.save(key, "");
            }}
          />
        )}
        <Button title="Add single comment" disabled={disabled || !!draft.pendingId} onPress={() => void submit(true)} />
        <Button
          title={busy ? "Saving…" : "Add to review"}
          variant="primary"
          disabled={disabled}
          onPress={() => void submit(false)}
        />
      </View>
    </View>
  );
}
