<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { environmentSelected } from "@canopy/domain/environment-selectors";

  let {
    selector,
    workers,
    disabled = [],
    parentSelector,
    class: className,
  }: {
    selector?: ui.EnvironmentSelector;
    workers: readonly ui.EnvironmentWorker[];
    disabled?: readonly string[];
    parentSelector?: ui.EnvironmentSelector;
    class?: ClassValue;
  } = $props();

  const matching = $derived(
    workers.filter(
      (w) =>
        environmentSelected(selector, w) && environmentSelected(parentSelector, w) && !disabled.includes(w.workerId),
    ),
  );
</script>

<p
  class={["text-base text-pretty text-zinc-500 tabular-nums sm:text-sm dark:text-zinc-400", className]}
  aria-live="polite"
>
  Applies to {matching.length}
  {matching.length === 1 ? "computer" : "computers"}: {matching.map((w) => w.name).join(", ") || "none yet"}
</p>
