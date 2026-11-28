import { Text, View } from "react-native";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { bots } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { confirm } from "../../ui/Confirm";
import { styles, useColors } from "../../ui/theme";
import { PanelRow } from "../threads/ThreadPanel";
import { useScheduleAction } from "./BotSchedules";

/** Event triggers: what each listens to, whether it runs, and how often it ran this week. */
export function BotTriggers({
  botId,
  triggers,
  readOnly,
}: {
  botId: string;
  triggers: readonly bots.BotTrigger[];
  readOnly: boolean;
}) {
  const c = useColors();

  return (
    <>
      <Text style={[styles.heading, { color: c.text }]}>Event triggers</Text>
      {triggers.length ? (
        triggers.map((trigger) => <TriggerRow key={trigger.id} botId={botId} trigger={trigger} readOnly={readOnly} />)
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>No event triggers</Text>
      )}
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function TriggerRow({ botId, trigger, readOnly }: { botId: string; trigger: bots.BotTrigger; readOnly: boolean }) {
  const action = useScheduleAction(readOnly);
  const c = useColors();
  const running = trigger.enabled && !trigger.autoPaused;

  const state = trigger.autoPaused
    ? "Paused after running too often"
    : trigger.enabled
      ? `${plural(trigger.matchedWeek, "event")} · ${plural(trigger.runsWeek, "run")} in 7 days`
      : "Paused";

  return (
    <View style={{ gap: 8 }}>
      <PanelRow title={trigger.title} value={trigger.description} icon="bolt" />
      <Text style={[styles.meta, { color: c.muted }]}>
        {state}
        {trigger.lastRunAt
          ? ` · Last run ${timestampDate(trigger.lastRunAt).toLocaleString()} · ${trigger.lastOutcome || "Completed"}`
          : ""}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title={running ? "Pause trigger" : "Activate trigger"}
          busy={action.busy}
          disabled={action.disabled}
          onPress={() =>
            void action.run((api) => api.setBotTriggerEnabled({ botId, triggerId: trigger.id, enabled: !running }))
          }
        />
        <Button
          title="Delete trigger"
          variant="danger"
          disabled={action.disabled}
          onPress={() =>
            confirm({
              title: "Delete trigger?",
              description: `This deletes “${trigger.title}” and stops its queued and active runs. You cannot undo this.`,
              confirm: "Delete trigger",
              action: () => void action.run((api) => api.deleteBotTrigger({ botId, triggerId: trigger.id })),
            })
          }
        />
      </View>
      {action.error && <Notice error>{action.error}</Notice>}
    </View>
  );
}
