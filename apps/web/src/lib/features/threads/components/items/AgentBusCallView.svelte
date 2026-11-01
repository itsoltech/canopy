<script lang="ts">
  import { ItemStatus, type AgentBusCall } from "@open-agents/contracts";
  import { parseObject, prettyJson, str } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import ThreadLink from "./ThreadLink.svelte";

  /**
   * A call on the agent bus (docs/agent-bus.md): starting or messaging another thread, waiting for
   * threads, answering interactions, schedules, goals. Violet marks agent-to-agent activity.
   */
  let { call, status }: { call: AgentBusCall; status: ItemStatus } = $props();

  const labels: Record<string, string> = {
    spawn_thread: "Started a side thread",
    send_message: "Sent a message",
    wait_threads: "Waiting for threads",
    get_thread: "Checked a thread",
    read_thread: "Read a thread",
    list_threads: "Listed threads",
    interrupt_thread: "Interrupted a thread",
    close_thread: "Closed a thread",
    list_interactions: "Listed pending questions",
    answer_interaction: "Answered for a side thread",
    list_agents: "Listed agents",
    schedule_wakeup: "Scheduled a wake-up",
    schedule_recurring: "Scheduled a recurring run",
    list_schedules: "Listed schedules",
    cancel_schedule: "Cancelled a schedule",
    get_goal: "Checked the goal",
    propose_goal: "Proposed a goal",
    update_goal: "Updated the goal",
  };
  const args = $derived(parseObject(call.argumentsJson));
  const prompt = $derived(str(args["prompt"]));
  const waitingFor = $derived(Array.isArray(args["thread_ids"]) ? (args["thread_ids"] as unknown[]).filter((id): id is string => typeof id === "string") : []);
  // The spawned thread: target_thread_id when the gateway sets it, otherwise the result (spawn_thread) or the arguments.
  const target = $derived(call.targetThreadId || str(parseObject(call.resultJson)["thread_id"]) || str(args["thread_id"]));
</script>

<ItemFrame icon="sparkles" tone={call.isError ? "rose" : "violet"} {status} defaultOpen={call.isError}>
  {#snippet title()}
    <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span class="font-medium text-violet-800 dark:text-violet-300">{labels[call.toolName] ?? call.toolName}</span>
      {#if target}
        <ThreadLink threadId={target} fallback={str(args["title"]) || "Side thread"} />
      {:else}
        {#each waitingFor as id (id)}<ThreadLink threadId={id} />{/each}
      {/if}
    </span>
  {/snippet}
  {#snippet aside()}
    {#if call.isError && status !== ItemStatus.FAILED}<span class="text-rose-700 dark:text-rose-400">Refused</span>{/if}
  {/snippet}
  {#if prompt}
    <div class="rounded-lg bg-violet-50/60 p-3 ring-1 ring-violet-600/10 ring-inset dark:bg-violet-400/5 dark:ring-violet-400/15">
      <p class="mb-1 text-sm/5 font-medium text-violet-800 sm:text-xs/5 dark:text-violet-300">Prompt</p>
      <Markdown text={prompt} />
    </div>
  {/if}
  <CodeBlock text={prettyJson(call.argumentsJson) || "{}"} label="Arguments of {call.toolName}" />
  {#if call.resultJson}<CodeBlock text={prettyJson(call.resultJson)} label="Result of {call.toolName}" />{/if}
</ItemFrame>
