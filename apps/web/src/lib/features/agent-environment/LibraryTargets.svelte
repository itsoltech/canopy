<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { environmentSelected } from "@canopy/domain/environment-selectors";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    selector,
    workers,
    disabled = [],
    class: className,
  }: {
    selector?: ui.EnvironmentSelector;
    workers: readonly ui.EnvironmentWorker[];
    disabled?: readonly string[];
    class?: ClassValue;
  } = $props();

  const matching = $derived(workers.filter((w) => environmentSelected(selector, w) && !disabled.includes(w.workerId)));

  const everyone = $derived(selector?.everyone && !selector.excludeTags.length && !disabled.length);

  const description = $derived(
    [
      matching.map((w) => w.name).join(", ") || "No matching computers yet.",
      selector?.tags.length ? `${selector.matchAllTags ? "All tags" : "Any tag"}: ${selector.tags.join(", ")}.` : "",
      selector?.excludeTags.length ? `Except: ${selector.excludeTags.join(", ")}.` : "",
      everyone ? "Includes computers added later." : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

{#if matching.length}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- Keyboard focus exposes the full computer and tag list. -->
  <span tabindex="0" class={["rounded-sm whitespace-nowrap focus-ring", className]} {@attach tooltip(description)}>
    On {matching.length}
    {matching.length === 1 ? "computer" : "computers"}
  </span>
{/if}
