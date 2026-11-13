<script lang="ts">
  import type { PullRequestLook } from "@canopy/domain/github-pr";
  import type { ClassValue } from "svelte/elements";
  import { workingColors } from "@canopy/ui/thread-row";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { iconSwap } from "#lib/shared/ui/motion.ts";
  import { toneClasses } from "./presentation.ts";

  let {
    look,
    label = look.label,
    class: className,
  }: { look: PullRequestLook; label?: string; class?: ClassValue } = $props();
</script>

<span
  class={["inline-grid size-4 shrink-0 place-items-center", className]}
  role="img"
  aria-label={label}
  style:--working-light={workingColors.light.indicator}
  style:--working-dark={workingColors.dark.indicator}
>
  {#key `${look.spinning}:${look.icon}:${look.tone}`}
    <span class="col-start-1 row-start-1 grid size-full place-items-center" in:iconSwap>
      {#if look.spinning}
        <Spinner class="text-(--working-light) dark:text-(--working-dark)" />
      {:else}
        <Icon name={look.icon} size="md" tone="inherit" class={toneClasses[look.tone]} />
      {/if}
    </span>
  {/key}
</span>
