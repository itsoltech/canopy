import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow, SettingsActions } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, useSettingsResource } from "./resource";
import { WorkerCliSettings } from "./WorkerCliSettings";
import { WorkerDetails } from "./WorkerDetails";
import { WorkerEnrollment } from "./WorkerEnrollment";
import { WorkerSsh } from "./WorkerSsh";
import { UpdateSettings } from "./UpdateSettings";
import { useDateTime } from "./display";
import { useOverview } from "../../state/overview";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";

export function WorkerSettings() {
  const overview = useOverview();

  const resource = useSettingsResource("workers", async (api) => {
    const [overview, setup, environment, records, network] = await Promise.all([
      api.getOverview({}),
      api.getWorkerSetup({}),
      api.getAgentEnvironment({}),
      api.listWorkerRecords({}),
      api.getNetworkAccess({}),
    ]);

    return { overview, setup, environment, records, network };
  });

  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const format = useDateTime();
  const data = resource.data;
  const groups = workerGroups(data?.overview.workers ?? overview.workers, data?.records.records ?? []);
  const pending = data?.setup.enrollments.filter((e) => !e.usedAt && !e.revokedAt) ?? [];

  return (
    <ResourceState resource={resource}>
      <SettingsActions>
        <Button title="Add worker" disabled={!data} onPress={() => setAdding(true)} />
      </SettingsActions>
      {(data || resource.initialLoading) && (
        <SettingsGroup title="Network access">
          <SettingsRow
            title={data?.network.enabled ? "Remote access is on" : "Remote access is off"}
            description={data?.network.note || "Connect paired devices and remote workers to this gateway."}
            control={
              <Button
                secondary
                title="Manage network access"
                onPress={() => router.push("/settings?section=network")}
              />
            }
          />
        </SettingsGroup>
      )}
      {resource.initialLoading && !groups.length && <SettingsSkeletonGroups titles={["This computer"]} />}
      {groups.map((group) => (
        <View key={group.id} style={{ gap: 12 }}>
          <ComputerHeading title={group.name} />
          {group.workers.map((worker) => (
            <WorkerCard
              key={worker.id}
              worker={worker}
              record={data?.records.records.find((r) => r.workerId === worker.id)}
              expanded={expanded.includes(worker.id)}
              onToggle={() =>
                setExpanded((ids) =>
                  ids.includes(worker.id) ? ids.filter((id) => id !== worker.id) : [...ids, worker.id],
                )
              }
            >
              {data && (
                <WorkerDetails
                  worker={worker}
                  setup={data.setup}
                  environment={data.environment}
                  record={data.records.records.find((r) => r.workerId === worker.id)}
                  onChanged={() => void resource.reload()}
                  onClose={() => setExpanded((ids) => ids.filter((id) => id !== worker.id))}
                />
              )}
            </WorkerCard>
          ))}
        </View>
      ))}
      {data && !groups.length && (
        <Notice>No workers yet. Add a worker to run Claude, Codex or Grok on a computer you control.</Notice>
      )}
      {!!pending.length && (
        <SettingsGroup title="Pending enrollments">
          {pending.map((e) => (
            <SettingsRow
              key={e.id}
              title={e.name}
              description={`Waiting for enrollment · expires ${format(e.expiresAt?.seconds)}`}
              control={
                <Button
                  secondary
                  title="Revoke"
                  disabled={resource.busy}
                  onPress={() => void resource.run((api) => api.revokeWorkerEnrollment({ id: e.id }))}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}
      <SettingsGroup title="Agent CLI updates" description="Account · Workers can override this schedule.">
        <WorkerCliSettings />
      </SettingsGroup>
      <UpdateSettings />
      <SettingsGroup title="Install over SSH">
        <View>
          <WorkerSsh />
        </View>
      </SettingsGroup>
      <WorkerConnection url={data?.setup.gatewayUrl || ""} onSaved={resource.reload} />
      {adding && data && (
        <WorkerEnrollment
          setup={data.setup}
          onClose={() => {
            setAdding(false);
            void resource.reload();
          }}
        />
      )}
    </ResourceState>
  );
}

function WorkerConnection({ url, onSaved }: { url: string; onSaved: () => Promise<void> }) {
  const settings = useAppearance();

  return (
    <SettingsGroup title="Worker connection">
      <SettingsInput
        title="Gateway address"
        description="Used for new worker installations. Existing workers keep their working connection."
        value={settings.user?.workerGatewayUrl || url}
        busy={settings.saving}
        onSave={async (workerGatewayUrl) => {
          await settings.update({ workerGatewayUrl });
          await onSaved();

          return true;
        }}
      />
    </SettingsGroup>
  );
}

function ComputerHeading({ title }: { title: string }) {
  const c = useColors();

  return (
    <Text
      accessibilityRole="header"
      style={[styles.chrome, { fontFamily: font.semibold, color: c.text, paddingHorizontal: 4 }]}
    >
      {title}
    </Text>
  );
}

function WorkerCard({
  worker,
  record,
  expanded,
  onToggle,
  children,
}: {
  worker: ui.Worker;
  record?: ui.WorkerRecord;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const c = useColors();
  const format = useDateTime();

  const status =
    worker.revokedAt || record?.revoked
      ? "Revoked"
      : worker.online && !record?.readOnlyReason
        ? "Connected"
        : "Disconnected";

  const updates = worker.cliTools.filter((tool) => tool.action === "update").length;
  const route = worker.networkRouteStatus;

  const meta = [
    worker.hostname,
    worker.os,
    worker.version && `v${worker.version}`,
    !worker.online && worker.lastSeenAt && `seen ${format(worker.lastSeenAt.seconds)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View
      style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, overflow: "hidden", backgroundColor: c.surface }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={worker.name}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => ({
          padding: 16,
          flexDirection: "row",
          gap: 12,
          alignItems: "center",
          backgroundColor: pressed ? c.inset : "transparent",
        })}
      >
        <Icon name="computer-desktop" />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text style={[styles.chrome, { fontFamily: font.semibold, color: c.text }]}>{worker.name}</Text>
          <Text style={[styles.workMeta, { color: c.muted }]}>{meta}</Text>
          {worker.online && route && route.route !== "local" && (
            <Text style={[styles.workMeta, { color: c.muted }]}>
              {route.route === "pinned" ? "Over the secure route" : "Over the server port"}
              {route.detail ? ` · secure route unavailable: ${route.detail}` : ""}
            </Text>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {!!updates && (
              <Text style={[styles.workMeta, { color: c.text }]}>
                {updates} {updates === 1 ? "update" : "updates"}
              </Text>
            )}
            <Text style={[styles.workMeta, { color: c.text }]}>{status}</Text>
          </View>
        </View>
        <View style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}>
          <Icon name="chevron-down" />
        </View>
      </Pressable>
      {expanded && children}
    </View>
  );
}

function workerGroups(workers: ui.Worker[], records: ui.WorkerRecord[]) {
  const groups = new Map<string, { id: string; name: string; workers: ui.Worker[] }>();

  const entries = [
    ...workers.filter((w) => !w.nodeId),
    ...records.map(
      (r) =>
        workers.find((w) => w.id === r.workerId) ??
        create(ui.WorkerSchema, {
          id: r.workerId,
          nodeId: r.nodeId,
          name: r.name,
          hostname: r.hostname,
          os: r.os,
          arch: r.arch,
          ...(r.cliUpdateCheckMinutes !== undefined && { cliUpdateCheckMinutes: r.cliUpdateCheckMinutes }),
        }),
    ),
  ];

  for (const worker of entries) {
    const id = worker.nodeId;

    const group = groups.get(id) ?? {
      id,
      name: records.find((r) => r.workerId === worker.id)?.computerName || "This computer",
      workers: [],
    };

    group.workers.push(worker);
    groups.set(id, group);
  }

  return [...groups.values()].sort((a, b) => Number(!!a.id) - Number(!!b.id) || a.name.localeCompare(b.name));
}
