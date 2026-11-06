import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ConnectorList, useConnectors } from "../connectors/Connectors";
import { permissionLabel } from "./permissions";
import { headLabel, PROVISIONAL_BRANCH_HINT } from "@canopy/domain/git-heads";
import { useDevicePreferences } from "../settings/device-preferences";
import { isActiveSubagent } from "./SubagentStrip";
import { ListSkeleton } from "../../ui/Skeleton";

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

/** The live branch: of the thread's worktree (with its base), else of the workspace's own checkout. */
function BranchRow({ thread }: { thread: ui.Thread }) {
  const worktree = thread.worktree;
  const head = worktree ?? thread.checkoutHead;
  const label = head ? headLabel(head) : "";

  if (!label) return null;
  const detail = worktree ? (worktree.baseRef ? `Worktree from ${worktree.baseRef}` : "Worktree") : "Current checkout";
  const value = worktree?.provisionalBranch ? `${label}\n${PROVISIONAL_BRANCH_HINT}` : label;

  return <PanelRow title={`Branch · ${detail}`} value={value} icon="git-fork" />;
}

export function ThreadPanel({
  snapshot,
  visible,
  onClose,
}: {
  snapshot?: ui.ThreadSnapshot;
  visible: boolean;
  onClose: () => void;
}) {
  const { threads, workers } = useOverview();
  const { values } = useDevicePreferences();
  const c = useColors();
  const thread = snapshot?.thread;
  const worker = workers.find((w) => w.id === thread?.workerId);

  const lineage = thread
    ? threads.filter(
        (t) =>
          !t.deletedAt &&
          ((t.parentThreadId === thread.id &&
            (!t.spawnedByAgent || values.showFinishedSubagents === "on" || isActiveSubagent(t))) ||
            t.id === thread.parentThreadId ||
            t.id === thread.forkSourceThreadId),
      )
    : [];

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
            <PanelRow title="Working directory" value={thread.cwd} icon="folder" />
            <BranchRow thread={thread} />
            <PanelRow
              title="Model"
              value={[thread.model || "Default model", thread.effort].filter(Boolean).join(" · ")}
              icon="cpu-chip"
            />
            <PanelRow title="Status" value={thread.status.replace("_", " ")} icon="check-circle" />
            <PanelRow title="Permissions" value={permissionLabel(thread.permissionMode)} icon="shield-check" />
          </View>
          <Text style={[styles.label, { color: c.text }]}>Scheduled tasks</Text>
          {snapshot?.schedules.length ? (
            snapshot.schedules.map((s) => (
              <PanelRow key={s.id} title={s.name || "Scheduled task"} value={s.status} icon="clock" />
            ))
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>No scheduled tasks</Text>
          )}
          <Text style={[styles.label, { color: c.text }]}>Lineage</Text>
          {lineage.length ? (
            lineage.map((t) => (
              <Button
                key={t.id}
                secondary
                title={t.title}
                onPress={() => {
                  onClose();
                  router.push({
                    pathname: "/thread/[id]",
                    params: { id: t.id },
                  });
                }}
              />
            ))
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>Main thread</Text>
          )}
          <Text style={[styles.label, { color: c.text }]}>Connectors</Text>
          <ThreadConnectors threadId={thread.id} />
          <Text style={[styles.meta, { color: c.muted }]}>Manage thread connectors in Canopy on the web.</Text>
        </>
      )}
    </Sheet>
  );
}

function ThreadConnectors({ threadId }: { threadId: string }) {
  const c = useColors();
  const { list, error } = useConnectors(threadId);

  if (list?.accounts.length) return <ConnectorList list={list} />;

  if (!list && !error) return <ListSkeleton rows={2} inset={false} />;

  return <Text style={[styles.meta, { color: c.muted }]}>{error || "No connectors"}</Text>;
}
