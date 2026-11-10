import { useState } from "react";
import { Text, View } from "react-native";
import { ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { goalActions, goalLook, goalPending, isFinishedGoal } from "@canopy/domain/goals";
import { useSession } from "../../../state/session";
import { StatusDot } from "../../../ui/Badge";
import { IconButton } from "../../../ui/components";
import { Swap } from "../../../ui/MotionViews";
import { styles, useColors } from "../../../ui/theme";
import { toast } from "../../../ui/Toast";
import { useTone } from "../../../ui/tone";
import { TrayPanel } from "./ComposerTray";
import { TrayHeader, TrayIcon } from "./TrayHeader";

/**
 * The thread's goal in the tray (web: GoalBar, embedded): objective and status in one line, opening the goal sheet
 * with the whole objective, the latest check and every action. Pause or resume sits beside it; an achieved goal
 * can be dismissed. Until the harness confirms a decision the status says what it waits for.
 */
export function GoalPanel({
  goal,
  threadId,
  disabled,
  onOpen,
  onDismiss,
}: {
  goal: ui.Goal;
  threadId: string;
  disabled: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const look = goalLook(goal.status);
  const tone = useTone(look.tone);
  const pending = goalPending(goal);
  const actions = goalActions(goal.status);
  const status = pending ?? look.label;

  async function act(action: "pause" | "resume") {
    if (!client || busy) return;
    setBusy(true);

    try {
      await client.api.setGoal({ threadId, action });
    } catch (cause) {
      toast(ConnectError.from(cause).rawMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <TrayPanel>
      <TrayHeader
        label={`Goal: ${goal.objective}. ${status}`}
        opens="sheet"
        onPress={onOpen}
        trailing={
          actions.pause || actions.resume ? (
            <IconButton
              icon={actions.pause ? "pause" : "play"}
              label={actions.pause ? "Pause the goal" : "Resume the goal"}
              size="sm"
              busy={busy}
              disabled={disabled}
              onPress={() => void act(actions.pause ? "pause" : "resume")}
            />
          ) : isFinishedGoal(goal.status) ? (
            <IconButton icon="x-mark" label="Dismiss" size="sm" onPress={onDismiss} />
          ) : null
        }
      >
        <TrayIcon name={look.icon} color={tone.text} />
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, minWidth: 0, color: c.strong }]}>
          {goal.objective}
        </Text>
        <Swap value={status}>
          <View style={[styles.row, { gap: 6 }]}>
            <StatusDot tone={look.tone} active={Boolean(look.active && !pending)} />
            <Text numberOfLines={1} style={[styles.overlayMeta, { color: tone.text }]}>
              {status}
            </Text>
          </View>
        </Swap>
      </TrayHeader>
    </TrayPanel>
  );
}
