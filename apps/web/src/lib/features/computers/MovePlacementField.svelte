<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";

  /** Where a moved project's threads continue on the other computer: one of its workspaces. */
  let {
    project,
    target,
    options,
    value = $bindable(),
    class: className,
  }: {
    project: string;
    target: string;
    options: readonly SelectOption[];
    value?: string | undefined;
    class?: ClassValue;
  } = $props();
</script>

<Field
  class={className}
  label={project ? `Workspace for ${project}` : "Workspace"}
  description={options.length
    ? `Its threads continue in this folder on ${target}.`
    : `Add a workspace on ${target} first (Settings → Projects on ${target}).`}
>
  <Select
    name={`move-workspace-${project}`}
    bind:value
    {options}
    disabled={!options.length}
    placeholder={options.length ? "Choose a workspace…" : "No workspace"}
  />
</Field>
