import { Text, View } from "react-native";
import { router } from "expo-router";
import type { Usage, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ConnectorList, useConnectors } from "../connectors/Connectors";
import { permissionLabel } from "./permissions";
import { ThreadPlacement } from "./ThreadPlacement";
import { ThreadUsage } from "./ThreadUsage";
import { ThreadBackgroundTasks } from "./ThreadBackgroundTasks";
import { SubagentLineage } from "./SubagentLineage";
import { ListSkeleton } from "../../ui/Skeleton";
import { SecretGrants } from "./ThreadSecrets";
import { useComputerHome } from "../computers/presence";
import { useSession } from "../../state/session";
import { openSettingsSection } from "../settings/navigation";

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
  usage,
  visible,
  onClose,
}: {
  snapshot?: ui.ThreadSnapshot;
  usage?: Usage;
  visible: boolean;
  onClose: () => void;
}) {
  const { threads, workers } = useOverview();
  const c = useColors();
  const thread = snapshot?.thread;
  const home = useComputerHome(thread?.nodeId);
  const { online } = useSession();
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
            <PanelRow
              title="Model"
              value={[thread.model || "Default model", thread.effort].filter(Boolean).join(" · ")}
              icon="cpu-chip"
            />
            <PanelRow title="Status" value={thread.status.replace("_", " ")} icon="check-circle" />
            <PanelRow title="Permissions" value={permissionLabel(thread.permissionMode)} icon="shield-check" />
          </View>
          {snapshot && <ThreadUsage snapshot={snapshot} live={usage} />}
          {visible && <SecretGrants secrets={snapshot?.secrets ?? []} disabled={home.away || !online} />}
          {snapshot && <ThreadSchedules snapshot={snapshot} onClose={onClose} />}
          {snapshot && <ThreadBackgroundTasks snapshot={snapshot} disabled={home.away || !online} />}
          <Text style={[styles.label, { color: c.text }]}>Lineage</Text>
          {lineage.length || subagents.length ? (
            lineage.map((t) => <Button key={t.id} title={t.title} onPress={() => openThread(t.id)} />)
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>Main thread</Text>
          )}
          <SubagentLineage threads={subagents} onOpen={openThread} />
          <Text style={[styles.label, { color: c.text }]}>Connectors</Text>
          <ThreadConnectors threadId={thread.id} />
          <Button
            title="Manage connector access"
            onPress={() => {
              onClose();
              openSettingsSection("connectors");
            }}
          />
        </>
      )}
    </Sheet>
  );
}

function ThreadSchedules({ snapshot, onClose }: { snapshot: ui.ThreadSnapshot; onClose: () => void }) {
  const c = useColors();

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: c.text }]}>Scheduled tasks</Text>
      {snapshot.schedules.length ? (
        snapshot.schedules.map((s) => (
          <PanelRow key={s.id} title={s.name || "Scheduled task"} value={s.status} icon="clock" />
        ))
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>No scheduled tasks</Text>
      )}
      <Button
        title="Manage thread schedules"
        onPress={() => {
          onClose();
          openSettingsSection("schedules", { threadId: snapshot.thread?.id ?? "" });
        }}
      />
    </View>
  );
}

function ThreadConnectors({ threadId }: { threadId: string }) {
  const c = useColors();
  const { list, error } = useConnectors(threadId);

  if (list?.accounts.length) return <ConnectorList list={list} />;

  if (!list && !error) return <ListSkeleton rows={2} inset={false} />;

  return <Text style={[styles.meta, { color: c.muted }]}>{error || "No connectors"}</Text>;
}
