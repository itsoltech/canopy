<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui, type EnvironmentSkillStatus, type SkillArtifact } from "@canopy/contracts";
  import { splitId } from "@canopy/domain/computers";
  import { onDestroy, untrack } from "svelte";
  import { HttpError, requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { canImportLocalSkill, skillLocation } from "./computer-skills.ts";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import SkillDestinations from "./SkillDestinations.svelte";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";
  import { SkillsState } from "./skills-state.svelte.ts";

  let { environment, onsaved }: { environment: EnvironmentState; onsaved: () => void } = $props();

  type Source = { workerId: string; workerName: string; file: EnvironmentSkillStatus; revision: bigint };

  type Failure = { action: string; detail?: string };

  class CopyUnavailable extends Error {}

  const skills = new SkillsState(untrack(() => environment));
  let source = $state.raw<Source>();
  let installed = $state.raw<{ workerName: string; path: string }>();
  let artifact = $state.raw<SkillArtifact>();
  let open = $state(false);
  let step = $state(0);
  let pending = $state(false);
  let failure = $state.raw<Failure>();
  let saveError = $state("");
  let request: AbortController | undefined;

  onDestroy(() => request?.abort());

  export function show(chosen: Source) {
    close();
    source = chosen;
    step = 0;
    open = true;
    void preview(chosen);
  }

  export function showInstalled(artifact: SkillArtifact, worker: ui.EnvironmentWorker, path: string) {
    close();
    installed = { workerName: worker.name || worker.workerId, path };
    stage(artifact, worker.workerId);
    step = 0;
    open = true;
  }

  function close() {
    open = false;
    request?.abort();
    request = undefined;
    pending = false;
    artifact = undefined;
    source = undefined;
    installed = undefined;
    skills.draft = undefined;
    skills.files = [];
    failure = undefined;
    saveError = "";
  }

  function stage(preview: SkillArtifact, workerId: string) {
    const draft = skills.edit();
    draft.name = preview.name;
    draft.selector = create(ui.EnvironmentSelectorSchema, { workerIds: [splitId(workerId).id] });
    skills.files = preview.files;
    artifact = preview;
  }

  async function refresh(chosen: Source, path: string, signal: AbortSignal): Promise<Source> {
    const report = decode(
      ui.WorkerEnvironmentResponseSchema,
      await requestJson("GET", path, undefined, undefined, signal),
    );

    const worker = report.worker;

    if (!worker?.online) throw new CopyUnavailable("Reconnect this computer, then retry.");

    if (!worker.localSkillImportSupported) throw new CopyUnavailable("Update Canopy on this computer, then retry.");

    if (worker.compositionError || !worker.report || worker.report.revision !== report.revision)
      throw new CopyUnavailable("Close this sheet and check the computer’s skill report.");

    const copy = worker.report.skills.find(
      (file) => file.targetId === chosen.file.targetId && file.path === chosen.file.path,
    );

    if (!copy || !canImportLocalSkill(copy))
      throw new CopyUnavailable(
        "This copy is no longer available. Close this sheet and refresh the computer’s status.",
      );

    return { ...chosen, file: copy, revision: report.revision };
  }

  async function preview(chosen: Source, retry = false) {
    request?.abort();
    const active = new AbortController();
    request = active;
    pending = true;
    failure = undefined;
    const path = `/api/workers/${encodeURIComponent(chosen.workerId)}/environment`;

    try {
      const current = retry ? await refresh(chosen, path, active.signal) : chosen;

      const body = create(ui.PreviewWorkerSkillRequestSchema, {
        workerId: current.workerId,
        targetId: current.file.targetId,
        archiveToken: current.file.archiveToken,
        expectedRevision: current.revision,
      });

      const result = decode(
        ui.PreviewWorkerSkillResponseSchema,
        await requestJson(
          "POST",
          `${path}/skills/preview`,
          encode(ui.PreviewWorkerSkillRequestSchema, body),
          undefined,
          active.signal,
        ),
      );

      if (active.signal.aborted) return;

      if (!result.artifact?.files.length) throw new CopyUnavailable("Retry to read the files from this computer.");

      stage(result.artifact, chosen.workerId);
    } catch (cause) {
      if (!active.signal.aborted) failure = previewFailure(cause);
    } finally {
      if (request === active) pending = false;
    }
  }

  function previewFailure(cause: unknown): Failure {
    if (cause instanceof CopyUnavailable) return { action: cause.message };

    if (cause instanceof HttpError) {
      let action = "Check that this computer is connected, then retry.";

      if (cause.status === 426) action = "Update Canopy on the computer that provides this skill, then retry.";
      else if (cause.status === 400) action = "Check the skill files in this directory, then retry.";
      else if (cause.status === 409 || cause.status === 404)
        action = "Retry to check the current copy on this computer.";

      return { action, detail: cause.message };
    }

    return {
      action: "Check that this computer is connected, then retry.",
      ...(cause instanceof Error && { detail: cause.message }),
    };
  }

  async function save() {
    if (!artifact || !skills.draft || environment.busy) return;
    saveError = "";
    // This creates a new skill. Reuse the reviewed files if the library changes during assignment.
    await skills.save(() => {
      close();
      onsaved();
    }, environment.snapshot.revision);

    if (open) saveError = environment.error || "Could not save the skill.";
  }
</script>

<EnvironmentSheet
  bind:open={
    () => open,
    (value) => {
      if (!value) close();
    }
  }
  title="Add skill to library"
  steps={["Review files", "Assign & confirm"]}
  bind:step
  busy={environment.busy}
  nextDisabled={!artifact}
  submitDisabled={!artifact}
  onsave={save}
>
  {#snippet children(current)}
    {#if source}
      <div class="grid min-w-0 gap-1">
        <p class="font-medium wrap-anywhere">{skillLocation(source.file)} on {source.workerName}</p>
        <p class="font-mono text-sm wrap-anywhere text-muted select-text">{source.file.path}</p>
      </div>
    {:else if installed}
      <div class="grid min-w-0 gap-1">
        <p class="font-medium wrap-anywhere">Installed on {installed.workerName}</p>
        <p class="font-mono text-sm wrap-anywhere text-muted select-text">{installed.path}</p>
      </div>
    {/if}
    {#if pending}
      <p class="text-sm text-muted" role="status">Reading skill files…</p>
    {:else if failure}
      <Alert tone="error" title="Could not read this skill">{failure.action}</Alert>
      {#if failure.detail}{@render details(failure.detail)}{/if}
      <div><Button size="sm" onclick={() => source && preview(source, true)}>Retry preview</Button></div>
    {:else if artifact && skills.draft}
      {#if current === 0}
        <Field label="Library name">
          <Input name="local-skill-name" bind:value={skills.draft.name} required maxlength={120} />
        </Field>
        <SkillSourceFiles {artifact} />
      {:else}
        <SkillDestinations bind:skill={skills.draft} workers={environment.workers} />
        <p class="text-base text-pretty text-muted sm:text-sm">
          Add and sync approves these files for the selected computers.
        </p>
        {#if saveError}
          <Alert tone="error" title="Could not save this skill">Check the assignment, then try again.</Alert>
          {@render details(saveError)}
        {/if}
      {/if}
    {/if}
  {/snippet}
</EnvironmentSheet>

{#snippet details(detail: string)}
  <Disclosure>
    {#snippet summary()}<span class="text-sm text-muted">Show details</span>{/snippet}
    <div class="flex min-w-0 items-start gap-2 pt-2">
      <p class="min-w-0 flex-1 text-sm wrap-anywhere select-text">{detail}</p>
      <CopyButton text={detail} label="Copy details" />
    </div>
  </Disclosure>
{/snippet}
