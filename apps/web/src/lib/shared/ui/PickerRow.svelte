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
    trailing,
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
    /** Right of the name, instead of `status` (e.g. badges). */
    trailing?: Snippet;
  } = $props();
</script>

<div class={["flex items-start gap-2.5", className]}>
  {#if leading}<div class="flex h-lh shrink-0 items-center">{@render leading()}</div>{/if}
  <div class="grid min-w-0 flex-1">
    <p class="font-medium [overflow-wrap:anywhere] whitespace-normal">{title}</p>
    {#if detail}<p
        class={[
          "text-sm/5 [overflow-wrap:anywhere] whitespace-normal text-zinc-500 sm:text-xs/4 dark:text-zinc-400",
          detailClass,
        ]}
        title={detail}
      >
        {detail}
      </p>{/if}
  </div>
  {#if trailing}
    <div class="flex h-lh shrink-0 items-center gap-1">{@render trailing()}</div>
  {:else if status}
    <div class="flex min-h-lh max-w-24 shrink-0 items-center">
      <p class="text-sm/5 [overflow-wrap:anywhere] whitespace-normal text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
        {status}
      </p>
    </div>
  {/if}
  <div class="flex h-lh shrink-0 items-center">
    <Icon name="check" class={["text-brand-600 dark:text-brand-400", !selected && "invisible"]} />
  </div>
</div>
