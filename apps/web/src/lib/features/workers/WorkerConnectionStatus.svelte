<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@open-agents/contracts";
  import { osLabel, providerSummary } from "#lib/features/overview/workers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  let { worker, name, class: className }: { worker?: ui.Worker | undefined; name: string; class?: ClassValue } = $props();
</script>

<div class={["flex items-start gap-3 rounded-xl bg-zinc-950/3 p-4 dark:bg-white/5", className]} role="status" aria-live="polite">
  <div class="pt-1">{#if worker?.online}<Icon name="check-circle" class="fill-emerald-600 dark:fill-emerald-400" />{:else}<Spinner />{/if}</div>
  <div class="min-w-0 text-base/6 sm:text-sm/6">
    <p class="font-semibold">{worker?.online ? "Connected" : "Waiting for the worker to connect…"}</p>
    <p class="text-zinc-500 dark:text-zinc-400">{worker ? `${worker.hostname} · ${osLabel(worker.os)}` : `Start the command on ${name}. This updates automatically.`}</p>
    {#if worker?.online}<div class="mt-3 grid gap-1">{#each worker.providers as provider (provider.provider)}<p>{providerSummary(provider)}</p>{:else}<p>Detecting agent CLIs…</p>{/each}</div>{/if}
  </div>
</div>
