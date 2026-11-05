<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import ConfigNotices from "./ConfigNotices.svelte";

  let { section, class: className }: { section: string; class?: ClassValue } = $props();
</script>

<ConfigNotices
  class={className}
  match={(n) => n.kind === "settings" && (n.field === section || n.field.startsWith(`${section}.`))}
/>
