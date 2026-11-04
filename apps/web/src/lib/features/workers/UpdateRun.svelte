<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { run, class: className }: { run: ui.UpdateRun; class?: ClassValue } = $props();
  const done = $derived(run.steps.filter((s) => s.state === "succeeded").length);
</script>

<section class={["grid gap-3", className]} aria-label="Update all progress">
  <p class="text-base/6 font-medium tabular-nums sm:text-sm/6" role="status">
    {run.state === "succeeded"
      ? "All updates completed"
      : run.state === "running"
        ? `Updating · ${done}/${run.steps.length} completed`
        : "Update all stopped"}
  </p>
  {#if run.state === "running"}<ProgressBar
      label="Update all progress"
      value={run.steps.length ? (done / run.steps.length) * 100 : 100}
    />{/if}
  {#if run.reason}<Alert tone="error">{run.reason}</Alert>{/if}
  <Disclosure>
    {#snippet summary()}<span>Update order and results</span>{/snippet}
    <ol class="grid list-decimal gap-2 pt-3 pl-5 text-base/6 sm:text-sm/6">
      {#each run.steps as step, i (`${run.id}/${i}`)}<li>
          <p>{step.label} · {step.version || "app channel"} · {step.state}</p>
          {#if step.reason}<p class="text-zinc-500 dark:text-zinc-400">{step.reason}</p>{/if}
        </li>{/each}
    </ol>
  </Disclosure>
</section>
