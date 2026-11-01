<script lang="ts">
  import type { Snippet } from "svelte";
  import { ItemStatus } from "@open-agents/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { useItemAwaiting } from "../../thread-directory.ts";
  import ItemStatusIcon from "./ItemStatusIcon.svelte";

  /**
   * One-line activity row (tool, command, file change …) that expands to its details.
   * Starts open when `defaultOpen` (e.g. running or failed); after that the user decides.
   */
  let {
    icon,
    status,
    defaultOpen = false,
    tone = "neutral",
    title,
    aside,
    children,
  }: {
    icon: IconName;
    status: ItemStatus;
    defaultOpen?: boolean;
    tone?: "neutral" | "violet" | "rose";
    title: Snippet;
    aside?: Snippet;
    children?: Snippet;
  } = $props();

  // svelte-ignore state_referenced_locally
  let open = $state(defaultOpen);
  const awaiting = useItemAwaiting();
  const iconClass = $derived(
    tone === "violet" ? "fill-violet-500 dark:fill-violet-400" : tone === "rose" || status === ItemStatus.FAILED ? "fill-rose-500 dark:fill-rose-400" : "fill-zinc-400 dark:fill-zinc-500",
  );
</script>

{#snippet row()}
  <span class="flex min-w-0 items-start gap-2">
    <span class="flex h-lh items-center"><Icon name={icon} class={iconClass} /></span>
    <span class="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">{@render title()}</span>
    <span class="flex shrink-0 items-center gap-2 text-sm/6 text-zinc-500 tabular-nums sm:text-xs/6 dark:text-zinc-400">
      {@render aside?.()}
      {#if awaiting() && status === ItemStatus.IN_PROGRESS}
        <span class="flex items-center gap-1 text-amber-700 dark:text-amber-400"><Icon name="hand-raised" class="size-3.5" />Waiting for you</span>
      {:else}
        <ItemStatusIcon {status} />
      {/if}
    </span>
  </span>
{/snippet}

<div class="text-base/6 sm:text-sm/6">
  {#if children}
    <Disclosure bind:open summaryClass="-mx-1.5 px-1.5 py-1 hover:bg-zinc-950/2.5 dark:hover:bg-white/5">
      {#snippet summary()}{@render row()}{/snippet}
      <div class="mt-1 mb-2 grid gap-2 pl-6">{@render children()}</div>
    </Disclosure>
  {:else}
    <div class="py-1 pl-6">{@render row()}</div>
  {/if}
</div>
