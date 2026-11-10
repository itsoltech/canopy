import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { lifecycleLabel, lifecycleEffect, mergeMethodLabel } from "@canopy/domain/github-lifecycle";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubActions } from "./GitHubActions";
import { useLifecycle, type LifecycleForm } from "./useLifecycle";

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
            variant="primary"
            title={lifecycleLabel(f.primary)}
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
        <Text style={[type.meta, { color: c.muted }]}>
          Auto-merge: {mergeMethodLabel(life.autoMergeMethod)} · {life.autoMergeAuthor}
        </Text>
      )}
      {life.inQueue && <Notice>Waiting in the merge queue</Notice>}
      {life.blockingReasons.map((reason) => (
        <Text key={reason} style={[type.meta, { color: c.muted }]}>
          {reason}
        </Text>
      ))}
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
          <Text style={[type.mono, { color: c.text }]}>
            {snapshot.baseRef} ← {snapshot.headRef} · {f.prepared?.headSha ?? snapshot.summary?.headSha}
          </Text>
          {["merge", "enable_auto_merge", "update_branch"].includes(f.action) && (
            <SelectField
              label={f.action === "update_branch" ? "Update method" : "Merge method"}
              value={mergeMethodLabel(f.method)}
              disabled={f.busy}
              onPress={() => f.setPicker(true)}
            />
          )}
          {["merge", "enable_auto_merge"].includes(f.action) && f.method === "SQUASH" && (
            <>
              <Field label="Commit title" value={f.title} editable={!f.busy} onChangeText={f.changeTitle} />
              <Field label="Commit body" value={f.body} multiline editable={!f.busy} onChangeText={f.changeBody} />
            </>
          )}
          {f.prepared && <Notice>Requirements checked. Confirm within 60 seconds.</Notice>}
          {!!f.error && <Notice error>{f.error}</Notice>}
          <Button
            title={f.prepared ? lifecycleLabel(f.action) : "Check requirements"}
            variant={f.action === "merge" || f.action === "close" ? "danger" : "primary"}
            disabled={f.blocked}
            onPress={() => void f.confirm()}
          />
        </View>
      </Sheet>
      <PickerSheet
        title="Method"
        visible={f.picker}
        value={f.method}
        onClose={() => f.setPicker(false)}
        sections={[{ options: f.methods.map((value) => ({ value, label: mergeMethodLabel(value) })) }]}
        onSelect={f.changeMethod}
      />
    </>
  );
}
