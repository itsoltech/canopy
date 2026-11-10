<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { paletteRowClass, paletteRowIconClass } from "./palette-style.ts";

  /**
   * One option of a palette-style listbox that is not a command: a title, an optional second line and a quiet
   * status on the right. Keys reach it through the input (`aria-activedescendant`); the pointer highlights on
   * move and chooses on click. A disabled option stays listed with its reason on the second line.
   */
  let {
    id,
    title,
    suffix,
    detail,
    status,
    icon,
    active,
    disabled = false,
    onchoose,
    onpoint,
    leading,
    class: className,
  }: {
    id: string;
    title: string;
    suffix?: string | undefined;
    detail?: string | undefined;
    status?: string | undefined;
    icon?: IconName | undefined;
    active: boolean;
    disabled?: boolean;
    onchoose: () => void;
    onpoint: () => void;
    leading?: Snippet;
    class?: ClassValue;
  } = $props();
</script>

<!-- Options are not focusable: focus stays in the input (combobox pattern); a click chooses. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  {id}
  role="option"
  tabindex="-1"
  aria-selected={active}
  aria-disabled={disabled || undefined}
  data-active={active || undefined}
  class={[paletteRowClass, className]}
  onpointerdown={(event) => event.preventDefault()}
  onpointermove={onpoint}
  onclick={() => !disabled && onchoose()}
>
  {#if leading}{@render leading()}{:else if icon}<Icon name={icon} class={paletteRowIconClass} />{/if}
  <span class="grid min-w-0 flex-1 gap-0.5">
    <span class="flex min-w-0 gap-1">
      <span class="truncate" {title}>{title}</span>
      {#if suffix}<span class="truncate text-zinc-500 dark:text-zinc-400" title={suffix}>· {suffix}</span>{/if}
    </span>
    {#if detail}<span class="truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{detail}</span>{/if}
  </span>
  {#if status}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{status}</span>{/if}
</div>
