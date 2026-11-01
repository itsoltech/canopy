<script lang="ts">
  import type { BlobRef, ui } from "@open-agents/contracts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { turnOrigin } from "../turn-origin.ts";
  import ThreadLink from "./items/ThreadLink.svelte";
  import UserMessageView from "./items/UserMessageView.svelte";

  /**
   * The input of a turn with where it came from: you (a plain message), another agent (a task or a
   * message), a report from a side thread, a side thread's question, or a scheduled wake-up.
   * `hops` (agent-to-agent steps since a person wrote) shows when an agent chain started the turn.
   */
  let { turn, text, attachments = [], queued = false }: { turn: ui.Turn; text: string; attachments?: readonly BlobRef[]; queued?: boolean } = $props();

  const origin = $derived(turnOrigin(turn.trigger, text));
  const tone = $derived(origin.kind === "question" ? "amber" : origin.kind === "schedule" ? "sky" : "violet");
  const icon = $derived.by<IconName>(() => {
    if (origin.kind === "question") return "hand-raised";
    if (origin.kind === "schedule") return "clock";
    if (origin.kind === "report") return origin.status === "completed" ? "check-circle" : origin.status === "failed" ? "x-circle" : "stop";
    return "sparkles";
  });
  const finished: Record<string, string> = { completed: "finished", failed: "failed", interrupted: "was interrupted", cancelled: "was cancelled" };
  const asks: Record<string, string> = { permission: "asks for approval", question: "has a question", form: "needs details" };
  const fallback: Record<string, string> = { agent_bus: "From an agent", interaction: "A side thread is waiting", schedule: "Scheduled", goal: "Goal" };

  // Long reports (a side thread's whole answer) start folded.
  const long = $derived(origin.kind === "report" && (origin.body.length > 900 || origin.body.split("\n").length > 14));
  let expanded = $state(false);
</script>

{#if origin.kind === "user"}
  <UserMessageView message={{ text, authorAgentId: "", attachments: [...attachments] }} {queued} />
{:else}
  <div class="flex flex-col items-end gap-1">
    <p
      class={[
        "flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-sm/5 sm:text-xs/5",
        tone === "amber" ? "text-amber-700 dark:text-amber-400" : tone === "sky" ? "text-sky-700 dark:text-sky-400" : "text-violet-700 dark:text-violet-400",
      ]}
    >
      <Icon name={icon} class="size-3.5" />
      {#if origin.kind === "task"}
        Task from <ThreadLink threadId={origin.threadId} fallback={origin.title} />
      {:else if origin.kind === "message"}
        Message from <ThreadLink threadId={origin.threadId} fallback={origin.title} />
      {:else if origin.kind === "report"}
        <ThreadLink threadId={origin.threadId} fallback={origin.title} /> {finished[origin.status] ?? origin.status}
      {:else if origin.kind === "question"}
        <ThreadLink threadId={origin.threadId} fallback={origin.title} /> {asks[origin.request] ?? "is waiting for an answer"}
      {:else if origin.kind === "schedule"}
        {origin.label}{origin.delayed ? " (ran late)" : ""}
      {:else}
        {fallback[origin.trigger] ?? origin.trigger}
      {/if}
      {#if turn.hops > 0}
        <span class="text-zinc-500 tabular-nums dark:text-zinc-400" title="Agent-to-agent steps since a person last wrote; a chain stops at the limit">
          · {turn.hops} {turn.hops === 1 ? "hop" : "hops"}
        </span>
      {/if}
      {#if queued}<span class="text-zinc-500 dark:text-zinc-400">· queued</span>{/if}
    </p>
    <div
      class={[
        "max-w-[min(85%,42rem)] min-w-0 rounded-2xl rounded-br-md px-4 py-2.5 text-base/6 break-words ring-1 ring-inset sm:text-sm/6",
        tone === "amber"
          ? "bg-amber-50 text-amber-950 ring-amber-600/15 dark:bg-amber-400/10 dark:text-amber-50 dark:ring-amber-400/20"
          : tone === "sky"
            ? "bg-sky-50 text-sky-950 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-50 dark:ring-sky-400/20"
            : "bg-violet-50 text-violet-950 ring-violet-600/10 dark:bg-violet-400/10 dark:text-violet-50 dark:ring-violet-400/20",
        queued && "opacity-70",
      ]}
    >
      {#if origin.kind === "report"}
        <div class={["grid", long && !expanded && "max-h-64 overflow-hidden mask-b-from-50%"]}>
          <Markdown text={origin.body || "(no message)"} />
        </div>
        {#if long}
          <button type="button" class="mt-1 rounded-md text-sm/6 font-medium text-violet-700 hover:text-violet-900 focus-ring sm:text-xs/6 dark:text-violet-300 dark:hover:text-violet-100" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
            {expanded ? "Show less" : "Show the whole report"}
          </button>
        {/if}
      {:else if origin.kind === "question"}
        <p>{origin.tool ? `Wants to use ${origin.tool}.` : "Waits for an answer."} The agent here answers it; you can answer in the side thread instead.</p>
        <Disclosure class="mt-2" summaryClass="text-sm/6 sm:text-xs/6">
          {#snippet summary()}Request sent to the agent{/snippet}
          <CodeBlock text={origin.body} label="Request sent to the agent" class="mt-2" />
        </Disclosure>
      {:else}
        <p class="whitespace-pre-wrap">{origin.body}</p>
      {/if}
    </div>
  </div>
{/if}
