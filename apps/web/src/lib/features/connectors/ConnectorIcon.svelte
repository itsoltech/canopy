<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { connectorMarks } from "./marks.ts";
  let { type, class: className }: { type: string; class?: ClassValue } = $props();
</script>
{#if connectorMarks[type]}
  <svg viewBox="0 0 24 24" aria-hidden="true" class={["size-4 shrink-0 fill-current", className]}><path d={connectorMarks[type]} /></svg>
{:else}<Icon name="link" class={className} />{/if}
