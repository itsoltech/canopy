<script lang="ts">
  import type { Snippet } from "svelte";
  import { ItemStatus } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { useItemAwaiting } from "../../thread-directory.ts";
  import ItemStatusIcon from "./ItemStatusIcon.svelte";
  import { useItemChildren } from "./item-context.ts";
  import { activityBody, activityHeader, activitySurface } from "../activity-header.ts";

  /**
   * One-line activity row (tool, command, file change …) that expands to its details.
   * Always starts collapsed; only the reader opens it. Disclosure remembers that choice per item.
   * Set in the work context (docs/ui-scale.md): a step smaller than the messages around it.
   */
  let {
    icon,
    lead,
    status,
    tone = "neutral",
    title,
    aside,
    children,
  }: {
    icon: IconName;
    lead?: Snippet;
    status: ItemStatus;
    tone?: "neutral" | "violet" | "rose";
    title: Snippet;
    aside?: Snippet;
    children?: Snippet;
  } = $props();

  let open = $state(false);
  const awaiting = useItemAwaiting();
  const nested = useItemChildren();

  const iconClass = $derived(
    tone === "violet"
      ? "text-violet-500 dark:text-violet-400"
      : tone === "rose" || status === ItemStatus.FAILED
        ? "text-rose-500 dark:text-rose-400"
        : "text-zinc-500 dark:text-zinc-400",
  );
</script>

{#snippet row()}
  <span class="flex min-w-0 items-start gap-2">
    <span class="flex h-lh items-center"
      >{#if lead}{@render lead()}{:else}<Icon name={icon} class={iconClass} />{/if}</span
    >
    <span class="min-w-0 flex-1 overflow-hidden text-zinc-700 dark:text-zinc-300">{@render title()}</span>
    <span class="flex shrink-0 items-center gap-2 text-sm/6 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">
      {@render aside?.()}
      {#if awaiting() && status === ItemStatus.IN_PROGRESS}
        <span class="flex items-center gap-1 text-amber-700 dark:text-amber-400"
          ><Icon name="hand-raised" tone="inherit" class="size-3.5" />Waiting for you</span
        >
      {:else}
        <ItemStatusIcon {status} />
      {/if}
    </span>
  </span>
{/snippet}

<div class="density-work text-base/6 select-none sm:text-sm/5">
  {#if children || nested()}
    <Disclosure bind:open remember="frame" grid class={activitySurface} summaryClass={activityHeader}>
      {#snippet summary()}{@render row()}{/snippet}
      <div class={[activityBody, "select-text"]}>
        {@render children?.()}
        {#if nested()}<div class="grid gap-1 border-l-2 border-zinc-950/5 pl-3 dark:border-white/10">
            {@render nested()?.()}
          </div>{/if}
      </div>
    </Disclosure>
  {:else}
    <div class={["rounded-md pl-8", activityHeader, activitySurface]}>{@render row()}</div>
  {/if}
</div>
