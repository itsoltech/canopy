import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, type ui } from "@canopy/contracts";
import { backgroundStopLabel, backgroundTitle } from "@canopy/domain/background-tasks";
import { useSession } from "../../state/session";
import { Notice } from "../../ui/components";
import { IconButton } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { QuoteItem } from "../quotes/QuoteAction";
import { BackgroundTaskSummary } from "./BackgroundTaskSummary";

export function ThreadBackgroundTasks({ snapshot, disabled }: { snapshot: ui.ThreadSnapshot; disabled: boolean }) {
  const c = useColors();

  const tasks = snapshot.items
    .filter((entry) => !entry.inherited && entry.item?.content.case === "backgroundTask")
    .sort(
      (a, b) =>
        Number(b.item?.status === ItemStatus.IN_PROGRESS) - Number(a.item?.status === ItemStatus.IN_PROGRESS) ||
        (a.firstSeq === b.firstSeq ? 0 : a.firstSeq > b.firstSeq ? -1 : 1),
    );

  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.label, { color: c.text }]}>Background tasks</Text>
      {!tasks.length && <Text style={[styles.meta, { color: c.muted }]}>No background tasks</Text>}
      {tasks.map((entry) => (
        <TaskRow key={entry.item?.itemId} entry={entry} threadId={snapshot.thread?.id ?? ""} disabled={disabled} />
      ))}
    </View>
  );
}

export function TaskRow({
  entry,
  threadId,
  disabled,
  compact = false,
}: {
  entry: ui.TimelineItem;
  threadId: string;
  disabled: boolean;
  compact?: boolean;
}) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState(false);
  const item = entry.item;

  if (item?.content.case !== "backgroundTask") return null;
  const task = item.content.value;
  const running = item.status === ItemStatus.IN_PROGRESS;
  const name = backgroundTitle(task, "Background task");

  const status = running
    ? "Running"
    : task.stopReason
      ? backgroundStopLabel(task.stopReason)
      : item.status === ItemStatus.FAILED
        ? "Failed"
        : item.status === ItemStatus.INTERRUPTED
          ? "Stopped"
          : item.status === ItemStatus.COMPLETED
            ? "Completed"
            : "Pending";

  async function stop() {
    if (!client || !item || busy || disabled) return;
    setBusy(true);
    setError("");

    try {
      await client.api.stopBackgroundTask({ threadId, itemId: item.itemId });
    } catch {
      setError("Could not stop the task. Check the connection and retry.");
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 4 }}>
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name} — ${status}${task.exitCode ? ` · exit ${task.exitCode}` : ""}. Show full output`}
          onPress={() => setOutput(true)}
          style={({ pressed }) => ({ borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined })}
        >
          <BackgroundTaskSummary task={task} status={item.status} compact={compact} />
        </Pressable>
        {running && (
          <IconButton
            icon="stop"
            label={busy ? "Stopping…" : "Stop task"}
            size="sm"
            busy={busy}
            disabled={disabled}
            onPress={() => void stop()}
            style={{ position: "absolute", right: 4, top: 6 }}
          />
        )}
      </View>
      {error ? <Notice error>{error}</Notice> : null}
      {output && (
        <QuoteItem.Provider value={item.itemId}>
          <TextViewer
            text={task.output}
            blob={task.outputBlob}
            threadId={threadId}
            label={`Output of ${name}`}
            onClose={() => setOutput(false)}
          />
        </QuoteItem.Provider>
      )}
    </View>
  );
}
