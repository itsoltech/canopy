import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { uncertainMutation } from "@canopy/domain/github-mutations";
import { Button, Field, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { PickerSheet } from "../../ui/Picker";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { PendingComments } from "./PendingComments";
import { OpenMutationSource } from "./OpenMutationSource";
import { useReviewForm } from "./useReviewForm";
import type { ReviewDraft } from "./useReviewDraft";

export function ReviewForm({
  snapshot,
  draft,
  onDone,
}: {
  snapshot: github.PullRequestSnapshot;
  draft: ReviewDraft;
  onDone: () => void;
}) {
  const f = useReviewForm(snapshot, draft, onDone);

  const c = useColors(),
    type = useTypography();

  const [preview, setPreview] = useState(false),
    [picker, setPicker] = useState(false);

  return (
    <View style={{ gap: 12 }}>
      <Text style={[type.meta, { color: c.muted }]}>
        {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number} ·{" "}
        {snapshot.summary?.headSha.slice(0, 7)}
      </Text>
      <PendingComments snapshot={snapshot} draft={draft} />
      <Button title={preview ? "Write" : "Preview"} variant="ghost" size="sm" onPress={() => setPreview(!preview)} />
      {preview ? (
        <Markdown text={f.body || "Nothing to preview"} />
      ) : (
        <Field
          label="Review summary"
          value={f.body}
          multiline
          placeholder="Summarize your review in Markdown…"
          style={{ minHeight: 112, textAlignVertical: "top" }}
          editable={!f.busy && !f.uncertain}
          onChangeText={f.changeBody}
        />
      )}
      <Button
        title={f.options.find((o) => o.value === f.verdict)?.label ?? "Comment"}
        disabled={f.blocked}
        onPress={() => setPicker(true)}
      />
      <PickerSheet
        title="Review verdict"
        visible={picker}
        value={f.verdict}
        onClose={() => setPicker(false)}
        sections={[{ options: f.options }]}
        onSelect={(value) => {
          f.setVerdict(value);
          setPicker(false);
        }}
      />
      {f.own && (
        <Notice>
          GitHub does not allow you to approve or request changes on your own pull request. Choose Comment.
        </Notice>
      )}
      {f.outdated && (
        <Checkbox
          label="I checked the outdated comments against the current changes"
          checked={f.acknowledge}
          onChange={f.setAcknowledge}
          disabled={f.busy || !!f.uncertain}
        />
      )}
      {(f.closed || !f.online || snapshot.stale) && (
        <Notice>
          {f.closed ? "This pull request is closed." : "Connect and refresh before submitting. Your draft stays here."}
        </Notice>
      )}
      {!!(f.error || f.receipt?.detail || (f.uncertain && !f.busy)) && (
        <Notice error>{f.error || f.receipt?.detail || uncertainMutation}</Notice>
      )}
      {f.uncertain && <OpenMutationSource snapshot={snapshot} />}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        <Button title="Refresh review" variant="ghost" disabled={f.busy || !!f.uncertain} onPress={f.refresh} />
        {!!draft.pendingId && (
          <Button title="Discard review" variant="danger" disabled={f.blocked} onPress={() => void f.discard()} />
        )}
        {f.uncertain && (
          <Button
            title="Check current review"
            variant="ghost"
            onPress={() => {
              f.clear();
              f.refresh();
            }}
          />
        )}
        <Button
          title={f.busy ? "Submitting…" : "Submit review"}
          variant="primary"
          disabled={
            f.blocked ||
            (f.outdated && !f.acknowledge) ||
            (f.own && f.verdict !== "COMMENT") ||
            (f.verdict === "COMMENT" && !f.body.trim() && !draft.count) ||
            (f.verdict === "REQUEST_CHANGES" && !f.body.trim())
          }
          onPress={() => void f.submit()}
        />
      </View>
    </View>
  );
}
