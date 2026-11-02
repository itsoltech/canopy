<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { isEmptyNode, isInline, type Node } from "#lib/shared/structure.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import LeafValue from "./LeafValue.svelte";
  import StructuredView from "./StructuredView.svelte";

  /**
   * The generic view of a tool's input or result (structure.ts): fields as a description list with
   * readable labels, short values beside their label, long text, lists and objects below it. Nested
   * objects with many fields fold away; long lists show their first items until "Show N more".
   */
  let { node, depth = 0, class: className }: { node: Node; depth?: number; class?: ClassValue } = $props();

  const LIST_HEAD = 5;
  let allItems = $state(false);
  const items = $derived(node.kind === "list" ? (allItems ? node.items : node.items.slice(0, LIST_HEAD)) : []);
  const scalarList = $derived(node.kind === "list" && node.items.every((item) => isInline(item)));
  const fields = $derived(node.kind === "object" ? node.fields.filter((f) => !isEmptyNode(f.node) || depth === 0) : []);
</script>

{#if node.kind === "object"}
  <dl class={["grid gap-y-1.5 text-base/6 sm:text-sm/6", className]}>
    {#each fields as field (field.key)}
      {#if isInline(field.node)}
        <div class="grid gap-x-4 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
          <dt class="truncate font-medium text-zinc-900 dark:text-zinc-100" title={field.key}>{field.label}</dt>
          <dd class="min-w-0 text-zinc-600 dark:text-zinc-400"><LeafValue node={field.node} /></dd>
        </div>
      {:else if field.node.kind === "object" && field.node.fields.length > 4 && depth > 0}
        <div class="grid gap-x-4 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
          <dt class="truncate font-medium text-zinc-900 dark:text-zinc-100" title={field.key}>{field.label}</dt>
          <dd class="min-w-0 text-zinc-600 dark:text-zinc-400">
            <Disclosure summaryClass="-mx-1 px-1 hover:bg-zinc-950/2.5 dark:hover:bg-white/5">
              {#snippet summary()}{field.node.kind === "object" ? field.node.fields.length : 0} fields{/snippet}
              <StructuredView node={field.node} depth={depth + 1} class="mt-1 border-l border-zinc-950/10 pl-3 dark:border-white/10" />
            </Disclosure>
          </dd>
        </div>
      {:else}
        <div class="grid gap-1">
          <dt class="font-medium text-zinc-900 dark:text-zinc-100" title={field.key}>{field.label}</dt>
          <dd class={["min-w-0 text-zinc-600 dark:text-zinc-400", field.node.kind !== "long" && "border-l border-zinc-950/10 pl-3 dark:border-white/10"]}>
            {#if field.node.kind === "long"}<LeafValue node={field.node} />{:else}<StructuredView node={field.node} depth={depth + 1} />{/if}
          </dd>
        </div>
      {/if}
    {/each}
  </dl>
{:else if node.kind === "list"}
  <div class={["grid gap-1.5 text-base/6 sm:text-sm/6", className]}>
    {#if node.items.length === 0}
      <p class="text-zinc-400 dark:text-zinc-500">None</p>
    {:else if scalarList}
      <ul role="list" class="grid gap-0.5 text-zinc-600 dark:text-zinc-400">
        {#each items as item, index (index)}<li class="min-w-0"><LeafValue node={item} /></li>{/each}
      </ul>
    {:else}
      <ol role="list" class="grid divide-y divide-zinc-950/5 dark:divide-white/10">
        {#each items as item, index (index)}
          <li class="min-w-0 py-2 first:pt-0 last:pb-0"><StructuredView node={item} depth={depth + 1} /></li>
        {/each}
      </ol>
    {/if}
    {#if node.items.length > LIST_HEAD}
      <div class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        <MoreButton expanded={allItems} onclick={() => (allItems = !allItems)}>{allItems ? "Show fewer" : `Show ${node.items.length - LIST_HEAD} more`}</MoreButton>
      </div>
    {/if}
  </div>
{:else}
  <div class={["min-w-0 text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300", className]}><LeafValue {node} /></div>
{/if}
