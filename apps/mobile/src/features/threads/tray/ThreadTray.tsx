import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { showsGoal } from "@canopy/domain/goals";
import { shownTaskList } from "@canopy/domain/task-list";
import { useAppearance } from "../../../state/appearance";
import { useDevicePreferences } from "../../settings/device-preferences";
import { QuestionPanel } from "../questions/QuestionPanel";
import type { ThreadState } from "../ThreadScreen";
import { ComposerTray } from "./ComposerTray";
import { GoalPanel } from "./GoalPanel";
import { QueuePanel } from "./QueuePanel";
import { useSubagentsPanel } from "./SubagentsPanel";
import { TasksPanel } from "./TasksPanel";

/**
 * The thread's tray in web order (goal, tasks, subagents, queue, then what waits for you, nearest the input). Without any
 * of them, or without an input (imported history), there is none. Only headers participate in layout.
 */
export function ThreadTray({ state, onGoal }: { state: ThreadState; onGoal: () => void }) {
  const settings = useAppearance();
  const device = useDevicePreferences();
  const { thread, snapshot, queue, requests } = state;
  const subagents = useSubagentsPanel(state.activeSubagents);

  const goal = showsGoal(snapshot?.goal, device.viewLoaded ? device.view.dismissedGoalIds : undefined)
    ? snapshot.goal
    : undefined;

  const tasks = snapshot
    ? shownTaskList(
        snapshot.items.flatMap(({ item, turnId, inherited }) => (item ? [{ item, turnId, inherited }] : [])),
        snapshot.turns,
      )
    : undefined;

  const disabled = state.home.away || state.stream.connection !== "live";

  const delivery =
    settings.user?.composer?.runningDelivery === ui.MessageDelivery.QUEUE
      ? ui.MessageDelivery.QUEUE
      : ui.MessageDelivery.STEER;

  if (!thread || thread.worktree?.removedAt || thread.import?.mode === "history") return null;

  const hasPanels = Boolean(
    goal || tasks || state.activeSubagents.length || queue.rows.length || requests.requests.length,
  );

  return (
    <>
      {hasPanels && (
        <ComposerTray>
          {goal ? (
            <GoalPanel
              goal={goal}
              threadId={thread.id}
              disabled={disabled}
              onOpen={onGoal}
              onDismiss={() => device.dismissGoal(goal.id)}
            />
          ) : null}
          {tasks ? <TasksPanel tasks={tasks} /> : null}
          {subagents.panel}
          <QueuePanel
            queue={queue}
            disabled={disabled}
            delivery={delivery}
            onDelivery={
              thread.sandboxProfile
                ? undefined
                : (runningDelivery) =>
                    void settings.update({ composer: create(ui.ComposerSettingsSchema, { runningDelivery }) })
            }
            onEdit={state.setEditing}
          />
          <QuestionPanel requests={requests} items={snapshot?.items} disabled={disabled} />
        </ComposerTray>
      )}
      {subagents.sheet}
    </>
  );
}
