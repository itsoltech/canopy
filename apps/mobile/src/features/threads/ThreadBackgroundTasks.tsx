import { useState } from "react";
import { Text, View } from "react-native";
import { ItemStatus, type ui } from "@canopy/contracts";
import { backgroundStopLabel } from "@canopy/domain/background-tasks";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { QuoteItem } from "../quotes/QuoteAction";

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
    <View style={{ gap: 12 }}>
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
}: {
  entry: ui.TimelineItem;
  threadId: string;
  disabled: boolean;
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

  const status = running
    ? "Running"
    : task.stopReason
      ? backgroundStopLabel(task.stopReason)
      : item.status === ItemStatus.FAILED
        ? "Failed"
        : item.status === ItemStatus.INTERRUPTED
          ? "Stopped"
          : item.status === ItemStatus.COMPLETED
            ? "Done"
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
    <View style={{ gap: 6, borderBottomWidth: 1, borderColor: c.line, paddingBottom: 8 }}>
      <Text numberOfLines={3} style={[styles.body, { color: c.text }]}>
        {task.description || task.command || "Background task"}
      </Text>
      <Text style={[styles.meta, { color: c.muted }]}>
        {status}
        {task.exitCode === undefined ? "" : ` · exit ${task.exitCode}`}
      </Text>
      {error ? <Notice error>{error}</Notice> : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button title="Show full output" size="sm" onPress={() => setOutput(true)} />
        {running && (
          <Button
            title="Stop task"
            size="sm"
            variant="danger"
            busy={busy}
            disabled={disabled}
            onPress={() => void stop()}
          />
        )}
      </View>
      {output && (
        <QuoteItem.Provider value={item.itemId}>
          <TextViewer
            text={task.output}
            blob={task.outputBlob}
            threadId={threadId}
            label={`Output of ${task.description || task.command || "background task"}`}
            onClose={() => setOutput(false)}
          />
        </QuoteItem.Provider>
      )}
    </View>
  );
}
