import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, type ui } from "@canopy/contracts";
import { backgroundStopLabel, backgroundTitle } from "@canopy/domain/background-tasks";
import { styles, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { QuoteItem } from "../quotes/QuoteAction";
import { BackgroundTaskSummary } from "./BackgroundTaskSummary";
import { BackgroundTaskStop } from "./BackgroundTaskStop";
import { useWorkspace } from "../workspace/context";

export function ThreadBackgroundTasks({
  snapshot,
  disabled,
  onOpen,
}: {
  snapshot: ui.ThreadSnapshot;
  disabled: boolean;
  onOpen?: () => void;
}) {
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
        <TaskRow
          key={entry.item?.itemId}
          entry={entry}
          threadId={snapshot.thread?.id ?? ""}
          disabled={disabled}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}

export function TaskRow({
  entry,
  threadId,
  disabled,
  compact = false,
  onOpen,
}: {
  entry: ui.TimelineItem;
  threadId: string;
  disabled: boolean;
  compact?: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const c = useColors();
  const workspace = useWorkspace();
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

  return (
    <View style={{ gap: 4 }}>
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name} — ${status}${task.exitCode ? ` · exit ${task.exitCode}` : ""}. Show full output`}
          onPress={() => {
            if (workspace) {
              workspace.openModule({ module: "tasks", resource: item.itemId, label: name });
              onOpen?.();
            } else setOutput(true);
          }}
          style={({ pressed }) => ({ borderRadius: 8, backgroundColor: pressed ? c.pressed : undefined })}
        >
          <BackgroundTaskSummary task={task} status={item.status} compact={compact} />
        </Pressable>
        {running && (
          <View style={{ position: "absolute", right: 4, top: 6 }}>
            <BackgroundTaskStop threadId={threadId} itemId={item.itemId} disabled={disabled} />
          </View>
        )}
      </View>
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
