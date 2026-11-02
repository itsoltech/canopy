<script lang="ts">
  import { ItemStatus } from "@open-agents/contracts";
  import ItemFrame from "./ItemFrame.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import ChecklistSteps from "./ChecklistSteps.svelte";

  /** Plan steps or a todo list; the completed count stays in the collapsed header. */
  let { title, text = "", steps, status = ItemStatus.COMPLETED }: { title: string; text?: string; steps: readonly { text: string; status: string }[]; status?: ItemStatus } = $props();
  const done = $derived(steps.filter((s) => s.status === "completed").length);
</script>

<ItemFrame icon="queue-list" {status}>
  {#snippet title()}<span class="text-zinc-800 dark:text-zinc-200">{title}</span>{/snippet}
  {#snippet aside()}{#if steps.length > 0}<span>{done} of {steps.length} done</span>{/if}{/snippet}
  {#if text}<Markdown {text} class="mt-2" />{/if}
  {#if steps.length > 0}<ChecklistSteps {steps} class="mt-3" />{/if}
</ItemFrame>
