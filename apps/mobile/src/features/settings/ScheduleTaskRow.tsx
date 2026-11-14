import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { describeCron, scheduleHeading, scheduleRunLabel } from "@canopy/domain/schedule-display";
import { dayKey } from "@canopy/domain/format";
import { useOverview } from "../../state/overview";
import { Badge } from "../../ui/Badge";
import { Button, IconButton } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { Accordion } from "../../ui/Accordion";
import { SettingsGroup } from "./SettingsGroup";

const statuses = new Map([
  ["completed", "Done"],
  ["active", "Active"],
  ["paused", "Paused"],
  ["cancelled", "Cancelled"],
]);

export function ScheduleTaskRow({
  schedule: s,
  reason,
  onActions,
  onDuplicate,
}: {
  schedule: ui.Schedule;
  reason?: string;
  onActions: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { threads, workers } = useOverview();
  const c = useColors();
  const type = useTypography();
  const heading = scheduleHeading(s);
  const thread = threads.find((t) => t.id === s.threadId);
  const worker = workers.find((w) => w.id === (thread?.workerId || s.recentRuns[0]?.workerId));

  const timezone =
    s.timezone && s.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${s.timezone})` : "";

  const when =
    s.kind === "recurring"
      ? `${describeCron(s.cron)}${timezone}`
      : `Once, ${s.runAt ? timestampDate(s.runAt).toLocaleString() : ""}`;

  const runs = `${s.runs} ${s.runs === 1 ? "run" : "runs"}`;

  return (
    <SettingsGroup style={reason ? { opacity: 0.55 } : undefined}>
      <View style={{ gap: 2, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={[type.chrome, { flex: 1, color: c.text }]}>
            {heading}
          </Text>
          <Badge>{statuses.get(s.status) ?? s.status}</Badge>
          <IconButton
            icon="ellipsis-horizontal"
            label="Scheduled task actions"
            size="sm"
            disabled={!!reason}
            onPress={onActions}
          />
        </View>
        {heading !== s.prompt && (
          <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
            {s.prompt}
          </Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={[type.meta, { flex: 1, color: c.muted }]}>
            {when}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={s.createdBy === "agent" ? "Created by agent" : "Created by you"}
            onPress={() => setOpen(!open)}
            hitSlop={8}
          >
            <Icon name={s.createdBy === "agent" ? "sparkles" : "user"} size={14} />
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Button
            title={runs}
            variant="text"
            size="sm"
            icon={open ? "chevron-down" : "chevron-right"}
            hint={open ? "Hide task details" : "Show task details and recent runs"}
            onPress={() => setOpen(!open)}
          />
          <Pressable
            accessibilityRole="link"
            disabled={!s.threadId}
            onPress={() => router.push(`/threads/${s.threadId}`)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <Text numberOfLines={1} style={[type.meta, { color: c.soft }]}>
              {s.target === "new_thread" ? "New thread" : thread?.title || "Open thread"}
            </Text>
          </Pressable>
          {worker && (
            <Text numberOfLines={1} style={[type.meta, { maxWidth: "25%", color: c.muted }]}>
              {worker.name}
            </Text>
          )}
        </View>
        {reason && <Text style={[type.meta, { color: c.muted }]}>{reason} Read-only</Text>}
        <Accordion open={open} style={{ marginTop: -2 }}>
          <ScheduleTaskDetails schedule={s} when={when} reason={reason} onDuplicate={onDuplicate} />
        </Accordion>
      </View>
    </SettingsGroup>
  );
}

/** The expanded part of a row: full message, state, edits, recent runs and Duplicate. */
function ScheduleTaskDetails({
  schedule: s,
  when,
  reason,
  onDuplicate,
}: {
  schedule: ui.Schedule;
  when: string;
  reason?: string;
  onDuplicate: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 6, paddingTop: 8 }}>
      <Text style={[type.meta, { color: c.muted }]}>{when}</Text>
      {s.maxRuns > 0 && (
        <Text style={[type.meta, { color: c.muted }]}>
          {s.runs} of {s.maxRuns} runs
        </Text>
      )}
      <Text style={[type.meta, { color: c.muted }]}>
        {s.createdBy === "agent" ? "Created by agent" : "Created by you"}
      </Text>
      <Text selectable style={[type.chrome, { color: c.text }]}>
        {s.prompt}
      </Text>
      {s.nextRunAt && (
        <Text style={[type.meta, { color: c.muted }]}>Next run · {timestampDate(s.nextRunAt).toLocaleString()}</Text>
      )}
      {s.lastEditedAt && (
        <Text style={[type.meta, { color: c.muted }]}>
          Edited by you · {timestampDate(s.lastEditedAt).toLocaleString()}
        </Text>
      )}
      <ScheduleRunHistory runs={s.recentRuns} threadId={s.threadId} />
      {!reason && (
        <View style={{ alignSelf: "flex-start" }}>
          <Button title="Duplicate schedule" size="sm" icon="document-duplicate" onPress={onDuplicate} />
        </View>
      )}
    </View>
  );
}

function ScheduleRunHistory({ runs, threadId }: { runs: readonly ui.ScheduleRun[]; threadId: string }) {
  const { threads, workers } = useOverview();
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 2 }}>
      {runs.map((run, index) => (
        <View key={`${run.scheduledFor?.seconds}:${run.scheduledFor?.nanos}`}>
          {(index === 0 || dayKey(run.scheduledFor) !== dayKey(runs[index - 1]?.scheduledFor)) && (
            <Text style={[type.meta, { color: c.muted, paddingVertical: 4 }]}>
              {run.scheduledFor ? timestampDate(run.scheduledFor).toLocaleDateString() : ""}
            </Text>
          )}
          <Pressable
            accessibilityRole={run.threadId ? "link" : "text"}
            disabled={!run.threadId}
            onPress={() => router.push(`/threads/${run.threadId}`)}
            style={{ flexDirection: "row", minHeight: 44, alignItems: "center", gap: 6 }}
          >
            <Icon name={run.outcome === "started" ? "play" : "exclamation-circle"} size={14} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[type.meta, { color: c.soft }]}>
                {run.number ? `Run ${run.number}` : scheduleRunLabel(run.outcome)} ·{" "}
                {run.scheduledFor
                  ? timestampDate(run.scheduledFor).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : ""}
                {run.workerId ? ` · ${workers.find((w) => w.id === run.workerId)?.name ?? "Computer unavailable"}` : ""}
                {run.number && run.outcome !== "started" ? ` · ${scheduleRunLabel(run.outcome)}` : ""}
              </Text>
              {run.threadId && run.threadId !== threadId && (
                <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
                  {threads.find((t) => t.id === run.threadId)?.title ?? "Open thread"}
                </Text>
              )}
            </View>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
