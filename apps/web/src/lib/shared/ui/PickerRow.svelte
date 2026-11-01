<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";

  /**
   * One option of a picker list (`SearchPicker`, `Combobox`): a leading mark, the name, a line under it,
   * a short status on the right and a check on the current one.
   */
  let {
    title,
    detail,
    status,
    selected,
    detailClass,
    class: className,
    leading,
  }: {
    title: string;
    /** The line under the name. */
    detail?: string | undefined;
    /** Right of the name ("Online · Linux"). */
    status?: string | undefined;
    selected: boolean;
    /** E.g. `font-mono` for a path. */
    detailClass?: ClassValue;
    class?: ClassValue;
    leading?: Snippet;
  } = $props();
</script>

<div class={["flex items-start gap-2.5", className]}>
  {#if leading}<div class="flex h-lh shrink-0 items-center">{@render leading()}</div>{/if}
  <div class="grid min-w-0 flex-1">
    <p class="truncate font-medium">{title}</p>
    {#if detail}<p class={["truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400", detailClass]} title={detail}>{detail}</p>{/if}
  </div>
  {#if status}
    <div class="flex h-lh shrink-0 items-center"><p class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{status}</p></div>
  {/if}
  <div class="flex h-lh shrink-0 items-center"><Icon name="check" class={["fill-brand-600 dark:fill-brand-400", !selected && "invisible"]} /></div>
</div>
