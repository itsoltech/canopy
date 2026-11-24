import { create } from "@bufbuild/protobuf";
import { AgentTool, ui } from "@canopy/contracts";
import { agentTools, workerTool, type ToolWorker } from "@canopy/domain/agent-tool-settings";
import { Pressable, Text, View } from "react-native";
import { useOverview } from "../../state/overview";
import { useLayout } from "../../state/layout";
import { useAppearance } from "../../state/appearance";
import { Button, Notice } from "../../ui/components";
import { Chevron, Expand } from "../../ui/MotionViews";
import { Switch } from "../../ui/Switch";
import { useColors, useTypography, weightedFont } from "../../ui/theme";
import { useWorkerPresence } from "../computers/presence";
import { AgentToolDefaults } from "./AgentToolDefaults";
import { AgentToolWorkerRow } from "./AgentToolWorkerRow";
import { useOpenSettingsSection } from "./navigation";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsGroup, SettingsGroupHeader, SettingsRow } from "./SettingsGroup";
import { createSettingsViewState } from "./SettingsScroll";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { useAgentToolAction } from "./use-agent-tool-action";

const useExpandedTools = createSettingsViewState<AgentTool[]>([]);

function useToolWorkers() {
  const overview = useOverview();
  const presence = useWorkerPresence();
  const records = useSettingsResource("ListWorkerRecords", (api) => api.listWorkerRecords({}));
  const live = new Map(overview.workers.map((worker) => [worker.id, worker]));
  const entries = new Map<string, ToolWorker>();

  for (const worker of live.values()) {
    const home = presence(worker);
    entries.set(worker.id, {
      worker,
      computer: worker.nodeId ? home.computer : worker.hostname || home.computer,
      readOnly: worker.nodeId ? home.reason || "Manage this worker on its home computer." : "",
    });
  }

  for (const record of records.data?.records ?? []) {
    const worker =
      live.get(record.workerId) ??
      create(ui.WorkerSchema, {
        id: record.workerId,
        nodeId: record.nodeId,
        name: record.name,
        os: record.os,
        hostname: record.hostname,
      });

    const home = presence(worker);
    entries.set(worker.id, {
      worker,
      computer: record.computerName || home.computer,
      readOnly: record.readOnlyReason || home.reason || "",
    });
  }

  return { workers: [...entries.values()], records, loaded: overview.loaded };
}

export function AgentToolsSettings() {
  const openSettingsSection = useOpenSettingsSection();
  const { workers, records, loaded } = useToolWorkers();
  const [expanded, setExpanded] = useExpandedTools();
  const check = useAgentToolAction();
  const { threadsEnabled } = useAppearance();
  const c = useColors();
  const type = useTypography();
  const eligible = workers.filter(({ worker, readOnly }) => worker.online && !readOnly);

  return (
    <ResourceState resource={records}>
      <SettingsGroupHeader
        title="Agent tools"
        description="Give agents access to browsers, desktop apps and devices on your workers."
        actions={
          <Button
            title="Check tools"
            icon="arrow-path"
            busy={check.pending}
            disabled={!eligible.length}
            onPress={() =>
              void check.run(
                eligible,
                async (api, workerId, signal) =>
                  !(await api.refreshAgentTools({ workerId }, { signal })).skipped.length,
                "Could not check tools. Connect these workers and retry:",
                eligible.length === workers.length
                  ? "Tool check complete."
                  : "Available workers checked. Connect the remaining workers to check their tools.",
              )
            }
          />
        }
      />
      <View style={{ gap: 12 }}>
        {records.initialLoading && !workers.length ? (
          <SettingsGroup>
            <SettingsSkeletonRows />
          </SettingsGroup>
        ) : null}
        {loaded && !records.initialLoading && !workers.length && (
          <SettingsGroup>
            <SettingsRow
              title="No workers yet"
              control={<Button title="Add worker" onPress={() => openSettingsSection("workers")} />}
            />
          </SettingsGroup>
        )}
        {workers.length > 0 &&
          agentTools.map((tool) => (
            <SettingsGroup key={tool.tool}>
              <ToolCard
                {...tool}
                workers={workers}
                open={expanded.includes(tool.tool)}
                onToggle={() =>
                  setExpanded((previous) =>
                    previous.includes(tool.tool) ? previous.filter((id) => id !== tool.tool) : [...previous, tool.tool],
                  )
                }
              />
            </SettingsGroup>
          ))}
      </View>
      {workers.length > 0 && (
        <Text style={[type.meta, { color: c.muted }]}>
          Enabling a tool installs it if needed.
          {threadsEnabled ? " Open Preview in a thread to see and control its screen." : ""}
        </Text>
      )}
      {check.notice ? <Notice error={check.failed}>{check.notice}</Notice> : null}
    </ResourceState>
  );
}

function ToolCard({
  tool,
  name,
  description,
  workers,
  open,
  onToggle,
}: (typeof agentTools)[number] & { workers: ToolWorker[]; open: boolean; onToggle: () => void }) {
  const { wide } = useLayout();
  const c = useColors();
  const type = useTypography();
  const action = useAgentToolAction();
  const items = workers.map(({ worker }) => workerTool(worker, tool));
  const enabled = items.filter((item) => item?.enabled).length;
  const installing = items.filter((item) => item?.tool?.install?.state === "running").length;
  const failed = items.filter((item) => !item?.tool?.ready && item?.tool?.install?.state === "failed").length;

  const summary = [
    `${enabled} of ${workers.length} enabled`,
    installing && `${installing} installing`,
    failed && `${failed} need attention`,
  ]
    .filter(Boolean)
    .join(" · ");

  const all = enabled === workers.length;

  const editable = workers.filter(
    ({ worker, readOnly }) => !readOnly && workerTool(worker, tool) && (worker.online || all),
  );

  const targets = editable.filter(({ worker }) => workerTool(worker, tool)?.enabled === all);

  function enable(entries: ToolWorker[], enabled: boolean) {
    void action.run(
      entries,
      async (api, workerId, signal) => {
        await api.setAgentToolEnabled({ workerId, tool, enabled }, { signal });

        return true;
      },
      "Could not save access. Check these workers and retry:",
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          style={({ pressed }) => ({
            minHeight: 48,
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View style={{ flex: 1 }}>
            <Text style={[type.chrome, weightedFont(type.chrome.fontFamily, "semibold"), { color: c.text }]}>
              {name}
            </Text>
            {wide && <Text style={[type.meta, { color: c.muted }]}>{description}</Text>}
            <Text style={[type.meta, { color: c.muted }]}>{summary}</Text>
          </View>
          <Chevron open={open} />
        </Pressable>
        <Switch
          label={`Use ${name} on all workers`}
          value={all}
          mixed={enabled > 0 && !all}
          disabled={action.pending || !targets.length}
          onChange={(value) => enable(targets, value)}
        />
      </View>
      <Expand open={open} style={{ gap: 16 }}>
        {workers.map((entry) => (
          <AgentToolWorkerRow
            key={entry.worker.id}
            entry={entry}
            tool={tool}
            name={name}
            busy={action.pending}
            onEnable={(value) => enable([entry], value)}
            onInstall={() =>
              void action.run(
                [entry],
                async (api, workerId, signal) => {
                  await api.installAgentTool(
                    { workerId, tool, installRuntime: tool === AgentTool.BROWSER },
                    { signal },
                  );

                  return true;
                },
                "Could not start the install. Check this worker and retry:",
              )
            }
          />
        ))}
        <AgentToolDefaults tool={tool} />
      </Expand>
      {action.notice ? <Notice error={action.failed}>{action.notice}</Notice> : null}
    </View>
  );
}
