<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";

  let {
    title,
    description,
    children,
    changed,
    onreset,
    soon = false,
    flush = false,
    control: rowControl,
    class: className,
  }: {
    title: string;
    description: string;
    children?: Snippet;
    changed: boolean;
    onreset: () => void;
    control: Snippet;
    soon?: boolean;
    flush?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<SettingsRow {title} {description} {soon} {flush} class={className}>
  {@render children?.()}
  {#snippet control()}
    <ResettableControl changed={changed && !soon}>
      {@render rowControl()}
      {#snippet reset()}<IconButton
          icon="arrow-path"
          label="Reset {title} to default"
          size="sm"
          onclick={onreset}
        />{/snippet}
    </ResettableControl>
  {/snippet}
</SettingsRow>
