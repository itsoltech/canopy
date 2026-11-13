<script lang="ts">
  import { create, toJson } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { investigationChoices } from "@canopy/domain/diagnostics";
  import { goto } from "$app/navigation";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";

  let { report, logsJobId = "" }: { report: ui.DiagnosticsReport; logsJobId?: string } = $props();
  let attachLogs = $state(false);
  const overview = useOverview();
  const catalog = useModelCatalog();
  let projectId = $state("");
  let workspaceId = $state("");
  let model = $state("");
  let busy = $state(false);
  let error = $state("");
  const requestId = crypto.randomUUID();
  const projects = $derived(overview.ownProjects.filter((project) => !project.archivedAt));
  const project = $derived(projects.find((project) => project.id === projectId));
  const workspaces = $derived(project?.workspaces ?? []);
  const workspace = $derived(workspaces.find((workspace) => workspace.id === workspaceId));
  const worker = $derived(overview.ownWorkers.find((worker) => worker.id === workspace?.workerId));
  const choices = $derived(investigationChoices(worker, catalog.of(worker?.id ?? "")?.profiles ?? []));
  const selected = $derived(choices.find((choice) => choice.value === model));

  async function investigate() {
    if (busy || !workspace || !selected || !worker?.online) return;
    busy = true;
    error = "";

    try {
      const value = decode(
        ui.DiagnosticsInvestigationSchema,
        await requestJson(
          "POST",
          "/api/diagnostics/investigate",
          toJson(
            ui.InvestigateDiagnosticsRequestSchema,
            create(ui.InvestigateDiagnosticsRequestSchema, {
              report,
              projectId: workspace.projectId,
              workspaceId: workspace.id,
              workerId: worker.id,
              provider: selected.provider,
              providerProfileId: selected.profileId,
              model: selected.model,
              clientRequestId: requestId,
              logsJobId: attachLogs ? logsJobId : "",
            }),
          ),
        ),
      );

      await goto(`/threads/${value.threadId}`);
    } catch {
      error = "Could not create the investigation. Check the placement and retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-3">
  <h3 class="font-medium">Ask an agent to investigate</h3>
  <Field label="Project"
    ><Select
      value={projectId}
      options={projects.map((project) => ({ value: project.id, label: project.name }))}
      onchange={(value) => {
        projectId = value;
        workspaceId = "";
        model = "";
      }}
      placeholder="Choose a project"
    /></Field
  >
  <Field label="Workspace"
    ><Select
      value={workspaceId}
      options={workspaces.map((workspace) => ({
        value: workspace.id,
        label: `${overview.worker(workspace.workerId)?.name || "Worker"} · ${workspace.rootPath}`,
      }))}
      onchange={(value) => {
        workspaceId = value;
        model = "";
      }}
      placeholder="Choose a workspace"
    /></Field
  >
  <Field label="Agent and model"
    ><Select
      value={model}
      options={choices}
      onchange={(value) => (model = value)}
      placeholder="Choose an agent"
    /></Field
  >
  <p class="text-sm text-muted">
    Creates a thread on this computer using {worker?.name || "the selected worker"}. The report may be sent to the
    selected provider. Normal approvals apply.
  </p>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if logsJobId}<Checkbox
      name="investigate-logs"
      label="Attach logs"
      description="Adds the collected ZIP to this thread. The normal file limit applies."
      bind:checked={attachLogs}
    />{/if}
  {#if worker && !worker.online}<p class="text-sm text-muted">
      This worker is offline. Choose a connected worker.
    </p>{/if}
  <div>
    <Button variant="primary" loading={busy} disabled={!workspace || !selected || !worker?.online} onclick={investigate}
      >Create investigation</Button
    >
  </div>
</div>
