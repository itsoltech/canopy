<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import WorktreeSettingRow from "./WorktreeSettingRow.svelte";
  import type { WorktreeField } from "./worktree-settings.svelte.ts";

  let {
    field,
    title,
    description,
    checked,
    inherited,
    overridden,
    onchange,
    onreset,
    class: className,
  }: {
    field: WorktreeField;
    title: string;
    description: string;
    checked: boolean;
    inherited: boolean;
    overridden: boolean;
    onchange: (checked: boolean) => void;
    onreset: () => void;
    class?: ClassValue;
  } = $props();
</script>

<WorktreeSettingRow
  {field}
  {title}
  {description}
  {overridden}
  inherited={inherited ? "On" : "Off"}
  {onreset}
  class={className}
>
  {#snippet control()}<Switch name={field} label={title} {checked} {onchange} />{/snippet}
</WorktreeSettingRow>
