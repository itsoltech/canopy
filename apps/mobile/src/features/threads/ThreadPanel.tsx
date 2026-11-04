import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { permissionLabels } from "./MessageComposer";

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
  visible,
  onClose,
}: {
  snapshot?: ui.ThreadSnapshot;
  visible: boolean;
  onClose: () => void;
}) {
  const { threads, workers } = useOverview();
  const c = useColors();
  const thread = snapshot?.thread;
  const worker = workers.find((w) => w.id === thread?.workerId);

  const lineage = thread
    ? threads.filter(
        (t) => t.parentThreadId === thread.id || t.id === thread.parentThreadId || t.id === thread.forkSourceThreadId,
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
            <PanelRow
              title="Model"
              value={[thread.model || "Default model", thread.effort].filter(Boolean).join(" · ")}
              icon="cpu-chip"
            />
            <PanelRow title="Status" value={thread.status.replace("_", " ")} icon="check-circle" />
            <PanelRow
              title="Permissions"
              value={permissionLabels[thread.permissionMode] ?? "Ask first"}
              icon="shield-check"
            />
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
          <Text style={[styles.meta, { color: c.muted }]}>Manage thread connectors in Canopy on the web.</Text>
        </>
      )}
    </Sheet>
  );
}
