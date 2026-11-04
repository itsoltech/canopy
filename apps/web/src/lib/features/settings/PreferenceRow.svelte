<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  let {
    title,
    description,
    children,
    changed,
    onreset,
    control: rowControl,
    class: className,
  }: {
    title: string;
    description: string;
    children?: Snippet;
    changed: boolean;
    onreset: () => void;
    control: Snippet;
    class?: ClassValue;
  } = $props();
</script>

<SettingsRow {title} {description} class={className}>
  {@render children?.()}
  {#snippet control()}
    {@render rowControl()}
    {#if changed}<IconButton icon="arrow-path" label="Reset {title} to default" size="sm" onclick={onreset} />{/if}
  {/snippet}
</SettingsRow>
