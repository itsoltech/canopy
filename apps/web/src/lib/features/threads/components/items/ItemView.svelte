<script lang="ts">
  import type { Snippet } from "svelte";
  import { ItemStatus, type Item } from "@open-agents/contracts";
  import AgentBusCallView from "./AgentBusCallView.svelte";
  import AgentMessageView from "./AgentMessageView.svelte";
  import BackgroundTaskView from "./BackgroundTaskView.svelte";
  import ChecklistView from "./ChecklistView.svelte";
  import CommandView from "./CommandView.svelte";
  import CompactionView from "./CompactionView.svelte";
  import FileChangeView from "./FileChangeView.svelte";
  import ImageView from "./ImageView.svelte";
  import InteractionPromptView from "./InteractionPromptView.svelte";
  import ProviderItemView from "./ProviderItemView.svelte";
  import ReasoningView from "./ReasoningView.svelte";
  import SubagentView from "./SubagentView.svelte";
  import ToolCallView from "./ToolCallView.svelte";
  import UserMessageView from "./UserMessageView.svelte";
  import WebSearchView from "./WebSearchView.svelte";

  /**
   * One transcript item (docs/transcript.md); every type has a view. `nested` = its child items.
   * `turnEnded`: its turn is over, so text or output still marked in progress stops streaming (shows in
   * full, no caret).
   */
  let { item, nested, turnEnded = false }: { item: Item; nested?: Snippet | undefined; turnEnded?: boolean } = $props();
  const content = $derived(item.content);
  const streaming = $derived(item.status === ItemStatus.IN_PROGRESS && !turnEnded);
</script>

{#if content.case === "userMessage"}
  <UserMessageView message={content.value} />
{:else if content.case === "agentMessage"}
  <AgentMessageView message={content.value} {streaming} />
{:else if content.case === "reasoning"}
  <ReasoningView reasoning={content.value} {streaming} />
{:else if content.case === "commandExecution"}
  <CommandView command={content.value} status={item.status} {streaming} />
{:else if content.case === "fileChange"}
  <FileChangeView change={content.value} status={item.status} />
{:else if content.case === "toolCall"}
  <ToolCallView call={content.value} status={item.status} {streaming} />
{:else if content.case === "webSearch"}
  <WebSearchView search={content.value} status={item.status} />
{:else if content.case === "plan"}
  <ChecklistView title="Plan" text={content.value.text} steps={content.value.steps} />
{:else if content.case === "todoList"}
  <ChecklistView title="To do" steps={content.value.items} />
{:else if content.case === "subagent"}
  <SubagentView agent={content.value} status={item.status} {nested} />
{:else if content.case === "backgroundTask"}
  <BackgroundTaskView task={content.value} itemId={item.itemId} status={item.status} />
{:else if content.case === "agentBusCall"}
  <AgentBusCallView call={content.value} status={item.status} />
{:else if content.case === "image"}
  <ImageView image={content.value} status={item.status} />
{:else if content.case === "contextCompaction"}
  <CompactionView compaction={content.value} />
{:else if content.case === "interactionPrompt"}
  <InteractionPromptView prompt={content.value} status={item.status} />
{:else if content.case === "providerItem"}
  <ProviderItemView item={content.value} status={item.status} />
{/if}

{#if nested && content.case !== "subagent"}
  <div class="mt-1 grid gap-1 border-l-2 border-zinc-950/5 pl-3 dark:border-white/10">{@render nested()}</div>
{/if}
