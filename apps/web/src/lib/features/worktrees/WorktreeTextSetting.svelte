<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Input from "#lib/shared/ui/Input.svelte";
  import WorktreeSettingRow from "./WorktreeSettingRow.svelte";
  import type { WorktreeField } from "./worktree-settings.svelte.ts";

  /** A worktree setting edited as text (a folder, a remote, a prefix): saved trimmed when the field changes. */
  let {
    name,
    field,
    title,
    description,
    value,
    placeholder,
    overridden,
    inherited,
    mono = true,
    inputClass = "w-40",
    onsave,
    onreset,
    class: className,
  }: {
    name: string;
    field: WorktreeField;
    title: string;
    description: string;
    value: string;
    placeholder?: string | undefined;
    overridden: boolean;
    inherited: string;
    mono?: boolean;
    /** Width of the field. */
    inputClass?: ClassValue;
    onsave: (value: string) => void;
    onreset: () => void;
    class?: ClassValue;
  } = $props();
</script>

<WorktreeSettingRow {field} {title} {description} {overridden} {inherited} {onreset} class={className}>
  {#snippet control()}
    <Input
      {name}
      aria-label={title}
      class={[inputClass, mono && "font-mono"]}
      {placeholder}
      {value}
      onchange={(event) => onsave(event.currentTarget.value.trim())}
    />
  {/snippet}
</WorktreeSettingRow>
