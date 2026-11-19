<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import Rule from "./Rule.svelte";

  let {
    open,
    empty = false,
    ontoggle,
    children,
    class: className,
  }: {
    open: boolean;
    empty?: boolean;
    ontoggle: () => void;
    children: Snippet;
    class?: ClassValue;
  } = $props();
</script>

{#snippet content()}
  <!-- The chevron's place stays (aligned with other folds), empty when there is nothing to open. -->
  <span class="flex h-lh w-4 shrink-0 items-center">
    {#if !empty}<Icon
        name="chevron-right"
        class={[
          "t-acc-chevron fill-zinc-400 group-hover/fold:fill-zinc-500 dark:fill-zinc-500 dark:group-hover/fold:fill-zinc-400",
          open && "rotate-90",
        ]}
      />{/if}
  </span>
  {@render children()}
{/snippet}

<div class={["flex items-center gap-3", className]}>
  {#if empty}
    <div
      class="flex min-w-0 items-start gap-2 py-2.5 text-base/6 text-zinc-500 select-none sm:py-1 sm:text-sm/6 dark:text-zinc-400"
    >
      {@render content()}
    </div>
  {:else}
    <button
      type="button"
      class="group/fold flex min-w-0 items-start gap-2 rounded-md py-2.5 text-left text-base/6 text-zinc-500 focus-ring select-none hover:text-zinc-800 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-zinc-200"
      aria-expanded={open}
      onclick={ontoggle}>{@render content()}</button
    >
  {/if}
  <Rule class="min-w-4" />
</div>
