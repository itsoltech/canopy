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

  let {
    document = $bindable(),
    workers,
    busy,
    conflict,
    onsave,
    oncancel,
    class: className,
  }: {
    document: ui.InstructionDocument;
    workers: readonly ui.EnvironmentWorker[];
    busy: boolean;
    conflict: boolean;
    onsave: () => void;
    oncancel: () => void;
    class?: ClassValue;
  } = $props();

  function move(index: number, direction: number) {
    const fragments = [...document.fragments];
    const fragment = fragments.splice(index, 1)[0];

    if (!fragment) return;
    fragments.splice(index + direction, 0, fragment);
    document.fragments = fragments;
  }
</script>

<form
  class={["grid gap-6 rounded-xl p-4 ring-1 ring-zinc-950/10 sm:p-5 dark:ring-white/10", className]}
  onsubmit={(event) => {
    event.preventDefault();
    onsave();
  }}
>
  <fieldset class="grid min-w-0 gap-6" disabled={busy}>
    <legend class="sr-only">Instruction document</legend>
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
    <Disclosure open>
      {#snippet summary()}<h2 class="text-base font-semibold text-balance">Assignment</h2>{/snippet}
      <div class="pt-4">
        {#if document.selector}<AssignmentEditor
            bind:selector={document.selector}
            {workers}
            disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          />{/if}
      </div>
    </Disclosure>
    <div class="grid gap-6 divide-y divide-zinc-950/10 dark:divide-white/10">
      {#each document.fragments as fragment, i (fragment.id)}
        <FragmentEditor
          bind:fragment={document.fragments[i]}
          {workers}
          parentSelector={document.selector}
          disabled={document.overrides.filter((o) => o.disabled).map((o) => o.workerId)}
          index={i}
          count={document.fragments.length}
          class={i > 0 ? "pt-6" : ""}
          onmove={(direction) => move(i, direction)}
          onremove={() => (document.fragments = document.fragments.filter((f) => f.id !== fragment.id))}
        />
      {/each}
    </div>
    <div>
      <Button
        size="sm"
        disabled={document.fragments.length >= 64}
        onclick={() =>
          (document.fragments = [
            ...document.fragments,
            create(ui.InstructionFragmentSchema, { id: crypto.randomUUID(), name: "", content: "" }),
          ])}>Add fragment</Button
      >
    </div>
    <Disclosure>
      {#snippet summary()}<h2 class="text-base font-semibold text-balance">
          Machine overrides ({document.overrides.length})
        </h2>{/snippet}
      <MachineOverrides class="pt-4" bind:overrides={document.overrides} {workers} />
    </Disclosure>
    <p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
      Saving syncs these instructions to assigned computers. Keep passwords and API keys out of instruction files.
    </p>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" variant="primary" disabled={conflict} loading={busy}>Save and sync</Button>
      <Button onclick={oncancel}>Cancel</Button>
    </div>
  </fieldset>
</form>
