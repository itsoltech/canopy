<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { harnessKey, harnessName } from "#lib/features/providers/instances.ts";
  let { instance, class: className }: { instance: ui.WorkerInstance; class?: ClassValue } = $props();
  const problem = $derived.by(() => {
    if (instance.available) return "";
    const detail = instance.detail.toLowerCase();
    if (detail.includes("not found") || detail.includes("not runnable")) return "not installed";
    if (detail.includes("not signed in") || detail.includes("login") || detail.includes("unauthenticated")) return "not signed in";
    return instance.detail || "waiting for availability";
  });
</script>

<div class={["flex max-w-full items-start gap-1.5 rounded-md bg-zinc-950/5 px-2 py-1 text-sm/5 text-zinc-700 dark:bg-white/5 dark:text-zinc-300", className]}>
  <div class="flex h-lh shrink-0 items-center"><ProviderIcon provider={harnessKey(instance.harness)} /></div>
  <p class="min-w-0 break-words">{harnessName(instance.harness)} · {instance.id === "native" ? "Native" : instance.label || instance.id}{problem ? ` — ${problem}` : ""}</p>
</div>
