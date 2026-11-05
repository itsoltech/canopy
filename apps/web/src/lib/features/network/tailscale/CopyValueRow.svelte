<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";

  /** One copyable value in a settings list: a name or address in mono, with what it is beside it. */
  let { value, label, class: className }: { value: string; label: string; class?: ClassValue } = $props();
</script>

<li class={["flex items-center gap-3 px-4 py-3", className]}>
  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
    <p class="min-w-0 font-mono text-base/6 break-all text-zinc-950 sm:text-sm/6 dark:text-white">{value}</p>
    <span class="text-sm/5 text-zinc-500 dark:text-zinc-400">{label}</span>
  </div>
  <CopyButton text={value} label={`Copy ${value}`} class="shrink-0" />
</li>
