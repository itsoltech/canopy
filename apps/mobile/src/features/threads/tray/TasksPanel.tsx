import { useState } from "react";
import { Text, View } from "react-native";
import { taskListSummary, type TaskList } from "@canopy/domain/task-list";
import { Swap } from "../../../ui/MotionViews";
import { styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { ChecklistSteps } from "../../timeline/items/ChecklistView";
import { TrayPanel } from "./ComposerTray";
import { TrayHeader, TrayIcon } from "./TrayHeader";
import { TraySheet } from "./TraySheet";

/**
 * The agent's task list in the tray (web: TasksPanel): the task in progress and "3 of 7 done" in one line,
 * opening the whole checklist in a sheet.
 */
export function TasksPanel({ tasks }: { tasks: TaskList }) {
  const c = useColors();
  const emerald = useTone("emerald").text;
  const [open, setOpen] = useState(false);
  const summary = taskListSummary(tasks);
  const headline = summary.current?.text ?? "All tasks done";
  const progress = `${summary.completed} of ${summary.total} done`;

  return (
    <TrayPanel>
      <TrayHeader label={`Tasks: ${headline}. ${progress}`} opens="sheet" onPress={() => setOpen(true)}>
        <TrayIcon name={summary.done ? "check-circle" : "queue-list"} color={summary.done ? emerald : undefined} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Swap value={headline}>
            <Text numberOfLines={1} style={[styles.meta, { color: summary.done ? c.muted : c.strong }]}>
              {headline}
            </Text>
          </Swap>
        </View>
        <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          {progress}
        </Text>
      </TrayHeader>
      <TraySheet visible={open} onClose={() => setOpen(false)} title="Tasks">
        <View style={{ gap: 12, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 12 }}>
          {tasks.note ? <Text style={[styles.body, { color: c.muted }]}>{tasks.note}</Text> : null}
          <ChecklistSteps steps={tasks.steps} />
        </View>
      </TraySheet>
    </TrayPanel>
  );
}
