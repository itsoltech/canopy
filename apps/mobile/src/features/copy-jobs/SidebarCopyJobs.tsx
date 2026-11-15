import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  copyJobAmounts,
  copyJobLead,
  copyJobPercent,
  copyJobRunning,
  copyJobState,
  copyJobTitle,
} from "@canopy/domain/workspace-copy-jobs";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { ProgressBar } from "../../ui/ProgressBar";
import { Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { useSession } from "../../state/session";
import { dropCopyJob, mergeCopyJob, useCopyJobs } from "./store";

/** Web: SidebarCopyJobs. Background copies above the sidebar footer; a row opens its details in a sheet. */
export function SidebarCopyJobs() {
  const c = useColors();
  const { listed, jobs } = useCopyJobs();
  const [open, setOpen] = useState<string>();
  const job = open ? jobs.get(open) : undefined;

  if (!listed.length && !job) return null;

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingVertical: 4, paddingHorizontal: 8 }}>
      {listed.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={`${copyJobTitle(item)}, ${copyJobState(item)}. Show details`}
          onPress={() => setOpen(item.id)}
          style={({ pressed }) => ({
            minHeight: 44,
            justifyContent: "center",
            gap: 6,
            paddingHorizontal: 8,
            borderRadius: 8,
            backgroundColor: pressed ? c.pressed : "transparent",
          })}
        >
          <View style={styles.row}>
            <Icon
              name={item.status === "failed" ? "exclamation-circle" : "document-duplicate"}
              size={16}
              color={item.status === "failed" ? c.danger : c.muted}
            />
            <Text numberOfLines={1} style={[styles.chrome, { flexShrink: 1, color: c.text }]}>
              {copyJobLead(item)}
            </Text>
            <Text numberOfLines={1} style={[styles.chrome, { flex: 1, maxWidth: "50%", color: c.text }]}>
              {`→ ${item.targetName || "worker"}`}
            </Text>
            <Text style={[styles.chromeMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {copyJobState(item)}
            </Text>
          </View>
          {item.status !== "failed" && (
            <ProgressBar done={BigInt(copyJobPercent(item))} total={100n} label="Copy progress" style={{ height: 2 }} />
          )}
        </Pressable>
      ))}
      {job && <CopyJobSheet job={job} onClose={() => setOpen(undefined)} />}
    </View>
  );
}

function CopyJobSheet({ job, onClose }: { job: ui.WorkspaceCopyJob; onClose: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const running = copyJobRunning(job);

  async function act(action: "cancel" | "retry" | "dismiss") {
    if (!client) return;
    setPending(action);
    setError("");

    try {
      if (action === "dismiss") {
        await client.api.dismissWorkspaceCopyJob({ id: job.id });
        dropCopyJob(job.id);
        onClose();
      } else
        mergeCopyJob(
          action === "cancel"
            ? await client.api.cancelWorkspaceCopyJob({ id: job.id }, { timeoutMs: 40_000 })
            : await client.api.retryWorkspaceCopyJob({ id: job.id }),
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the gateway. Retry.");
    } finally {
      setPending("");
    }
  }

  return (
    <Sheet
      visible
      title={
        job.status === "failed"
          ? "Copy failed"
          : job.status === "completed"
            ? "Workspace copied"
            : `Copying ${job.name}`
      }
      onClose={onClose}
      footer={
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          {running ? (
            <Button
              title="Cancel copy"
              busy={pending === "cancel"}
              disabled={!!pending}
              onPress={() => void act("cancel")}
            />
          ) : (
            <>
              <Button title="Dismiss" disabled={!!pending} onPress={() => void act("dismiss")} />
              {job.status === "failed" && (
                <Button
                  title="Retry"
                  variant="primary"
                  busy={pending === "retry"}
                  disabled={!!pending}
                  onPress={() => void act("retry")}
                />
              )}
            </>
          )}
        </View>
      }
    >
      <View style={{ gap: 12, paddingHorizontal: 20, paddingVertical: 12 }}>
        <Text numberOfLines={1} style={[styles.body, { color: c.muted }]}>
          To {job.targetName || "worker"} · {job.name}
        </Text>
        {running && <ProgressBar done={BigInt(copyJobPercent(job))} total={100n} label="Copy progress" />}
        <Text style={[styles.body, { color: c.muted, fontVariant: ["tabular-nums"] }]}>{copyJobAmounts(job)}</Text>
        {job.status === "failed" || error ? (
          <Text accessibilityRole="alert" selectable style={[styles.body, { color: c.danger }]}>
            {error || job.error}
          </Text>
        ) : job.status === "waiting" ? (
          <Text style={[styles.body, { color: c.muted }]}>
            {job.error || "Waiting for the computers to be online."}
          </Text>
        ) : running ? (
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.body, { color: c.muted }]}>
            {job.progress?.currentFile || "Preparing the destination…"}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
