<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui, type EnvironmentSkillStatus } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import { revalidateEvery, sharedRead } from "#lib/shared/queries.svelte.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { awaitingArchive } from "./computer-skills.ts";
  import ComputerSkills from "./ComputerSkills.svelte";
  import InstructionPreview from "./InstructionPreview.svelte";

  let {
    workerId,
    readOnly,
    preview = true,
    class: className,
  }: { workerId: string; readOnly: string; preview?: boolean; class?: ClassValue } = $props();

  const path = $derived(`/api/workers/${workerId}/environment`);
  const read = $derived(sharedRead(`GetWorkerEnvironment:${workerId}`, ui.WorkerEnvironmentResponseSchema, path));
  const query = $derived(readOnly ? undefined : read.snapshot);
  const response = $derived(query?.data);

  const library = $derived(
    response?.items
      .filter((entry) => entry.kind === "skill")
      .map(({ localId: id, name, artifactName }) => ({ id, name, artifactName })),
  );

  let error = $state("");
  let notice = $state("");
  let saving = $state(false);
  let requested = $state.raw<EnvironmentSkillStatus>();

  const reportedCopy = $derived(
    requested && response?.worker?.report?.skills.find((f) => f.targetId === requested?.targetId),
  );

  const waitingForArchive = $derived(!!requested && !!reportedCopy && awaitingArchive(reportedCopy, requested));

  const busy = $derived(saving || !!query?.loading);
  let selected = $state("");
  let disabled = $state(false);
  let content = $state("");
  let versionHash = $state("");
  const item = $derived(response?.items.find((i) => `${i.kind}:${i.item}` === selected));
  const override = $derived(response?.overrides.find((o) => o.kind === item?.kind && o.item === item.item));

  $effect(() => {
    if (!readOnly) void read.reload().catch(() => {});
  });

  $effect(() => {
    const worker = response?.worker;

    if (
      worker?.online &&
      worker.supported &&
      (worker.report?.revision !== worker.desiredRevision || waitingForArchive) &&
      !worker.compositionError
    )
      return revalidateEvery(read.key, 3000);
  });

  const savedDisabled = $derived(override?.disabled ?? false);
  const savedContent = $derived(override?.content ?? "");
  const savedVersion = $derived(override?.versionHash ?? "");

  $effect(() => {
    void selected;
    disabled = savedDisabled;
    content = savedContent;
    versionHash = savedVersion;
  });

  async function refresh() {
    error = "";
    notice = "";
    await read.reload().catch(() => {});
  }

  async function archive(file: EnvironmentSkillStatus) {
    const worker = response?.worker;

    if (
      busy ||
      readOnly ||
      query?.stale ||
      query?.error ||
      !worker?.online ||
      !worker.skillsSupported ||
      !worker.report ||
      worker.report.revision !== response?.revision ||
      !file.archiveToken ||
      !worker.report.skills.some(
        (entry) => entry.targetId === file.targetId && entry.archiveToken === file.archiveToken,
      )
    )
      return false;

    const current = read;
    saving = true;
    error = "";
    notice = "";
    requested = undefined;

    try {
      const result = await requestJson(
        "POST",
        `${path}/skills/archive`,
        encode(
          ui.ArchiveWorkerSkillRequestSchema,
          create(ui.ArchiveWorkerSkillRequestSchema, {
            workerId,
            targetId: file.targetId,
            archiveToken: file.archiveToken,
            expectedRevision: worker.report.revision,
          }),
        ),
      );

      current.set(decode(ui.WorkerEnvironmentResponseSchema, result));
      requested = file;

      return true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not archive this copy. Refresh and try again.";

      return false;
    } finally {
      if (current === read && !readOnly) await current.reload().catch(() => {});
      saving = false;
    }
  }

  async function save(remove: boolean) {
    if (!item || !response || busy || readOnly) return;
    const id = workerId;
    saving = true;
    error = "";
    notice = "";

    try {
      const saved = decode(
        ui.WorkerEnvironmentResponseSchema,
        await requestJson(
          "PUT",
          `/api/workers/${id}/environment`,
          encode(
            ui.SetWorkerEnvironmentOverrideRequestSchema,
            create(ui.SetWorkerEnvironmentOverrideRequestSchema, {
              workerId: id,
              expectedRevision: response.revision,
              remove,
              override: { kind: item.kind, item: item.item, disabled, content, versionHash },
            }),
          ),
        ),
      );

      if (id === workerId) {
        read.set(saved);
        notice = remove ? "Override removed on this computer." : "Override saved on this computer.";
      }
    } catch (cause) {
      if (id === workerId)
        error = cause instanceof Error ? cause.message : "Could not save the override. Refresh and try again.";
    } finally {
      if (id === workerId) saving = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-4", className]} aria-busy={busy}>
  <div class="flex flex-wrap items-center gap-2">
    {#if response?.worker}<Badge tone={response.worker.online ? "emerald" : "neutral"}
        >{response.worker.online ? "Online" : "Offline"}</Badge
      >{/if}
    <Button size="sm" variant="ghost" disabled={busy || !!readOnly} onclick={refresh}>Refresh status</Button>
  </div>
  {#if readOnly}<Alert>{readOnly}</Alert>{/if}
  {#if error || query?.error}<Alert tone="error">{error || query?.error}</Alert>{/if}
  {#if notice}<Alert>{notice}</Alert>{/if}
  {#if response?.worker}
    {@const worker = response.worker}
    {#if worker.compositionError}<Alert tone="error">{worker.compositionError}</Alert>
    {:else if !worker.supported}<Alert tone="warning">Update this worker to sync its agent environment.</Alert>{/if}
    {#if preview}
      <ComputerSkills {worker} {library} busy={busy || !!query?.stale || !!query?.error} onarchive={archive} />
      <div class="grid min-w-0 divide-y divide-divider border-y border-divider">
        <Disclosure class="py-3">
          {#snippet summary()}<span class="font-medium">Instruction files and preview</span>{/snippet}
          <div class="grid min-w-0 gap-4 pt-3">
            {@render files(worker.report?.files ?? [])}
            <InstructionPreview {worker} />
          </div>
        </Disclosure>
        <Disclosure class="py-3">
          {#snippet summary()}<span class="font-medium">Plugins</span>{/snippet}
          <div class="grid min-w-0 gap-3 pt-3">{@render files(worker.report?.plugins ?? [])}</div>
        </Disclosure>
        <Disclosure class="py-3">
          {#snippet summary()}<span class="font-medium">Computer tags</span>{/snippet}
          <div class="flex flex-wrap gap-2 pt-3">
            {#each worker.automaticTags as tag (tag)}<Badge class="max-w-full break-all whitespace-normal">{tag}</Badge
              >{/each}
            {#each worker.manualTags as tag (tag)}<Badge tone="sky" class="max-w-full break-all whitespace-normal"
                >{tag}</Badge
              >{/each}
          </div>
        </Disclosure>
        <Disclosure class="py-3">
          {#snippet summary()}<span class="font-medium">Machine overrides</span>{/snippet}
          <div class="grid min-w-0 gap-3 pt-3">{@render overrides(response.items)}</div>
        </Disclosure>
      </div>
    {:else}
      {@render overrides(response.items)}
    {/if}
  {/if}
</div>

{#snippet files(entries: readonly { path: string; status: string; detail: string }[])}
  {#each entries as file}
    <div class="flex min-w-0 flex-wrap items-start gap-2 text-sm">
      <span class="min-w-0 flex-1 font-mono break-all">{file.path}</span><Badge>{file.status}</Badge>
      {#if file.status === "error" && file.detail}<p class="w-full break-words">{file.detail}</p>{/if}
    </div>
  {:else}
    <p class="text-sm text-zinc-500 dark:text-zinc-400">No files reported.</p>
  {/each}
{/snippet}

{#snippet overrides(items: readonly ui.WorkerEnvironmentItem[])}
  <p class="text-sm text-zinc-500 dark:text-zinc-400">
    Changes save directly on this computer and apply to its saved library.
  </p>
  <fieldset class="grid min-w-0 gap-4" disabled={busy || !!readOnly}>
    <Field label="Library item" class="min-w-0"
      ><Select
        class="min-w-0"
        name="remote-environment-item"
        bind:value={selected}
        options={items.map((i) => ({
          value: `${i.kind}:${i.item}`,
          label: i.name,
          group: i.kind === "instruction" ? "Instructions" : i.kind === "skill" ? "Skills" : "Plugins",
        }))}
      /></Field
    >
    {#if item}
      <Checkbox name="remote-environment-disabled" label="Disable on this computer" bind:checked={disabled} />
      {#if item.kind === "instruction" && !disabled}<Field
          label="Extra instructions"
          description="Appended after this document's matching fragments."
          ><Textarea name="remote-environment-content" bind:value={content} rows={4} /></Field
        >{/if}
      {#if item.kind === "skill"}<Field label="Version on this computer"
          ><Select
            name="remote-environment-version"
            bind:value={versionHash}
            options={[
              { value: "", label: "Follow library version" },
              ...item.versions.map((v) => ({ value: v.hash, label: `Version ${v.version}` })),
            ]}
          /></Field
        >{/if}
      <div class="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} onclick={() => save(false)}>Save override</Button>
        <Button disabled={!override} onclick={() => save(true)}>Remove override</Button>
      </div>
    {/if}
  </fieldset>
{/snippet}
