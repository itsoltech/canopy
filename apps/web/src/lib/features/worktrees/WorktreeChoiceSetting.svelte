<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import WorktreeSettingRow from "./WorktreeSettingRow.svelte";
  import type { WorktreeField } from "./worktree-settings.svelte.ts";

  /** A worktree setting chosen from a list (an enum of the contract, as its number). */
  let {
    name,
    field,
    title,
    description,
    value,
    options,
    overridden,
    onchange,
    onreset,
    inherited,
    class: className,
  }: {
    name: string;
    field: WorktreeField;
    title: string;
    description: string;
    value: number;
    options: readonly SelectOption[];
    overridden: boolean;
    /** The inherited value (its label is shown when this scope overrides it). */
    inherited: number;
    onchange: (value: number) => void;
    onreset: () => void;
    class?: ClassValue;
  } = $props();

  const labelOf = (v: number) => options.find((o) => o.value === String(v))?.label ?? "";
</script>

<WorktreeSettingRow
  {field}
  {title}
  {description}
  {overridden}
  inherited={labelOf(inherited)}
  {onreset}
  class={className}
>
  {#snippet control()}
    <Select
      {name}
      aria-label={title}
      class="w-48"
      value={String(value)}
      {options}
      onchange={(next) => onchange(Number(next))}
    />
  {/snippet}
</WorktreeSettingRow>
