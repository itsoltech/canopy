import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ThreadConnectors } from "./ThreadConnectors";
import { useThreadPanel } from "./use-thread-panel";
import { ThreadPlacement } from "./ThreadPlacement";
import { ThreadBackgroundTasks } from "./ThreadBackgroundTasks";
import { SubagentLineage } from "./SubagentLineage";
import { SecretGrants } from "./ThreadSecrets";
import { useComputerHome } from "../computers/presence";
import { useSession } from "../../state/session";
import { openSettingsSection } from "../settings/navigation";
import { ThreadPullRequests } from "../github/ThreadPullRequests";

export function PanelRow({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon?: Parameters<typeof Icon>[0]["name"];
}) {
  const c = useColors();

  return (
    <View
      style={{
        paddingVertical: 12,
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: c.line,
      }}
    >
      <View style={styles.row}>
        {icon && <Icon name={icon} />}
        <Text style={[styles.meta, { color: c.muted }]}>{title}</Text>
      </View>
      <Text selectable style={[styles.body, { color: c.text }]}>
        {value}
      </Text>
    </View>
  );
}

export function ThreadPanel({
  snapshot,
  syncStatus,
  visible,
  onClose,
}: {
  snapshot?: ui.ThreadSnapshot;
  syncStatus?: ui.ThreadSyncStatus | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  const { threads, workers } = useOverview();
  const c = useColors();
  const thread = snapshot?.thread;
  const home = useComputerHome(thread?.nodeId);
  const { online } = useSession();
  const panel = useThreadPanel(thread?.id ?? "", visible && !!thread);

  const stale =
    home.away || !online || syncStatus?.reason === "computer_unreachable" || !!panel.data?.stale || !!panel.error;

  const worker = workers.find((w) => w.id === thread?.workerId);

  const lineage = thread
    ? threads.filter(
        (t) =>
          !t.deletedAt &&
          ((t.parentThreadId === thread.id && !t.spawnedByAgent) ||
            t.id === thread.parentThreadId ||
            t.id === thread.forkSourceThreadId),
      )
    : [];

  const subagents = threads.filter((t) => t.parentThreadId === thread?.id && t.spawnedByAgent && !t.deletedAt);

  function openThread(id: string) {
    onClose();
    router.push({ pathname: "/thread/[id]", params: { id } });
  }

  return (
    <Sheet title="Thread details" visible={visible} onClose={onClose}>
      {thread && (
        <>
          {stale && (
            <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
              {panel.data?.unavailable
                ? `Thread details are unavailable. Manage on ${home.name}.`
                : `${home.reason || `Thread details on ${home.name} are unreachable.`} Showing last known details.`}
            </Text>
          )}
          <ThreadConnectors {...{ thread, panel }} disabled={stale} homeName={home.name} />
          <View
            style={{
              borderWidth: 1,
              borderColor: c.line,
              borderRadius: 16,
              paddingHorizontal: 16,
            }}
          >
            <PanelRow
              title="Worker"
              value={`${worker?.name ?? "Unknown worker"} · ${worker?.online ? "Online" : "Offline"}`}
              icon="computer-desktop"
            />
            <ThreadPlacement thread={thread} onClose={onClose} />
            {!!thread.permissionModeNote && (
              <Text style={[styles.meta, { color: c.muted }]}>{thread.permissionModeNote}</Text>
            )}
          </View>
          {visible && <ThreadPullRequests thread={thread} onClose={onClose} />}
          {visible && <SecretGrants secrets={snapshot?.secrets ?? []} disabled={home.away || !online} />}
          {snapshot && (
            <ThreadSchedules
              snapshot={snapshot}
              schedules={
                thread.nodeId || stale || !snapshot.schedules.length
                  ? (panel.data?.schedules ?? snapshot.schedules)
                  : snapshot.schedules
              }
              unavailable={!!panel.data?.unavailable}
              disabled={stale}
              onClose={onClose}
            />
          )}
          {snapshot && <ThreadBackgroundTasks snapshot={snapshot} disabled={home.away || !online} />}
          <Text style={[styles.label, { color: c.text }]}>Lineage</Text>
          {lineage.length || subagents.length ? (
            lineage.map((t) => <Button key={t.id} title={t.title} onPress={() => openThread(t.id)} />)
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>Main thread</Text>
          )}
          <SubagentLineage threads={subagents} onOpen={openThread} />
        </>
      )}
    </Sheet>
  );
}

function ThreadSchedules({
  snapshot,
  schedules,
  unavailable,
  disabled,
  onClose,
}: {
  snapshot: ui.ThreadSnapshot;
  schedules: readonly ui.Schedule[];
  unavailable: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  const c = useColors();

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: c.text }]}>Scheduled tasks</Text>
      {schedules.length ? (
        schedules.map((s) => <PanelRow key={s.id} title={s.name || "Scheduled task"} value={s.status} icon="clock" />)
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>
          {unavailable ? "Connect to load scheduled tasks" : "No scheduled tasks"}
        </Text>
      )}
      <Button
        title="Manage thread schedules"
        disabled={disabled}
        onPress={() => {
          onClose();
          openSettingsSection("schedules", { threadId: snapshot.thread?.id ?? "" });
        }}
      />
    </View>
  );
}
