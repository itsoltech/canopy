<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import { badgeTones, type Tone } from "./tone.ts";

  /** Compact label. Colour is never the only signal: the text always says what it means. `compact` fits a text line (list rows). */
  let { tone = "neutral", icon, compact = false, class: className, children }: { tone?: Tone; icon?: IconName; compact?: boolean; class?: ClassValue; children: Snippet } = $props();
</script>

<span
  class={[
    "inline-flex shrink-0 items-center gap-x-1 rounded-md text-sm/5 font-medium whitespace-nowrap ring-1 ring-inset sm:text-xs/5",
    compact ? "py-0 sm:text-xs/4" : "py-0.5",
    icon ? (compact ? "pr-1 pl-0.5" : "pr-1.5 pl-1") : compact ? "px-1" : "px-1.5",
    badgeTones[tone],
    className,
  ]}
>
  {#if icon}<Icon name={icon} class="size-3.5" />{/if}
  {@render children()}
</span>
