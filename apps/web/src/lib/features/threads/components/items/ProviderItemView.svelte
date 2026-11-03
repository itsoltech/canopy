<script lang="ts">
  import type { ItemStatus, ProviderItem } from "@canopy/contracts";
  import { humanizeEnum } from "#lib/shared/humanize.ts";
  import { structureJson } from "#lib/shared/structure.ts";
  import ItemFrame from "./ItemFrame.svelte";
  import RawToggle from "./tools/RawToggle.svelte";
  import StructuredView from "./tools/StructuredView.svelte";

  /** Provider event without a dedicated view: its type in words and its fields; the JSON behind "Show raw". */
  let { item, status }: { item: ProviderItem; status: ItemStatus } = $props();
  const node = $derived(structureJson(item.json));
</script>

<ItemFrame icon="ellipsis-horizontal" {status}>
  {#snippet title()}<span class="flex min-w-0 gap-1.5"><span class="shrink-0">Provider event</span><span class="truncate text-zinc-800 dark:text-zinc-200" title={item.type}>{humanizeEnum(item.type) || "Unknown"}</span></span>{/snippet}
  <StructuredView {node} />
  <RawToggle parts={[{ label: "Event", text: item.json }]} />
</ItemFrame>
