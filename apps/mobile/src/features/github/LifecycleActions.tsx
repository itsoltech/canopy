import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { lifecycleLabel, lifecycleEffect, mergeMethodLabel } from "@canopy/domain/github-lifecycle";
import { methodSegmentLabel } from "@canopy/domain/github-lifecycle-display";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { Segmented } from "../../ui/Segmented";
import { AutoGrowingField } from "../../ui/AutoGrowingField";
import { Badge } from "../../ui/Badge";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubActions } from "./GitHubActions";
import { useLifecycle, type LifecycleForm } from "./useLifecycle";
import { MergeBlockers } from "./MergeBlockers";
import { ConfirmationCountdown } from "./ConfirmationCountdown";
import { CommitSha } from "./CommitSha";

export function LifecycleActions({
  snapshot,
  onrefresh,
}: {
  snapshot: github.PullRequestSnapshot;
  onrefresh: () => void;
}) {
  const f = useLifecycle(snapshot, onrefresh),
    c = useColors(),
    type = useTypography();

  const life = f.life;

  if (!life) return null;

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {["open", "draft"].includes(snapshot.summary?.state ?? "") && (
          <Button
            size="sm"
            variant={f.blocked || !f.actions.includes(f.primary) ? "secondary" : "primary"}
            title={lifecycleLabel(f.primary)}
            hint={life.blockingReasons.join(" ")}
            disabled={f.blocked || !f.actions.includes(f.primary)}
            onPress={() => f.choose(f.primary)}
          />
        )}
        {f.primary === "merge" && life.mergeMethods.length > 1 && (
          <GitHubActions
            name="Merge methods"
            actions={life.mergeMethods.map((value) => ({
              label: mergeMethodLabel(value),
              run: () => f.choose("merge", value),
              disabled: f.blocked || !f.actions.includes("merge"),
            }))}
          />
        )}
        {f.actions.includes("update_branch") && (
          <Button size="sm" title="Update branch" disabled={f.blocked} onPress={() => f.choose("update_branch")} />
        )}
        <GitHubActions
          name="Lifecycle actions"
          actions={f.actions
            .filter((a) => ["draft", "close", "reopen", "enable_auto_merge", "disable_auto_merge"].includes(a))
            .map((value) => ({
              label: lifecycleLabel(value),
              run: () => f.choose(value),
              disabled: f.blocked,
              danger: value === "close",
            }))}
        />
      </View>
      {!!life.autoMergeMethod && (
        <View
          accessible
          accessibilityLabel={`Auto-merge on · ${mergeMethodLabel(life.autoMergeMethod)} · ${life.autoMergeAuthor}`}
          style={{ alignSelf: "flex-start" }}
        >
          <Badge>Auto-merge on</Badge>
        </View>
      )}
      {life.inQueue && <Notice>Waiting in the merge queue</Notice>}
      <MergeBlockers reasons={life.blockingReasons} />
      {!!life.updateBlockingReason && <Text style={[type.meta, { color: c.muted }]}>{life.updateBlockingReason}</Text>}
      {(!f.online || snapshot.stale) && <Notice>Connect and refresh before changing this pull request.</Notice>}
      {!!f.receipt?.detail && <Notice>{f.receipt.detail}</Notice>}
      {f.pending && <Button title="Check current state" size="sm" variant="ghost" onPress={f.check} />}
      <LifecycleConfirmation snapshot={snapshot} form={f} />
    </View>
  );
}

function LifecycleConfirmation({ snapshot, form: f }: { snapshot: github.PullRequestSnapshot; form: LifecycleForm }) {
  const c = useColors(),
    type = useTypography();

  return (
    <>
      <Sheet title={`${lifecycleLabel(f.action)}?`} visible={!!f.action} onClose={f.close}>
        <View style={{ gap: 12 }}>
          <Notice>{lifecycleEffect(f.action)}</Notice>
          <Text style={[type.meta, { color: c.muted }]}>
            {snapshot.viewerLogin} · {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            <Text style={[type.meta, { color: c.text }]}>
              {snapshot.baseRef} ← {snapshot.headRef} ·
            </Text>
            <CommitSha sha={f.prepared?.headSha ?? snapshot.summary?.headSha ?? ""} />
          </View>
          {["merge", "enable_auto_merge", "update_branch"].includes(f.action) && (
            <Segmented
              options={f.methods.map((value) => ({ value, label: methodSegmentLabel(value), disabled: f.busy }))}
              value={f.method}
              onChange={f.changeMethod}
            />
          )}
          {["merge", "enable_auto_merge"].includes(f.action) && f.method === "SQUASH" && (
            <>
              <Field label="Commit title" value={f.title} editable={!f.busy} onChangeText={f.changeTitle} />
              <AutoGrowingField label="Commit body" value={f.body} editable={!f.busy} onChangeText={f.changeBody} />
            </>
          )}
          {f.prepared && <ConfirmationCountdown expiresAt={f.expiresAt} />}
          {!!f.error && <Notice error>{f.error}</Notice>}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button title="Cancel" variant="ghost" disabled={f.busy} onPress={f.close} />
            <Button
              title={f.prepared ? lifecycleLabel(f.action) : "Check requirements"}
              variant="primary"
              busy={f.busy}
              disabled={f.blocked}
              onPress={() => void f.confirm()}
            />
          </View>
        </View>
      </Sheet>
    </>
  );
}
