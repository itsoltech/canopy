<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import TruncatedText from "./TruncatedText.svelte";

  /**
   * One option of a picker list (`SearchPicker`, `Combobox`): a leading mark, the name, a line under it,
   * a short status on the right and a check on the current one. Name and line stay one line each, cut off with
   * an ellipsis and shown in full as a tooltip (docs/ui-scale.md).
   */
  let {
    title,
    suffix,
    detail,
    status,
    selected,
    detailClass,
    class: className,
    leading,
    trailing,
  }: {
    title: string;
    /** Muted disambiguation, kept out of the selected trigger. */
    suffix?: string | undefined;
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

<div class={["flex items-start gap-2", className]}>
  {#if leading}<div class="flex h-lh shrink-0 items-center">{@render leading()}</div>{/if}
  <div class="grid min-w-0 flex-1">
    <div class="flex min-w-0 items-baseline gap-1">
      <TruncatedText text={title} class="min-w-0 truncate font-medium" />
      {#if suffix}<TruncatedText text={`· ${suffix}`} class="min-w-0 truncate text-zinc-500 dark:text-zinc-400" />{/if}
    </div>
    {#if detail}<TruncatedText
        text={detail}
        class={["text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400", detailClass]}
      />{/if}
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
