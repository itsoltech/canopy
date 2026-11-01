<script lang="ts">
  import type { ItemStatus, ProviderItem } from "@open-agents/contracts";
  import { prettyJson } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import ItemFrame from "./ItemFrame.svelte";

  /** Provider event without a dedicated view: its type and full JSON. */
  let { item, status }: { item: ProviderItem; status: ItemStatus } = $props();
</script>

<ItemFrame icon="ellipsis-horizontal" {status}>
  {#snippet title()}<span class="flex min-w-0 gap-1.5"><span class="shrink-0">Provider event</span><code class="truncate font-mono text-[0.8125rem]">{item.type}</code></span>{/snippet}
  <CodeBlock text={prettyJson(item.json)} label="Provider event {item.type}" />
</ItemFrame>
