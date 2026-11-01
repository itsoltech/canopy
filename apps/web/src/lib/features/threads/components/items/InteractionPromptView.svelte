<script lang="ts">
  import { InteractionKind, type InteractionPrompt, type ItemStatus } from "@open-agents/contracts";
  import { prettyJson } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import ThreadLink from "./ThreadLink.svelte";

  /** Record of a permission request or question on the timeline: what was asked and who answered. */
  let { prompt, status }: { prompt: InteractionPrompt; status: ItemStatus } = $props();
  const kind = $derived(prompt.kind === InteractionKind.PERMISSION ? "Permission" : prompt.kind === InteractionKind.QUESTION ? "Question" : "Form");
</script>

<ItemFrame icon={prompt.kind === InteractionKind.PERMISSION ? "shield-check" : "question-mark-circle"} {status}>
  {#snippet title()}
    <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span class="shrink-0">{kind}</span>
      <span class="truncate font-medium text-zinc-950 dark:text-white">{prompt.toolName}</span>
      {#if prompt.answeredByThreadId}
        <span class="text-zinc-500 dark:text-zinc-400">answered by</span><ThreadLink threadId={prompt.answeredByThreadId} fallback="Parent agent" />
      {:else if prompt.routedTo === "parent" && !prompt.outcome}
        <span class="text-violet-700 dark:text-violet-400">for the parent agent</span>
      {/if}
    </span>
  {/snippet}
  {#snippet aside()}
    <StatusBadge status={prompt.outcome || "pending"} />
  {/snippet}
  <CodeBlock text={prettyJson(prompt.requestJson)} label="Request" />
  {#if prompt.responseJson}<CodeBlock text={prettyJson(prompt.responseJson)} label="Response" />{/if}
</ItemFrame>
