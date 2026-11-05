<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import InstructionPreview from "./InstructionPreview.svelte";

  let {
    workerId,
    readOnly,
    preview = true,
    class: className,
  }: { workerId: string; readOnly: string; preview?: boolean; class?: ClassValue } = $props();

  let response = $state.raw<ui.WorkerEnvironmentResponse>();
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let selected = $state("");
  let disabled = $state(false);
  let content = $state("");
  let versionHash = $state("");
  let refresh = $state(0);
  const item = $derived(response?.items.find((i) => `${i.kind}:${i.item}` === selected));
  const override = $derived(response?.overrides.find((o) => o.kind === item?.kind && o.item === item.item));

  $effect(() => {
    void refresh;
    const id = workerId;
    const reason = readOnly;
    let active = true;
    response = undefined;
    error = "";
    notice = "";

    if (!reason) {
      busy = true;
      void requestJson("GET", `/api/workers/${id}/environment`)
        .then((result) => {
          if (active) response = decode(ui.WorkerEnvironmentResponseSchema, result);
        })
        .catch((cause: Error) => {
          if (active) error = cause.message;
        })
        .finally(() => {
          if (active) busy = false;
        });
    } else busy = false;

    return () => {
      active = false;
    };
  });

  $effect(() => {
    disabled = override?.disabled ?? false;
    content = override?.content ?? "";
    versionHash = override?.versionHash ?? "";
  });

  async function save(remove: boolean) {
    if (!item || !response || busy || readOnly) return;
    const id = workerId;
    busy = true;
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
        response = saved;
        notice = remove ? "Override removed on this computer." : "Override saved on this computer.";
      }
    } catch (cause) {
      if (id === workerId)
        error = cause instanceof Error ? cause.message : "Could not save the override. Refresh and try again.";
    } finally {
      if (id === workerId) busy = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-4", className]} aria-busy={busy}>
  <div><Button size="sm" disabled={busy || !!readOnly} onclick={() => refresh++}>Refresh status</Button></div>
  {#if readOnly}<Alert>{readOnly}</Alert>{/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if notice}<Alert>{notice}</Alert>{/if}
  {#if response?.worker}
    {#if !response.worker.supported}<Alert tone="warning">Update this worker to sync its agent environment.</Alert>{/if}
    <div class="flex flex-wrap gap-1.5">
      <Badge>{response.worker.online ? "Online" : "Offline"}</Badge>
      {#each [...response.worker.automaticTags, ...response.worker.manualTags] as tag (tag)}<Badge
          class="max-w-full break-all whitespace-normal">{tag}</Badge
        >{/each}
    </div>
    {#if preview}<InstructionPreview worker={response.worker} />{/if}
    <h3 class="text-base font-semibold">Machine overrides</h3>
    <p class="text-sm text-zinc-500 dark:text-zinc-400">
      Changes save directly on this computer and apply to its saved library.
    </p>
    <fieldset class="grid min-w-0 gap-4" disabled={busy || !!readOnly}>
      <Field label="Library item" class="min-w-0"
        ><Select
          class="min-w-0"
          name="remote-environment-item"
          bind:value={selected}
          options={response.items.map((i) => ({
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
    {#if preview}
      <section class="grid min-w-0 gap-3" aria-label="Files on this computer">
        <h3 class="text-base font-semibold">Files on this computer</h3>
        {#each [...(response.worker.report?.files ?? []), ...(response.worker.report?.skills ?? []), ...(response.worker.report?.plugins ?? [])] as file}
          <div class="flex min-w-0 flex-wrap items-start gap-2 text-sm">
            <span class="min-w-0 flex-1 font-mono break-all">{file.path}</span><Badge>{file.status}</Badge>
          </div>
        {:else}<p class="text-sm text-zinc-500 dark:text-zinc-400">
            Assigned files appear here after the worker's first sync.
          </p>{/each}
      </section>
    {/if}
  {/if}
</div>
