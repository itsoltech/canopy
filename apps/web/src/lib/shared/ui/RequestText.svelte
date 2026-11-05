<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "./CopyButton.svelte";
  import LongText from "./LongText.svelte";

  let { text, class: className }: { text: string; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-1 wrap-anywhere", className]}>
  <LongText {text} markdown lines={4} />
  <div class="flex justify-end"><CopyButton {text} label="Copy text" /></div>
</div>
