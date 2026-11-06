<script lang="ts">
  import BotSenderLabel from "./BotSenderLabel.svelte";
  import type { BlobRef, ui } from "@canopy/contracts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { turnOrigin } from "@canopy/domain/turn-origin";
  import BackgroundNoteRow from "./BackgroundNoteRow.svelte";
  import ThreadLink from "./items/ThreadLink.svelte";
  import UserMessageView from "./items/UserMessageView.svelte";
  import AgentMessageBubble from "./items/AgentMessageBubble.svelte";
  import AgentSenderLabel from "./AgentSenderLabel.svelte";
  import ShellMessage from "./ShellMessage.svelte";

  /**
   * The input of a turn with where it came from (the turn's source): you (a plain message), another
   * agent (a task or a message, violet, naming the sender's thread and what it runs on: AgentSenderLabel), a report from a thread it follows, a side thread's question, or a
   * schedule (yours or one an agent set). `hops` (agent-to-agent steps since a person wrote) shows when
   * an agent chain started the turn. Queued turns are not shown here: the queue panel has them.
   */
  let { turn, text, attachments = [] }: { turn: ui.Turn; text: string; attachments?: readonly BlobRef[] } = $props();

  const directory = useThreadDirectory();
  const origin = $derived(turnOrigin(turn));

  const senderLine = $derived(
    origin.kind === "task" ||
      origin.kind === "message" ||
      origin.kind === "report" ||
      (origin.kind === "answer" && Boolean(origin.threadId) && !turn.botId),
  );

  // The platform's note (where the input comes from) and the delivered content, kept apart by the gateway.
  const parts = $derived({ note: turn.platformNote, message: turn.messageText });
  const tone = $derived(origin.kind === "question" ? "amber" : origin.kind === "schedule" ? "sky" : "violet");

  const icons = new Map<string, IconName>([
    ["task", "sparkles"],
    ["message", "chat-bubble-left-right"],
    ["report", "document-text"],
    ["question", "hand-raised"],
    ["schedule", "clock"],
    ["answer", "chat-bubble-left-right"],
  ]);

  const triggerLabels = new Map<string, string>([
    ["agent_bus", "From an agent"],
    ["interaction", "A side thread is waiting"],
    ["schedule", "Scheduled"],
    ["goal", "Goal"],
  ]);

  // A message from another agent (a task, a message, a report, an answer from a thread) folds to its first line.
  const fromAgent = $derived(
    origin.kind === "task" ||
      origin.kind === "message" ||
      origin.kind === "report" ||
      (origin.kind === "answer" && Boolean(origin.threadId) && !turn.botId),
  );
</script>

{#if turn.shellCommand !== undefined}
  <ShellMessage command={turn.shellCommand} result={turn.shellResult} text={turn.inputText} status={turn.status} />
{:else if origin.kind === "background_task"}
  <!-- The platform's note about ended background tasks: a system line, not a message. -->
  <BackgroundNoteRow itemIds={origin.itemIds} />
{:else if origin.kind === "user"}
  <!-- With attachments, mentions or quotes the agent got a platform note (file paths, threads, the quoted passages) or a
       reordered command: the message shows as written, with its files, chips and quotes, and the full text folds. -->
  {@const rich = turn.attachments.length > 0 || turn.mentions.length > 0 || turn.quotes.length > 0}
  <UserMessageView
    message={{
      text: rich ? parts.message : text,
      authorAgentId: "",
      attachments: [...attachments],
      mentions: turn.mentions,
    }}
    files={turn.attachments}
    quotes={turn.quotes}
  />
{:else}
  <div class="flex flex-col items-end gap-1">
    <p
      class={[
        "flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-sm/5 sm:text-xs/5",
        tone === "amber"
          ? "text-amber-700 dark:text-amber-400"
          : tone === "sky"
            ? "text-sky-700 dark:text-sky-400"
            : "text-violet-700 dark:text-violet-400",
      ]}
    >
      {#if !senderLine && !turn.botId}{@render sourceIcon()}{/if}
      {#if senderLine}
        <AgentSenderLabel
          verb={origin.kind === "task"
            ? "Task from"
            : origin.kind === "report"
              ? "Report from"
              : origin.kind === "answer"
                ? "Answer from"
                : "Message from"}
          threadId={turn.sourceThreadId}
          sender={turn.sender}
          fallback={origin.kind === "report" ? "a thread it follows" : "another thread"}
          leading={turn.botId ? undefined : sourceIcon}
          trailing={turn.hops > 0 ? hops : undefined}
        />
      {:else if origin.kind === "answer"}
        {#if turn.botId}
          <BotSenderLabel verb="Answer from" botId={turn.botId} />
        {:else}
          Your answer
        {/if}
      {:else if origin.kind === "question"}
        <ThreadLink threadId={origin.threadId} fallback="A side thread" /> is waiting for an answer
      {:else if origin.kind === "schedule"}
        {#if !origin.setBy}
          Scheduled task you set
        {:else if origin.setBy === directory.currentId}
          Scheduled task its agent set
        {:else}
          Scheduled task set in <ThreadLink threadId={origin.setBy} fallback="another thread" />
        {/if}
      {:else if turn.botId}
        <BotSenderLabel botId={turn.botId} />
      {:else if origin.kind === "other"}
        {triggerLabels.get(origin.trigger) ?? origin.trigger}
      {/if}
      {#if turn.hops > 0 && !senderLine}{@render hops()}{/if}
    </p>
    {#if fromAgent}
      <AgentMessageBubble
        text={parts.message || "(no message)"}
        label={origin.kind === "report" ? "Show the whole report" : undefined}
        class="min-w-0"
      >
        <Markdown
          text={parts.message || "(no message)"}
          breaks={origin.kind !== "report"}
          class="text-inherit dark:text-inherit"
        />
      </AgentMessageBubble>
    {:else}
      <div
        class={[
          "max-w-[min(85%,42rem)] min-w-0 rounded-2xl rounded-br-md px-4 py-2.5 text-base/6 break-words ring-1 ring-inset sm:text-sm/6",
          tone === "amber"
            ? "bg-amber-50 text-amber-950 ring-amber-600/15 dark:bg-amber-400/10 dark:text-amber-50 dark:ring-amber-400/20"
            : tone === "sky"
              ? "bg-sky-50 text-sky-950 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-50 dark:ring-sky-400/20"
              : "bg-violet-50 text-violet-950 ring-violet-600/10 dark:bg-violet-400/10 dark:text-violet-50 dark:ring-violet-400/20",
        ]}
      >
        {#if origin.kind === "question"}
          <p>The agent here answers it; you can answer in the side thread instead.</p>
        {:else}
          <Markdown text={parts.message} breaks class="text-inherit dark:text-inherit" />
        {/if}
        <!-- What the platform added for the agent (notes on mentions, quotes, files, the source) stays out of
             sight; only a side thread's question shows its request, since the bubble does not carry it. -->
        {#if parts.note && origin.kind === "question"}
          <Disclosure remember="full-text" class="mt-2" summaryClass="text-sm/6 opacity-80 sm:text-xs/6">
            {#snippet summary()}Request sent to the agent{/snippet}
            <CodeBlock {text} label="Request sent to the agent" class="mt-2" />
          </Disclosure>
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#snippet sourceIcon()}
  <Icon name={icons.get(origin.kind) ?? "sparkles"} tone="inherit" class="size-3.5 shrink-0" />
{/snippet}

{#snippet hops()}
  <span
    class="shrink-0 whitespace-nowrap text-zinc-500 tabular-nums dark:text-zinc-400"
    title="Agent-to-agent steps since a person last wrote; a chain stops at the limit"
  >
    · {turn.hops}
    {turn.hops === 1 ? "hop" : "hops"}
  </span>
{/snippet}
