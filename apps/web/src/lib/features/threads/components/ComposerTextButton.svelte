<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    label,
    ariaLabel,
    hint,
    hotkey,
    icon,
    split = false,
    sending = false,
    disabled = false,
    onclick,
    class: className,
  }: {
    label: string;
    ariaLabel?: string;
    hint?: string;
    hotkey?: string | undefined;
    icon: IconName;
    split?: boolean;
    sending?: boolean;
    disabled?: boolean;
    onclick?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();
</script>

<button
  type={onclick ? "button" : "submit"}
  class={[
    "relative flex h-9 shrink-0 items-center gap-1.5 pr-2.5 pl-3 text-sm/5 font-medium focus-ring not-disabled:hover:bg-action-hover disabled:opacity-60 sm:h-8 sm:text-[0.8125rem]/5",
    split ? "rounded-l-full" : "rounded-full bg-action text-on-accent",
    className,
  ]}
  aria-label={ariaLabel}
  {@attach hint ? tooltip(hint, { hotkey }) : undefined}
  disabled={disabled || sending}
  {onclick}
>
  {#if sending}<Spinner />{:else}<Icon name={icon} tone="inherit" />{/if}
  <span class={split ? "@max-[24rem]/composer:hidden" : undefined}>{label}</span>
  <TouchTarget />
</button>
