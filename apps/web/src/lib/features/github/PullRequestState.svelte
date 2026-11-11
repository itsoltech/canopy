<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { pullRequestLook } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { toneClasses } from "./presentation.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    state,
    iconOnly = false,
    class: className,
  }: { state: string; iconOnly?: boolean; class?: ClassValue } = $props();

  const look = $derived(pullRequestLook(state));
</script>

<span
  {@attach tooltip(iconOnly ? look.label : "")}
  class={[
    "inline-flex shrink-0 items-center gap-1.5",
    !iconOnly && "rounded-md bg-zinc-500/5 py-0.5 pr-2 pl-1",
    toneClasses[look.tone],
    className,
  ]}
  aria-label={iconOnly ? look.label : undefined}
>
  <Icon name={look.icon} tone="inherit" />{#if !iconOnly}<span>{look.label}</span>{/if}
</span>
