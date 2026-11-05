<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import LocalOverridesNote from "./LocalOverridesNote.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import LinkedOverrides from "./LinkedOverrides.svelte";

  let {
    skill = $bindable(),
    workers,
    class: className,
  }: { skill: ui.LibrarySkill; workers: readonly ui.EnvironmentWorker[]; class?: ClassValue } = $props();

  function update(workerId: string, disabled: boolean, version: bigint) {
    skill.overrides = [
      ...skill.overrides.filter((o) => o.workerId !== workerId),
      create(ui.SkillMachineOverrideSchema, { workerId, disabled, version }),
    ];
  }
</script>

<div class={["grid gap-4", className]}>
  <LocalOverridesNote />
  {#each workers as worker (worker.workerId)}
    {@const override = skill.overrides.find((o) => o.workerId === worker.workerId)}
    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <Checkbox
        name="disable-skill-{worker.workerId}"
        label="Disable on {worker.name}"
        bind:checked={
          () => override?.disabled ?? false, (disabled) => update(worker.workerId, disabled, override?.version ?? 0n)
        }
      />
      {#if skill.versions.length}
        <Field label="Version on {worker.name}">
          <Select
            name="skill-version-{worker.workerId}"
            value={(override?.version ?? 0n).toString()}
            options={[
              { value: "0", label: "Follow library version" },
              ...skill.versions.map((v) => ({ value: v.toString(), label: `Version ${v}` })),
            ]}
            onchange={(version) => update(worker.workerId, override?.disabled ?? false, BigInt(version))}
          />
        </Field>
      {/if}
    </div>
  {/each}
  <LinkedOverrides />
</div>
