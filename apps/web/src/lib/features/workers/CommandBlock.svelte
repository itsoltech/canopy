<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  let { text, label = "Command", copyLabel = "Copy command", copyable = true, class: className }: { text: string; label?: string; copyLabel?: string; copyable?: boolean; class?: ClassValue } = $props();
</script>

<div class={["min-w-0 overflow-hidden rounded-xl bg-zinc-950 text-zinc-100 ring-1 ring-inset ring-white/10", className]}>
  <div class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2 text-sm/6 text-zinc-400">
    <p>{label}</p>
    {#if copyable}<div class="shrink-0 dark"><CopyButton {text} label={copyLabel} /></div>{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre tabindex="0" aria-label={label} class="max-h-72 overflow-auto p-4 font-mono text-xs/6 select-text focus-ring"><code>{text}</code></pre>
</div>
