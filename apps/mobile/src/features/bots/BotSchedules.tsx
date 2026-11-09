import { useState } from "react";
import { Text, View } from "react-native";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { confirm } from "../../ui/Confirm";
import { styles, useColors } from "../../ui/theme";
import { PanelRow } from "../threads/ThreadPanel";

export function BotSchedules({ conversation, readOnly }: { conversation: bots.BotConversation; readOnly: boolean }) {
  const c = useColors();
  const botId = conversation.bot?.id;

  if (!botId) return null;

  return (
    <>
      <Text style={[styles.heading, { color: c.text }]}>Routines</Text>
      {conversation.routines.length ? (
        conversation.routines.map((routine) => (
          <RoutineRow key={routine.id} botId={botId} routine={routine} readOnly={readOnly} />
        ))
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>No routines</Text>
      )}
      <Text style={[styles.heading, { color: c.text }]}>Reminders</Text>
      {conversation.reminders.length ? (
        conversation.reminders.map((reminder) => (
          <ReminderRow key={reminder.id} botId={botId} reminder={reminder} readOnly={readOnly} />
        ))
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>No reminders</Text>
      )}
    </>
  );
}

function useScheduleAction(readOnly: boolean) {
  const { client, online } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return {
    disabled: readOnly || !online || busy,
    busy,
    error,
    async run(action: (api: NonNullable<typeof client>["api"]) => Promise<object>) {
      if (!client || !online || readOnly || busy) return;
      setBusy(true);
      setError("");

      try {
        await action(client.api);
      } catch {
        setError("Could not change this schedule. Check the connection and retry.");
      } finally {
        setBusy(false);
      }
    },
  };
}

function RoutineRow({ botId, routine, readOnly }: { botId: string; routine: bots.BotRoutine; readOnly: boolean }) {
  const action = useScheduleAction(readOnly);
  const c = useColors();

  const date = (at: NonNullable<typeof routine.nextRunAt>) =>
    timestampDate(at).toLocaleString(undefined, { timeZone: routine.timezone || undefined });

  return (
    <View style={{ gap: 8 }}>
      <PanelRow
        title={routine.title}
        value={`${routine.enabled ? "Active" : "Paused"} · ${routine.scheduleText || routine.cron}`}
        icon="clock"
      />
      <Text style={[styles.meta, { color: c.muted }]}>
        {routine.timezone}
        {routine.enabled && routine.nextRunAt ? ` · Next run ${date(routine.nextRunAt)}` : ""}
        {routine.lastRunAt ? ` · Last run ${date(routine.lastRunAt)} · ${routine.lastOutcome || "Completed"}` : ""}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title={routine.enabled ? "Pause routine" : "Activate routine"}
          busy={action.busy}
          disabled={action.disabled}
          onPress={() =>
            void action.run((api) =>
              api.setBotRoutineEnabled({ botId, routineId: routine.id, enabled: !routine.enabled }),
            )
          }
        />
        <Button
          title="Delete routine"
          variant="danger"
          disabled={action.disabled}
          onPress={() =>
            confirm({
              title: "Delete routine?",
              description: `This deletes “${routine.title}” and stops its queued and active runs. You cannot undo this.`,
              confirm: "Delete routine",
              action: () => void action.run((api) => api.deleteBotRoutine({ botId, routineId: routine.id })),
            })
          }
        />
      </View>
      {action.error && <Notice error>{action.error}</Notice>}
    </View>
  );
}

function ReminderRow({ botId, reminder, readOnly }: { botId: string; reminder: bots.BotReminder; readOnly: boolean }) {
  const action = useScheduleAction(readOnly);

  return (
    <View style={{ gap: 8 }}>
      <PanelRow
        title={reminder.prompt}
        value={reminder.runAt ? timestampDate(reminder.runAt).toLocaleString() : ""}
        icon="clock"
      />
      <Button
        title="Cancel reminder"
        busy={action.busy}
        disabled={action.disabled}
        onPress={() => void action.run((api) => api.cancelBotReminder({ botId, reminderId: reminder.id }))}
      />
      {action.error && <Notice error>{action.error}</Notice>}
    </View>
  );
}
