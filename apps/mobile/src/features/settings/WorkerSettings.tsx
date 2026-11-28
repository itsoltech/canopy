import { useRef, useState, type ComponentRef } from "react";
import { Pressable, Text, View } from "react-native";
import { useOpenSettingsSection } from "./navigation";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useTimeLabel } from "../../ui/time";
import { AccountConfigNotices } from "./AccountConfigNotices";
import { useLocalSearchParams, useRoute } from "expo-router";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography, weightedFont } from "../../ui/theme";
import { SettingsGroup, SettingsRow, SettingsActions } from "./SettingsGroup";
import { SettingsTopics } from "./SettingsTopics";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, useSettingsResource } from "./resource";
import { WorkerCliSettings } from "./WorkerCliSettings";
import { WorkerDetails } from "./WorkerDetails";
import { WorkerEnrollment } from "./WorkerEnrollment";
import { WorkerSsh } from "./WorkerSsh";
import { useDateTime } from "./display";
import { useOverview } from "../../state/overview";
import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { useWorkerPresence } from "../computers/presence";

import { createSettingsViewState, useRevealSettingsView } from "./SettingsScroll";

const useRememberedWorkers = createSettingsViewState<string[]>([]);
const useRevealedShortcut = createSettingsViewState(false);

function useWorkerExpansion() {
  const { workerId, workerTopic } = useLocalSearchParams<{ workerId?: string; workerTopic?: string }>();
  const route = useRoute();
  const entry = workerId ? route.key : undefined;
  const [expanded, setExpanded] = useRememberedWorkers(entry, workerId ? [workerId] : []);
  const [revealed, setRevealed] = useRevealedShortcut(entry);

  return {
    expanded,
    setExpanded,
    entry,
    workerId,
    workerTopic,
    revealId: revealed ? undefined : workerId,
    markRevealed: () => setRevealed(true),
  };
}

function useWorkerResources() {
  // Each part is a shared read: other screens reuse it and events refresh only the part that changed.
  const setup = useSettingsResource("GetWorkerSetup", (api) => api.getWorkerSetup({}));
  const environment = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const records = useSettingsResource("ListWorkerRecords", (api) => api.listWorkerRecords({}));
  const network = useSettingsResource("GetNetworkAccess", (api) => api.getNetworkAccess({}));
  const parts = [setup, environment, records, network];
  const error = parts.find((part) => part.error)?.error ?? "";

  const resource = {
    ...setup,
    error,
    initialLoading: parts.some((part) => part.initialLoading) && !error,
    reload: () => Promise.all(parts.map((part) => part.reload())).then(() => undefined),
  };

  const data =
    setup.data && environment.data && records.data && network.data
      ? { setup: setup.data, environment: environment.data, records: records.data, network: network.data }
      : undefined;

  return { data, resource };
}

export function WorkerSettings() {
  const { data, resource } = useWorkerResources();
  const overview = useOverview();
  const openSettingsSection = useOpenSettingsSection();
  const expansion = useWorkerExpansion();
  const [adding, setAdding] = useState(false);
  const format = useDateTime();

  const groups = workerGroups(overview.workers, data?.records.records ?? [], overview.computers);

  const enrollments = data?.setup.enrollments;
  const minute = useTimeLabel((time) => String(Math.floor(time / 60_000)), !!enrollments?.length);

  const pending =
    enrollments?.filter(
      (e) => !e.usedAt && !e.revokedAt && e.expiresAt && Number(e.expiresAt.seconds) > Number(minute) * 60,
    ) ?? [];

  return (
    <ResourceState resource={resource}>
      <SettingsTopics
        scopeKey={expansion.entry}
        topics={[
          {
            id: "workers",
            label: "Registered workers",
            content: (
              <>
                <SettingsActions>
                  <Button variant="ghost" title="Open app updates" onPress={() => openSettingsSection("app-updates")} />
                  <Button variant="primary" title="Add worker" disabled={!data} onPress={() => setAdding(true)} />
                </SettingsActions>
                <RegisteredWorkers groups={groups} data={data} resource={resource} expansion={expansion} />
              </>
            ),
          },
          {
            id: "connections",
            label: "Connections",
            content: (
              <>
                {(data || resource.initialLoading) && <WorkerNetworkAccess network={data?.network} />}
                <SettingsGroup title="Install over SSH">
                  <WorkerSsh />
                </SettingsGroup>
                <WorkerConnection url={data?.setup.gatewayUrl || ""} onSaved={resource.reload} />
                {!!pending.length && (
                  <SettingsGroup title="Pending enrollments">
                    {pending.map((e) => (
                      <SettingsRow
                        key={e.id}
                        title={e.name}
                        description={`Waiting for enrollment · expires ${format(e.expiresAt?.seconds)}`}
                        control={
                          <Button
                            title="Revoke"
                            disabled={resource.busy}
                            onPress={() => void resource.run((api) => api.revokeWorkerEnrollment({ id: e.id }))}
                          />
                        }
                      />
                    ))}
                  </SettingsGroup>
                )}
              </>
            ),
          },
          {
            id: "agent-clis",
            label: "Agent CLIs",
            content: (
              <>
                {groups.length > 0 && (
                  <SettingsGroup title="Agent CLIs by worker">
                    {groups.flatMap((group) =>
                      group.workers.map((worker) => (
                        <SettingsRow
                          key={worker.id}
                          title={worker.name}
                          description={group.name}
                          onPress={() =>
                            openSettingsSection("workers", { workerId: worker.id, workerTopic: "agent-clis" })
                          }
                        />
                      )),
                    )}
                  </SettingsGroup>
                )}
                <SettingsGroup title="Agent CLI updates" description="Account · Workers can override this schedule.">
                  <WorkerCliSettings />
                </SettingsGroup>
                <AccountConfigNotices sections={["cliUpdates"]} />
              </>
            ),
          },
        ]}
      />
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

function RegisteredWorkers({
  groups,
  data,
  resource,
  expansion,
}: ReturnType<typeof useWorkerResources> & {
  groups: ReturnType<typeof workerGroups>;
  expansion: ReturnType<typeof useWorkerExpansion>;
}) {
  const { expanded, setExpanded, entry, workerId, workerTopic, revealId, markRevealed } = expansion;

  return (
    <>
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
              onReveal={revealId === worker.id ? markRevealed : undefined}
              onToggle={() =>
                setExpanded(
                  expanded.includes(worker.id) ? expanded.filter((id) => id !== worker.id) : [...expanded, worker.id],
                )
              }
            >
              {data && (
                <WorkerDetails
                  worker={worker}
                  scopeKey={JSON.stringify(["worker", worker.id, worker.id === workerId ? entry : undefined])}
                  defaultTopic={worker.id === workerId ? workerTopic : undefined}
                  setup={data.setup}
                  environment={data.environment}
                  record={data.records.records.find((r) => r.workerId === worker.id)}
                  onChanged={() => void resource.reload()}
                  onClose={() => setExpanded(expanded.filter((id) => id !== worker.id))}
                />
              )}
            </WorkerCard>
          ))}
        </View>
      ))}
      {data && !groups.length && (
        <SettingsGroup>
          <SettingsRow title="No workers yet" description="Add a worker to run agents on a computer you control." />
        </SettingsGroup>
      )}
    </>
  );
}

function WorkerNetworkAccess({ network }: { network?: ui.NetworkAccess }) {
  const openSettingsSection = useOpenSettingsSection();

  return (
    <SettingsGroup title="Network access">
      <SettingsRow
        title={network?.enabled ? "Remote access is on" : "Remote access is off"}
        inlineControl="wrap"
        description={network?.note || "Connect paired devices and remote workers to this gateway."}
        control={<Button title="Manage network access" onPress={() => openSettingsSection("network")} />}
      />
    </SettingsGroup>
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
          const saved = await settings.update({ workerGatewayUrl });

          if (saved) await onSaved();

          return saved;
        }}
      />
    </SettingsGroup>
  );
}

function ComputerHeading({ title }: { title: string }) {
  const c = useColors();
  const type = useTypography();

  return (
    <Text
      accessibilityRole="header"
      style={[type.chrome, weightedFont(type.chrome.fontFamily, "semibold"), { color: c.text, paddingHorizontal: 4 }]}
    >
      {title}
    </Text>
  );
}

function WorkerCard({
  worker,
  record,
  expanded,
  onReveal,
  onToggle,
  children,
}: {
  worker: ui.Worker;
  record?: ui.WorkerRecord;
  expanded: boolean;
  onReveal?: () => void;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const c = useColors();
  const type = useTypography();
  const format = useDateTime();

  const target = useRef<ComponentRef<typeof View>>(null);
  const revealView = useRevealSettingsView();
  const presence = useWorkerPresence()(worker);

  const status =
    worker.revokedAt || record?.revoked
      ? "Revoked"
      : worker.online && !presence.away
        ? "Connected"
        : presence.away
          ? presence.status
          : "Disconnected";

  const updates = worker.cliTools.filter((tool) => tool.action === "update").length;
  const route = worker.networkRouteStatus;

  const connection =
    worker.online && route && route.route !== "local"
      ? (route.route === "pinned" ? "Over the secure route" : "Over the server port") +
        (route.detail ? ` · secure route unavailable: ${route.detail}` : "")
      : "";

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
      ref={target}
      collapsable={false}
      onLayout={() => {
        if (onReveal) {
          onReveal();
          revealView(target.current);
        }
      }}
      style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, overflow: "hidden", backgroundColor: c.surface }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={worker.name}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => ({
          paddingHorizontal: 16,
          paddingVertical: 10,
          flexDirection: "row",
          gap: 12,
          alignItems: "center",
          backgroundColor: pressed ? c.inset : "transparent",
          opacity: presence.away ? 0.5 : 1,
        })}
      >
        <Icon name="computer-desktop" />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={[type.chrome, weightedFont(type.chrome.fontFamily, "semibold"), { color: c.text }]}>
            {worker.name}
          </Text>
          {!!meta && <Text style={[type.meta, { color: c.muted }]}>{meta}</Text>}
          <Text style={[type.meta, { color: c.text }]}>
            {status}
            {connection && <Text style={{ color: c.muted }}>{` · ${connection}`}</Text>}
            {!!updates && ` · ${updates} ${updates === 1 ? "CLI update" : "CLI updates"}`}
          </Text>
        </View>
        <View style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}>
          <Icon name="chevron-down" />
        </View>
      </Pressable>
      {expanded && children}
    </View>
  );
}

function workerGroups(workers: ui.Worker[], records: ui.WorkerRecord[], computers: ui.LinkedComputer[]) {
  const groups = new Map<string, { id: string; name: string; workers: ui.Worker[] }>();

  const entries = [
    ...workers.filter((w) => !records.some((record) => record.workerId === w.id)),
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
      name:
        records.find((r) => r.workerId === worker.id)?.computerName ||
        computers.find((computer) => computer.nodeId === id)?.displayName ||
        computers.find((computer) => computer.nodeId === id)?.name ||
        "This computer",
      workers: [],
    };

    group.workers.push(worker);
    groups.set(id, group);
  }

  return [...groups.values()].sort((a, b) => Number(!!a.id) - Number(!!b.id) || a.name.localeCompare(b.name));
}
