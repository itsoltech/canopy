<script lang="ts">
  import type { Mention } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ConnectorIcon from "./ConnectorIcon.svelte";
  let { mention, class: className }: { mention: Mention; class?: ClassValue } = $props();
</script>
<span class={["inline-flex max-w-full items-baseline gap-1 rounded-md bg-white/15 px-1.5 py-px align-baseline font-medium dark:bg-black/10", className]} title="Connector: {mention.label}"><span class="self-center"><ConnectorIcon type={mention.source} /></span><span class="truncate">{mention.label}</span></span>
