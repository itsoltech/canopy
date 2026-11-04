<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip as withTooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  /**
   * Round icon button of the bot composer with a tooltip. `unavailable` keeps it focusable (so the
   * tooltip says why) but inert; `primary` is the send button.
   */
  let {
    icon,
    label,
    tooltip = label,
    type = "button",
    variant = "ghost",
    unavailable = false,
    busy = false,
    onclick,
    class: className,
  }: {
    icon: IconName;
    label: string;
    tooltip?: string;
    type?: "button" | "submit";
    variant?: "primary" | "secondary" | "ghost";
    unavailable?: boolean;
    busy?: boolean;
    onclick?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const variants = {
    primary:
      "bg-zinc-900 fill-white text-white aria-disabled:bg-zinc-950/10 aria-disabled:text-zinc-400 not-aria-disabled:hover:bg-zinc-700 dark:bg-white dark:text-zinc-950 dark:aria-disabled:bg-white/10 dark:aria-disabled:text-zinc-500 dark:not-aria-disabled:hover:bg-zinc-200",
    secondary:
      "bg-zinc-950/5 text-zinc-700 not-aria-disabled:hover:bg-zinc-950/10 dark:bg-white/8 dark:text-zinc-300 dark:not-aria-disabled:hover:bg-white/12",
    ghost:
      "text-zinc-500 not-aria-disabled:hover:bg-zinc-950/5 not-aria-disabled:hover:text-zinc-950 dark:text-zinc-400 dark:not-aria-disabled:hover:bg-white/10 dark:not-aria-disabled:hover:text-white",
  };
</script>

<button
  {type}
  aria-label={label}
  aria-disabled={unavailable || busy || undefined}
  class={[
    "relative grid size-9 shrink-0 place-items-center rounded-full focus-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:size-8",
    variants[variant],
    className,
  ]}
  onclick={(event) => {
    if (unavailable || busy) event.preventDefault();
    else onclick?.();
  }}
  {@attach withTooltip(tooltip)}
>
  {#if busy}<Spinner class="size-3.5" />{:else}<Icon name={icon} />{/if}
  <TouchTarget />
</button>
