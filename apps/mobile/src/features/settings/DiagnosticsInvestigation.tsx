import { useRef, useState } from "react";
import { Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { investigationChoices } from "@canopy/domain/diagnostics";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { useModelCatalog } from "../models/catalog";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsInvestigation({ report }: { report: ui.DiagnosticsReport }) {
  const { projects, workers } = useOverview();
  const { client } = useSession();
  const c = useColors();
  const [projectId, setProject] = useState("");
  const [workspaceId, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const requestId = useRef(Crypto.randomUUID());
  const own = projects.filter((project) => !project.nodeId && !project.archivedAt);
  const project = own.find((project) => project.id === projectId);
  const workspaces = project?.workspaces ?? [];
  const workspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const worker = workers.find((worker) => !worker.nodeId && worker.id === workspace?.workerId);
  const choices = investigationChoices(worker, useModelCatalog(worker?.id));
  const selected = choices.find((choice) => choice.value === model);

  async function investigate() {
    if (!client || !workspace || !selected || !worker?.online || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");

    try {
      const result = await client.api.investigateDiagnostics({
        report,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        workerId: worker.id,
        provider: selected.provider,
        providerProfileId: selected.profileId,
        model: selected.model,
        clientRequestId: requestId.current,
      });

      router.push({ pathname: "/thread/[id]", params: { id: result.threadId } });
    } catch {
      setError("Could not create the investigation. Check the placement and retry.");
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <SettingsGroup title="Ask an agent to investigate">
        <SettingChoice
          title="Project"
          value={projectId}
          options={own.map((project) => ({ value: project.id, label: project.name }))}
          onChange={(value) => {
            setProject(value);
            setWorkspace("");
            setModel("");
          }}
        />
        <SettingChoice
          title="Workspace"
          value={workspaceId}
          options={workspaces.map((workspace) => ({
            value: workspace.id,
            label: `${workers.find((worker) => worker.id === workspace.workerId)?.name || "Worker"} · ${workspace.rootPath}`,
          }))}
          onChange={(value) => {
            setWorkspace(value);
            setModel("");
          }}
        />
        <SettingChoice title="Agent and model" value={model} options={choices} onChange={setModel} />
      </SettingsGroup>
      <Text style={[styles.workMeta, { color: c.muted }]}>
        Creates a thread on this computer using {worker?.name || "the selected worker"}. The report may be sent to the
        selected provider. Normal approvals apply.
      </Text>
      {worker && !worker.online ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>This worker is offline. Choose a connected worker.</Text>
      ) : null}
      {error ? <Notice error>{error}</Notice> : null}
      <Button
        title="Create investigation"
        variant="primary"
        busy={busy}
        disabled={!workspace || !selected || !worker?.online}
        onPress={() => void investigate()}
      />
    </View>
  );
}
