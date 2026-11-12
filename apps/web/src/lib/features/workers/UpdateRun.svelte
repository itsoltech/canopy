<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import UpdateProgress from "./UpdateProgress.svelte";
  import StoppedUpdateActions from "./StoppedUpdateActions.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";

  let { run, updates, class: className }: { run: ui.UpdateRun; updates: UpdatesState; class?: ClassValue } = $props();
  const done = $derived(run.steps.filter((s) => s.state === "succeeded").length);
</script>

{#if run.steps.length || run.state === "running" || run.reason}
  <section class={["grid min-w-0 gap-2", className]} aria-label="Update run">
    {#if run.state === "running"}
      <p class="text-sm/5 tabular-nums" role="status">Updating · {done}/{run.steps.length} completed</p>
      <UpdateProgress
        label="Update all progress"
        value={run.steps.length ? (done / run.steps.length) * 100 : undefined}
      />
    {/if}
    {#if run.reason}<p class="break-anywhere text-sm/5 text-rose-600 select-text dark:text-rose-400" role="status">
        {run.reason}
      </p>{/if}
    {#if run.steps.length}
      <Disclosure summaryClass="text-sm/5 text-muted">
        {#snippet summary()}Update results · {done}/{run.steps.length}{/snippet}
        <ol class="max-h-64 scroll-stable divide-y divide-divider overflow-y-auto pt-2">
          {#each run.steps as step, i (`${run.id}/${i}`)}
            <li class="min-w-0 py-2 text-sm/5">
              <div class="flex min-w-0 items-start gap-2">
                <p class="break-anywhere min-w-0 flex-1">{step.label}</p>
                <Badge
                  compact
                  tone={step.state === "failed" || step.state === "blocked"
                    ? "rose"
                    : step.state === "succeeded"
                      ? "emerald"
                      : "neutral"}>{step.state}</Badge
                >
              </div>
              <p class="break-anywhere font-mono text-xs/5 text-muted select-text">{step.version || "App channel"}</p>
              {#if step.reason}<p class="break-anywhere text-muted select-text">{step.reason}</p>{/if}
            </li>
          {/each}
        </ol>
      </Disclosure>
    {/if}
    <StoppedUpdateActions {run} {updates} />
  </section>
{/if}
