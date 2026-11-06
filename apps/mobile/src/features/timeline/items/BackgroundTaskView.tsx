import { useState } from "react";
import { Text, View } from "react-native";
import { BackgroundTaskKind, ItemStatus, type BackgroundTask } from "@canopy/contracts";
import { backgroundStopLabel } from "@canopy/domain/background-tasks";
import { humanizeEnum } from "@canopy/domain/humanize";
import { Badge } from "../../../ui/Badge";
import { SmallButton } from "../../../ui/SmallButton";
import { styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { useSession } from "../../../state/session";
import { CodeBlock, OutputBlock } from "../CodeBlock";
import { ItemFrame } from "../ItemFrame";
import { useTimelineDirectory } from "../directory";
import { Aside, ErrorText, RowTitle, useRoomyRows } from "./parts";
import { progressText } from "./SubagentView";

const KINDS: Partial<Record<BackgroundTaskKind, string>> = {
  [BackgroundTaskKind.SHELL]: "Shell",
  [BackgroundTaskKind.AGENT]: "Agent",
  [BackgroundTaskKind.WORKFLOW]: "Workflow",
  [BackgroundTaskKind.PROCESS]: "Process",
};

/**
 * Work that outlives its turn (background shell, process, workflow) (web: BackgroundTaskView). While it runs: the
 * tail of its output and Stop; the worker ends it and the item then says it was stopped.
 */
export function BackgroundTaskView({
  task,
  itemId,
  status,
}: {
  task: BackgroundTask;
  itemId: string;
  status: ItemStatus;
}) {
  const c = useColors();
  const orange = useTone("orange").text;
  const { client } = useSession();
  const directory = useTimelineDirectory();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const running = status === ItemStatus.IN_PROGRESS;
  const name = task.description || task.command.split("\n")[0] || task.taskId;
  const progress = progressText(task.progress);
  const roomy = useRoomyRows();
  const reason = backgroundStopLabel(task.stopReason);

  async function stop() {
    if (!client) return;
    setStopping(true);
    setError("");

    try {
      // Stays "Stopping…" until the worker reports the task ended (the item leaves IN_PROGRESS).
      await client.api.stopBackgroundTask({ threadId: directory.currentId, itemId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Stopping failed");
      setStopping(false);
    }
  }

  return (
    <ItemFrame
      icon="bolt"
      status={status}
      label={`Background ${name}`}
      title={<RowTitle lead="Background" subject={name} />}
      aside={
        <>
          {KINDS[task.kind] ? <Badge>{KINDS[task.kind]}</Badge> : null}
          {progress && roomy ? <Aside>{progress}</Aside> : null}
        </>
      }
    >
      {running && directory.currentId && !directory.readOnly ? (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
            {stopping ? "Asked the worker to stop it…" : "Keeps running after the turn ends."}
          </Text>
          <SmallButton
            title={stopping ? "Stopping…" : "Stop"}
            icon="stop"
            busy={stopping}
            onPress={() => void stop()}
          />
          {error ? <ErrorText text={error} /> : null}
        </View>
      ) : null}
      {task.command ? <CodeBlock text={task.command} label="Command" /> : null}
      {task.stopReason ? (
        <Text style={[styles.workMeta, { color: orange }]}>
          {reason === task.stopReason ? humanizeEnum(task.stopReason) : reason}
        </Text>
      ) : null}
      {task.progress?.summary ? (
        <Text style={[styles.workMeta, { color: c.soft }]}>{task.progress.summary}</Text>
      ) : null}
      <OutputBlock
        output={task.output}
        blob={task.outputBlob}
        label={`Output of ${name}`}
        tail={12}
        empty={running ? "Waiting for output…" : "No output."}
      />
    </ItemFrame>
  );
}
