<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { freshness, health, measured } from "@canopy/domain/diagnostics";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let { computer, selected, onselect }: { computer: ui.ComputerDiagnostics; selected: boolean; onselect: () => void } =
    $props();
</script>

<SettingsCard>
  <div class="grid min-w-0 gap-3 p-4">
    <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="font-medium wrap-anywhere">{computer.name}</h3>
        <p class="text-sm text-muted capitalize">{computer.status} · {computer.appVersion || "Version unknown"}</p>
      </div>
      <span
        class={[
          "shrink-0 rounded-full px-2 py-1 text-xs",
          computer.findings.length ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-zinc-500/10 text-muted",
        ]}
      >
        {health(computer)}
      </span>
    </div>
    <p class="text-sm text-muted">{freshness(computer)}</p>
    {#if computer.droppedSamples}<p class="text-sm text-muted">
        Some measurements are missing. Limits were reached.
      </p>{/if}
    <dl class="grid grid-cols-2 gap-3 text-sm tabular-nums">
      <div>
        <dt class="text-muted">Gateway coverage</dt>
        <dd>{Math.floor(computer.observedSeconds / 60)} min</dd>
      </div>
      <div>
        <dt class="text-muted">CPU</dt>
        <dd>Not measured</dd>
      </div>
    </dl>
    {#each computer.links as link (`${link.kind}:${link.targetId}`)}
      <div class="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
        <span class="min-w-0 wrap-anywhere">{link.name} · {link.online ? "Online" : "Offline"}</span>
        <span class="text-muted tabular-nums"
          >{link.supported ? `RTT p95 ${measured(link.rttMs)}` : "Update to measure RTT"}</span
        >
      </div>
    {/each}
    {#if computer.gaps.length}<p class="text-sm text-muted">
        No data during {computer.gaps.length}
        {computer.gaps.length === 1 ? "period" : "periods"}.
      </p>{/if}
    {#if !["saved", "not_started", "restoring", ""].includes(computer.persistenceStatus)}
      <p class="text-sm text-amber-700 dark:text-amber-300">
        History could not be saved. Live data is still available.
      </p>
    {/if}
    <div><Button onclick={onselect} aria-pressed={selected}>View calls</Button></div>
  </div>
</SettingsCard>
