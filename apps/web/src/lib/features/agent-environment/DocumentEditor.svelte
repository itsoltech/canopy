<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import AssignmentEditor from "./AssignmentEditor.svelte";
  import FragmentEditor from "./FragmentEditor.svelte";
  import MachineOverrides from "./MachineOverrides.svelte";
  import EnvironmentSheet from "./EnvironmentSheet.svelte";
  import InstructionPreview from "./InstructionPreview.svelte";
  import InstructionText from "./InstructionText.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { revealEnvironmentItem } from "./environment-feedback.ts";

  let {
    document = $bindable(),
    workers,
    busy,
    conflict,
    onsave,
    oncancel,
    error = "",
    onreload,
    class: className,
  }: {
    document: ui.InstructionDocument | undefined;
    workers: readonly ui.EnvironmentWorker[];
    busy: boolean;
    conflict: boolean;
    onsave: () => void;
    oncancel: () => void;
    error?: string;
    onreload: () => void;
    class?: ClassValue;
  } = $props();

  let step = $state(0);
  let workerId = $state("");
  let newFragment = $state("");
  const worker = $derived(workers.find((w) => w.workerId === workerId) ?? workers[0]);

  $effect(() => {
    if (!document) step = 0;
  });

  function move(index: number, direction: number) {
    if (!document) return;
    const fragments = [...document.fragments];
    const fragment = fragments.splice(index, 1)[0];

    if (!fragment) return;
    fragments.splice(index + direction, 0, fragment);
    document.fragments = fragments;
  }
</script>

<EnvironmentSheet
  bind:open={
    () => Boolean(document),
    (value) => {
      if (!value) oncancel();
    }
  }
  title={document?.id ? "Edit instruction document" : "Add instruction document"}
  steps={["Write instructions", "Assign computers", "Preview & confirm"]}
  bind:step
  {busy}
  {error}
  {onsave}
  submitLabel={document?.id ? "Save and sync" : "Add and sync"}
  submitDisabled={conflict}
  class={className}
>
  {#snippet children(current)}
    {#if document}
      {#if conflict}<Alert tone="warning"
          >The environment changed while you were editing. Copy any unsaved text before reloading.</Alert
        >
        <div><Button onclick={onreload}>Discard draft and reload</Button></div>{/if}
      {#if current === 0}
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label="Document name"
            ><Input
              name="document-name"
              bind:value={document.name}
              required
              maxlength={120}
              placeholder="For example, My working style"
            /></Field
          >
          <Field label="Agent file"
            ><Select
              name="document-harness"
              bind:value={document.harness}
              options={[
                { value: "claude", label: "Claude · CLAUDE.md" },
                { value: "codex", label: "Codex · AGENTS.md" },
              ]}
            /></Field
          >
        </div>
        <div class="grid gap-6 divide-y divide-zinc-950/10 dark:divide-white/10">
          {#each document.fragments as fragment, i (fragment.id)}
            <FragmentEditor
              bind:fragment={document.fragments[i]}
              {workers}
              parentSelector={document.selector}
              disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
              index={i}
              count={document.fragments.length}
              autofocus={fragment.id === newFragment}
              class={i > 0 ? "pt-6" : ""}
              onmove={(direction) => move(i, direction)}
              onremove={() => {
                if (document) document.fragments = document.fragments.filter((f) => f.id !== fragment.id);
              }}
            />
          {/each}
        </div>
        <div>
          <Button
            size="sm"
            disabled={document.fragments.length >= 64}
            onclick={() => {
              if (!document) return;
              newFragment = crypto.randomUUID();
              document.fragments = [
                ...document.fragments,
                create(ui.InstructionFragmentSchema, { id: newFragment, name: "", content: "" }),
              ];
              void revealEnvironmentItem(newFragment);
            }}>Add fragment</Button
          >
        </div>
      {:else if current === 1}
        <div class="grid gap-3">
          <Checkbox
            name="platform-home"
            label="Canopy agent sessions"
            description="Includes every isolated home used by this worker's provider instances."
            bind:checked={document.platformHome}
          />
          <Checkbox
            name="device-home"
            label="Device CLI too"
            description="Also manages the global instruction file used when you run the CLI yourself."
            bind:checked={document.deviceHome}
          />
        </div>
        {#if document.selector}<AssignmentEditor
            bind:selector={document.selector}
            {workers}
            disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          />{/if}
        {#if workers.length}<Disclosure>
            {#snippet summary()}<h2 class="text-base font-semibold text-balance">
                Machine overrides ({document.overrides.length})
              </h2>{/snippet}
            <MachineOverrides class="pt-4" bind:overrides={document.overrides} {workers} />
          </Disclosure>{/if}
      {:else}
        <p class="font-medium wrap-anywhere">{document.name}</p>
        {#if worker}
          <Field label="Preview computer"
            ><Select
              name="draft-preview-computer"
              bind:value={() => worker?.workerId ?? "", (value) => (workerId = value)}
              options={workers.map((w) => ({ value: w.workerId, label: w.name }))}
            /></Field
          >
          <InstructionPreview {worker} draft={document} />
        {:else}
          <p class="text-base text-muted sm:text-sm">
            No computers yet. Review your fragments below; assignments sync when a matching computer connects.
          </p>
          {#each document.fragments as fragment (fragment.id)}<InstructionText
              content={fragment.content}
              empty="This fragment is empty."
            />{/each}
        {/if}
        <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
          Saving syncs these instructions to assigned computers. Keep passwords and API keys out of instruction files.
        </p>
      {/if}
    {/if}
  {/snippet}
</EnvironmentSheet>
