import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { showsGoal } from "@canopy/domain/goals";
import { useAppearance } from "../../../state/appearance";
import { QuestionPanel } from "../questions/QuestionPanel";
import type { ThreadState } from "../ThreadScreen";
import { ComposerTray } from "./ComposerTray";
import { GoalPanel } from "./GoalPanel";
import { QueuePanel } from "./QueuePanel";
import { SubagentsPanel } from "./SubagentsPanel";

/**
 * The thread's tray in web order (goal, subagents, queue, then what waits for you, nearest the input). Without any
 * of them, or without an input (imported history), there is none. Only headers participate in layout.
 */
export function ThreadTray({ state, onGoal }: { state: ThreadState; onGoal: () => void }) {
  const settings = useAppearance();
  const { thread, snapshot, queue, requests } = state;
  const goal = showsGoal(snapshot?.goal, state.dismissedGoals) ? snapshot?.goal : undefined;
  const disabled = state.home.away || state.stream.connection !== "live";

  const delivery =
    settings.user?.composer?.runningDelivery === ui.MessageDelivery.QUEUE
      ? ui.MessageDelivery.QUEUE
      : ui.MessageDelivery.STEER;

  if (!thread || thread.import?.mode === "history") return null;

  if (!goal && !state.activeSubagents.length && !queue.rows.length && !requests.requests.length) return null;

  return (
    <ComposerTray>
      {goal ? (
        <GoalPanel
          goal={goal}
          threadId={thread.id}
          disabled={disabled}
          onOpen={onGoal}
          onDismiss={() => state.dismissGoal(goal.id)}
        />
      ) : null}
      <SubagentsPanel subagents={state.activeSubagents} />
      <QueuePanel
        queue={queue}
        disabled={disabled}
        delivery={delivery}
        onDelivery={(runningDelivery) =>
          void settings.update({ composer: create(ui.ComposerSettingsSchema, { runningDelivery }) })
        }
        onEdit={state.setEditing}
      />
      <QuestionPanel requests={requests} items={snapshot?.items} disabled={disabled} />
    </ComposerTray>
  );
}
