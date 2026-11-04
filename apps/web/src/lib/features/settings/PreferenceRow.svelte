<script lang="ts">
  import type { Snippet } from "svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";

  let {
    title,
    description,
    children,
    changed,
    onreset,
    control: rowControl,
  }: {
    title: string;
    description: string;
    children?: Snippet;
    changed: boolean;
    onreset: () => void;
    control: Snippet;
  } = $props();
</script>

<SettingsRow {title} {description}>
  {@render children?.()}
  {#snippet control()}
    {@render rowControl()}
    {#if changed}<IconButton icon="arrow-path" label="Reset {title} to default" size="sm" onclick={onreset} />{/if}
  {/snippet}
</SettingsRow>
