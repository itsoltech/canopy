<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import { badgeTones, type Tone } from "./tone.ts";

  /** Compact label. Colour is never the only signal: the text always says what it means. */
  let { tone = "neutral", icon, class: className, children }: { tone?: Tone; icon?: IconName; class?: ClassValue; children: Snippet } = $props();
</script>

<span
  class={[
    "inline-flex shrink-0 items-center gap-x-1 rounded-md py-0.5 text-sm/5 font-medium whitespace-nowrap ring-1 ring-inset sm:text-xs/5",
    icon ? "pr-1.5 pl-1" : "px-1.5",
    badgeTones[tone],
    className,
  ]}
>
  {#if icon}<Icon name={icon} class="size-3.5" />{/if}
  {@render children()}
</span>
