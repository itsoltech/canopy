<script lang="ts">
  import { storageDisplay, storageDatabaseHelp, type StorageComponent } from "@canopy/domain/diagnostics";
  import { formatLocalDateTime } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";

  let { component }: { component: StorageComponent } = $props();
  const display = $derived(storageDisplay(component, clock.now));
  const date = $derived(new Date(Number(display.sampledAtMs)));
</script>

<div class="grid min-w-0 gap-2 p-4">
  <div class="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div class="min-w-0 flex-1 basis-40">
      <h4 class="font-medium wrap-anywhere">{component.name}</h4>
      {#if component.kind || display.status}
        <p class="text-sm wrap-anywhere text-muted" role="status">
          {[component.kind, display.status].filter(Boolean).join(" · ")}
        </p>
      {/if}
    </div>
    <dl class="min-w-0 text-right tabular-nums">
      <dt class="text-sm text-muted">{display.totalLabel}</dt>
      <dd class="font-medium wrap-anywhere">{display.total}</dd>
    </dl>
  </div>
  {#if display.freshness}
    <p class="text-sm text-muted tabular-nums">
      <time datetime={date.toISOString()} title={formatLocalDateTime(date)}
        >{display.showDate
          ? `${display.sampleAction} ${formatLocalDateTime(date)}${component.ageUncertain ? " · Age is approximate" : ""}`
          : display.freshness}</time
      >
    </p>
  {/if}
  {#if display.categories.length}
    <dl class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-sm tabular-nums sm:grid-cols-3 lg:grid-cols-5">
      {#each display.categories as [label, value] (label)}
        <div class="min-w-0">
          <dt class="text-muted">{label}</dt>
          <dd class="wrap-anywhere">{value}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  {#if display.database}
    <div class="grid gap-1 text-sm">
      <dl class="flex flex-wrap justify-between gap-x-4 gap-y-1 tabular-nums">
        <dt class="text-muted">Database</dt>
        <dd>{display.database}</dd>
      </dl>
      <p class="text-muted">{storageDatabaseHelp}</p>
    </div>
  {/if}
  {#if display.note}<p class="text-sm text-muted">{display.note}</p>{/if}
  {#if display.message}<p class="text-sm text-muted">{display.message}</p>{/if}
</div>
