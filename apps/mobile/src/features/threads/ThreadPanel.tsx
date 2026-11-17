import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors, useTypography } from "../../ui/theme";
import { ThreadConnectors } from "./ThreadConnectors";
import { useThreadPanel } from "./use-thread-panel";
import { ThreadPlacement } from "./ThreadPlacement";
import { ThreadBackgroundTasks } from "./ThreadBackgroundTasks";
import { SubagentLineage } from "./SubagentLineage";
import { SecretGrants } from "./ThreadSecrets";
import { useComputerHome } from "../computers/presence";
import { useSession } from "../../state/session";
import { ThreadPullRequests } from "../github/ThreadPullRequests";
import { ThreadAutoArchive } from "./ThreadAutoArchive";
import { ThreadPanelSection } from "./ThreadPanelSection";
import { ThreadSchedules } from "./ThreadSchedules";

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
  const type = useTypography();
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
    <Sheet title="Thread details" visible={visible} onClose={onClose} snap compact>
      {thread && (
        <>
          {stale && (
            <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
              {panel.data?.unavailable
                ? `Thread details are unavailable. Manage on ${home.name}.`
                : `${home.reason || `Thread details on ${home.name} are unreachable.`} Showing last known details.`}
            </Text>
          )}
          <ThreadPanelSection>
            <View style={[styles.row, { minHeight: 40 }]}>
              <Icon name="computer-desktop" />
              <Text numberOfLines={1} style={[type.chrome, { flex: 1, color: c.text }]}>
                {worker?.name ?? "Unknown worker"}
              </Text>
              <Text style={[type.meta, { color: c.muted }]}>{worker?.online ? "Online" : "Offline"}</Text>
            </View>
            <ThreadPlacement thread={thread} onClose={onClose} />
            {!!thread.permissionModeNote && (
              <Text style={[type.meta, { color: c.muted }]}>{thread.permissionModeNote}</Text>
            )}
          </ThreadPanelSection>
          {visible && (
            <View style={{ minWidth: 0 }}>
              <ThreadPullRequests thread={thread} onClose={onClose} />
              <ThreadAutoArchive key={thread.id} thread={thread} disabled={stale} />
            </View>
          )}
          {snapshot && <ThreadBackgroundTasks snapshot={snapshot} disabled={home.away || !online} onOpen={onClose} />}
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
          <ThreadConnectors {...{ thread, panel }} disabled={stale} homeName={home.name} />
          {(lineage.length > 0 || subagents.length > 0) && (
            <ThreadPanelSection title="Lineage">
              {lineage.map((t) => (
                <Button
                  key={t.id}
                  title={t.title}
                  variant="ghost"
                  icon="chat-bubble-left-right"
                  style={{ justifyContent: "flex-start", minHeight: 40 }}
                  onPress={() => openThread(t.id)}
                />
              ))}
              <SubagentLineage threads={subagents} onOpen={openThread} />
            </ThreadPanelSection>
          )}
        </>
      )}
    </Sheet>
  );
}
