<script module lang="ts">
  import { canPreviewSkillConflict } from "@canopy/domain/environment-library";
  import { currentReport, useLibraryVersion, type SyncComputer } from "./skill-sync.ts";

  export function conflictImportSources(issues: readonly SyncComputer[], revision: bigint): SyncComputer[] {
    return issues.flatMap(({ worker, files }) => {
      if (!worker.conflictSkillImportSupported || !worker.skillReportId || !currentReport(worker, revision)) return [];
      const copies = files.filter(canPreviewSkillConflict);

      return copies.length ? [{ worker, files: copies }] : [];
    });
  }
</script>

<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui, type SkillArtifact } from "@canopy/contracts";
  import { onDestroy, onMount } from "svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { archiveLocation, skillLocation } from "./computer-skills.ts";
  import type { EnvironmentState } from "./environment-state.svelte.ts";
  import SkillSourceFiles from "./SkillSourceFiles.svelte";

  let {
    environment,
    skill,
    sources,
    revision,
    onback,
    onsubmitted,
  }: {
    environment: EnvironmentState;
    skill: ui.LibrarySkill;
    sources: readonly SyncComputer[];
    revision: bigint;
    onback: () => void;
    onsubmitted: (group: SyncComputer) => void;
  } = $props();

  const choices = $derived(
    sources.flatMap(({ worker, files }) =>
      files.map((file) => ({
        worker,
        file,
        value: `${worker.workerId}/${file.targetId}`,
        label: `${worker.name} · ${skillLocation(file)}`,
        description: files.some((other) => other.targetId !== file.targetId && other.harness === file.harness)
          ? file.path
          : undefined,
      })),
    ),
  );

  let selected = $state("");
  let artifact = $state.raw<SkillArtifact>();
  let savedVersion = $state<bigint>();
  let reading = $state(false);
  let failure = $state("");
  let details = $state("");
  let request: AbortController | undefined;

  const source = $derived(choices.find(({ value }) => value === selected));
  const worker = $derived(environment.snapshot.workers.find((worker) => worker.workerId === source?.worker.workerId));
  const current = $derived(worker?.report?.skills.find((file) => file.targetId === source?.file.targetId));

  const sameCopy = $derived(
    Boolean(
      source &&
      current &&
      canPreviewSkillConflict(current) &&
      current.skillId === skill.id &&
      current.archiveToken === source.file.archiveToken,
    ),
  );

  const beforeSave = $derived(
    !!worker &&
      environment.snapshot.revision === revision &&
      currentReport(worker, revision) &&
      worker.conflictSkillImportSupported &&
      sameCopy &&
      current?.desiredChecksum === source?.file.desiredChecksum,
  );

  const pin = $derived(skill.overrides.find((override) => override.workerId === source?.worker.workerId)?.version);
  const followupRevision = $derived(revision + 1n);

  const fresh = $derived(
    !!worker && currentReport(worker, followupRevision) && environment.snapshot.revision === followupRevision,
  );

  const install = $derived(
    fresh &&
      worker?.skillReportId &&
      sameCopy &&
      current &&
      current.version === (pin || savedVersion) &&
      current.desiredChecksum === (pin ? source?.file.desiredChecksum : artifact?.checksum)
      ? { worker, files: [current] }
      : undefined,
  );

  onMount(() => {
    if (choices.length === 1) void preview(choices[0]!.value);
  });

  onDestroy(() => request?.abort());

  async function preview(value: string) {
    request?.abort();
    const active = new AbortController();
    request = active;
    selected = value;
    artifact = undefined;
    failure = "";
    const choice = choices.find((item) => item.value === value);

    if (!choice) return;
    reading = true;

    try {
      const body = create(ui.PreviewWorkerSkillRequestSchema, {
        workerId: choice.worker.workerId,
        targetId: choice.file.targetId,
        archiveToken: choice.file.archiveToken,
        skillId: skill.id,
        expectedRevision: revision,
      });

      const result = decode(
        ui.PreviewWorkerSkillResponseSchema,
        await requestJson(
          "POST",
          `/api/workers/${encodeURIComponent(choice.worker.workerId)}/environment/skills/preview`,
          encode(ui.PreviewWorkerSkillRequestSchema, body),
          undefined,
          active.signal,
        ),
      );

      if (active.signal.aborted) return;

      if (!result.artifact?.files.length || result.artifact.name !== skill.artifact?.name)
        throw new Error("Check that the name in SKILL.md matches this library skill’s folder name.");
      artifact = result.artifact;
    } catch (error) {
      if (active.signal.aborted) return;
      failure = "Couldn’t read this copy. Check its files or go back to choose another action.";
      details = error instanceof Error ? error.message : "";
    } finally {
      if (request === active) reading = false;
    }
  }

  async function save() {
    if (!artifact || !source || !beforeSave || savedVersion || environment.busy) return;
    failure = "";
    const version = (skill.versions.at(-1) ?? 0n) + 1n;

    const body = create(ui.SaveLibrarySkillRequestSchema, {
      skill: { ...skill, artifact: undefined },
      files: artifact.files,
      expectedRevision: revision,
    });

    if (await environment.mutate("POST", "/skills", encode(ui.SaveLibrarySkillRequestSchema, body))) {
      savedVersion = version;
      environment.notice = `Saved version ${version} of “${skill.name}” in Canopy.`;
    } else {
      failure = "Couldn’t save this version. Go back to review the latest status.";
      details = environment.error;
    }
  }

  async function installCopy() {
    const group = install;

    if (!group || environment.busy) return;
    failure = "";

    if (await useLibraryVersion(environment, skill.id, group, followupRevision)) onsubmitted(group);
    else {
      failure = "Couldn’t confirm installation. Go back to check this location.";
      details = environment.error;
    }
  }
</script>

{#if !savedVersion && choices.length > 1}
  <Field label="Copy to use">
    <Select
      name="conflict-import-source"
      options={choices}
      value={selected}
      onchange={preview}
      placeholder="Choose a local copy"
      disabled={environment.busy}
    />
  </Field>
{/if}

{#if source}
  <div class="grid min-w-0 gap-1">
    {#if choices.length === 1 || savedVersion}<p class="font-medium wrap-anywhere">{source.label}</p>{/if}
    {#if !savedVersion}
      <Disclosure>
        {#snippet summary()}Show local folder{/snippet}
        <p class="pt-2 font-mono text-sm wrap-anywhere text-muted select-text">{source.file.path}</p>
      </Disclosure>
    {/if}
  </div>
{/if}

{#if savedVersion}
  <p role="status">Saved version {savedVersion} of “{skill.name}” in Canopy.</p>
  {#if install && source}
    <p>
      Canopy can now back up this folder and install {pin ? `pinned version ${pin}` : `version ${savedVersion}`} in its place.
      Links to this folder may stop working.
    </p>
    <Disclosure>
      {#snippet summary()}Show folder and backup{/snippet}
      <p class="pt-2">Local folder</p>
      <p class="font-mono text-sm wrap-anywhere select-text">{source.file.path}</p>
      <p class="pt-2">Backup</p>
      <p class="font-mono text-sm wrap-anywhere select-text">{archiveLocation(source.file)}</p>
    </Disclosure>
  {:else if worker?.online && environment.snapshot.revision === followupRevision && worker.report?.revision !== followupRevision}
    <p role="status">
      Waiting for {worker.name} to check the local folder. You can return to sync options at any time.
    </p>
    <div><Button size="sm" onclick={() => environment.refresh()}>Refresh status</Button></div>
  {:else}
    <p>The folder or its sync status changed. Return to sync options to review it.</p>
  {/if}
{:else if reading}
  <p role="status">Reading skill files…</p>
{:else if artifact}
  <SkillSourceFiles {artifact} />
  <p>
    Save these files as the new library version of “{skill.name}”. Assigned computers sync this version unless pinned to
    another version. After saving, you can back up the local folder and install its assigned version.
  </p>
  {#if skill.source}<p>Saving disconnects this skill from its repository and stops repository updates.</p>{/if}
  {#if !beforeSave && !environment.busy}<Alert>The skill or local copy changed. Go back to review it.</Alert>{/if}
{/if}

{#if failure}
  <Alert tone="error">{failure}</Alert>
  {#if details}
    <Disclosure>
      {#snippet summary()}Show details{/snippet}
      <p class="pt-2 wrap-anywhere select-text">{details}</p>
    </Disclosure>
  {/if}
{/if}
<div class="flex flex-wrap justify-end gap-2">
  <Button disabled={environment.busy} onclick={onback}>{savedVersion ? "Return to sync options" : "Back"}</Button>
  {#if savedVersion && install}
    <Button variant="primary" loading={environment.busy} onclick={installCopy}>Back up and install</Button>
  {:else if !savedVersion && artifact}
    <Button variant="primary" disabled={!beforeSave || environment.busy} loading={environment.busy} onclick={save}
      >Save library version</Button
    >
  {/if}
</div>
