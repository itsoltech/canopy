<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";

  /** The OAuth redirect URL to register with a provider's app, with a copy button. Wraps on narrow screens. */
  let {
    url,
    label = "Callback URL",
    copyLabel = "Copy callback URL",
    class: className,
  }: { url: string; label?: string; copyLabel?: string; class?: ClassValue } = $props();
</script>

<div class={["grid gap-1", className]}>
  <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{label}</p>
  <div class="flex items-start gap-2 rounded-lg py-1 pr-1 pl-3 ring-1 ring-zinc-950/10 dark:ring-white/10">
    <code class="min-w-0 flex-1 py-1 text-sm/6 wrap-anywhere text-zinc-700 dark:text-zinc-300">{url}</code>
    <CopyButton text={url} label={copyLabel} />
  </div>
</div>
