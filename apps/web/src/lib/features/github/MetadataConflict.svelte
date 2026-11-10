<script lang="ts">
  import { metadataComparison, type MetadataKind, type MetadataState } from "@canopy/domain/github-metadata";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    state,
    kind,
    onrefresh,
    disabled = false,
    class: className,
  }: {
    state: MetadataState;
    kind: MetadataKind;
    onrefresh: () => void;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  const comparison = $derived(metadataComparison(state, kind));
</script>

<div role="alert" class={["grid min-w-0 gap-2 rounded-lg border border-amber-500/30 p-3", className]}>
  <p class="text-sm text-amber-800 dark:text-amber-300">
    These fields changed on GitHub. Compare changes before editing again.
  </p>
  <div class="grid min-w-0 gap-2 sm:grid-cols-2">
    <section class="min-w-0">
      <h4 class="text-sm font-medium">Your draft</h4>
      <pre
        class="max-h-48 overflow-auto text-xs wrap-anywhere whitespace-pre-wrap">{#each comparison.draft as line}<span
            class={["block", line.changed && "bg-rose-500/10"]}>{line.changed ? "− " : "  "}{line.text}{"\n"}</span
          >{/each}</pre>
    </section>
    <section class="min-w-0">
      <h4 class="text-sm font-medium">On GitHub</h4>
      <pre
        class="max-h-48 overflow-auto text-xs wrap-anywhere whitespace-pre-wrap">{#each comparison.current as line}<span
            class={["block", line.changed && "bg-emerald-500/10"]}>{line.changed ? "+ " : "  "}{line.text}{"\n"}</span
          >{/each}</pre>
    </section>
  </div>
  <Button size="sm" {disabled} onclick={onrefresh}>Refresh fields</Button>
</div>
