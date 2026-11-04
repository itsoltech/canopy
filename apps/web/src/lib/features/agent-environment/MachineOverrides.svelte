<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    overrides = $bindable([]),
    workers,
    class: className,
  }: {
    overrides?: ui.InstructionMachineOverride[];
    workers: readonly ui.EnvironmentWorker[];
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid gap-4", className]}>
  {#each overrides as override, i (override.workerId)}
    <div class="grid gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
      <div class="flex items-center justify-between gap-3">
        <h4 class="text-base font-medium text-balance sm:text-sm">
          {workers.find((w) => w.workerId === override.workerId)?.name ?? "Computer"}
        </h4>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => (overrides = overrides.filter((o) => o.workerId !== override.workerId))}
          >Remove override</Button
        >
      </div>
      <Checkbox
        name="disable-document-{i}"
        label="Disable this document on this computer"
        bind:checked={override.disabled}
      />
      {#if !override.disabled}<Field
          label="Extra instructions"
          description="Appended after this document's matching fragments."
        >
          <Textarea name="machine-instructions-{i}" bind:value={override.content} rows={4} />
        </Field>{/if}
    </div>
  {/each}
  <Field label="Add a machine override">
    <Select
      name="add-machine-override"
      value=""
      placeholder="Choose a computer…"
      options={workers.flatMap((w) =>
        overrides.some((o) => o.workerId === w.workerId) ? [] : [{ value: w.workerId, label: w.name }],
      )}
      onchange={(workerId) => (overrides = [...overrides, create(ui.InstructionMachineOverrideSchema, { workerId })])}
    />
  </Field>
</div>
