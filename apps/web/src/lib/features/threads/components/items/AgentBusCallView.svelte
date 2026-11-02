<script lang="ts">
  import { ItemStatus, type AgentBusCall } from "@open-agents/contracts";
  import { parseObject, str } from "#lib/shared/format.ts";
  import { humanizeSeconds, plural } from "#lib/shared/humanize.ts";
  import { structure, structureJson } from "#lib/shared/structure.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import LongText from "#lib/shared/ui/LongText.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import AgentWell from "./AgentWell.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import MessageDeliveryCard from "./MessageDeliveryCard.svelte";
  import SubagentCard from "./SubagentCard.svelte";
  import ThreadLink from "./ThreadLink.svelte";
  import { agentsOf, busError, busLook, deliveryOf, interactionsOf, scheduleOf, schedulesOf, summariesOf, transcriptOf } from "./tools/agent-bus.ts";
  import MiniTranscript from "./tools/bus/MiniTranscript.svelte";
  import ScheduleSummary from "./tools/bus/ScheduleSummary.svelte";
  import ThreadSummaryList from "./tools/bus/ThreadSummaryList.svelte";
  import EmptyNote from "./tools/EmptyNote.svelte";
  import ErrorText from "./tools/ErrorText.svelte";
  import RawToggle from "./tools/RawToggle.svelte";
  import Section from "./tools/Section.svelte";
  import StructuredView from "./tools/StructuredView.svelte";

  /**
   * A call on the agent bus (docs/agent-bus.md): starting or messaging another thread, waiting for
   * threads, reading them, answering interactions, schedules. Violet marks agent-to-agent activity. Each
   * tool reads as a sentence with the threads it is about as links, and opens to its result in a shape
   * made for it (thread statuses, a short transcript, a schedule in words); arguments and result as sent
   * stay behind "Show raw". A started subagent also gets a card that follows the child thread live; a sent
   * message one that follows the turn it reached (MessageDeliveryCard), in place of the link in the title.
   */
  let { call, status }: { call: AgentBusCall; status: ItemStatus } = $props();

  const tool = $derived(call.toolName);
  const args = $derived(parseObject(call.argumentsJson));
  const result = $derived(parseObject(call.resultJson));
  const running = $derived(status === ItemStatus.IN_PROGRESS);
  const look = $derived(busLook(tool, args, running, call.isError));
  const failed = $derived(call.isError || status === ItemStatus.FAILED);
  const directory = useThreadDirectory();
  // The thread it is about: target_thread_id when the gateway sets it, otherwise the result (spawn_thread) or the arguments.
  const target = $derived(call.targetThreadId || str(result["thread_id"]) || str(args["thread_id"]));
  const subagent = $derived(tool === "spawn_thread" && !call.isError && target !== "");
  const message = $derived(tool === "send_message" && !call.isError && target !== "" && call.resultJson !== "");
  const waitingFor = $derived(Array.isArray(args["thread_ids"]) ? (args["thread_ids"] as unknown[]).filter((id): id is string => typeof id === "string") : []);
  const titled = new Set(["send_message", "get_thread", "read_thread", "interrupt_thread", "close_thread"]);
  const spawned = $derived({
    provider: str(result["provider"]) || str(args["provider"]),
    model: str(result["model"]) || str(args["model"]),
    effort: str(result["effort"]) || str(args["effort"]),
    permissionMode: str(result["permission_mode"]) || str(args["permission_mode"]),
  });

  const threads = $derived(summariesOf(tool, result));
  const transcript = $derived(tool === "read_thread" ? transcriptOf(result) : []);
  const detail = $derived.by(() => {
    if (failed || running) return "";
    if (tool === "read_thread") return plural(transcript.length, "entry", "entries");
    if (tool === "wait_threads") return result["done"] === false ? "Still working" : threads.length > 0 ? "Done" : "";
    if (tool === "list_threads") return plural(threads.length, "thread");
    return "";
  });
  // Interrupting, closing and cancelling say all in their title; the rest open to their details.
  const hasBody = $derived(failed || !["interrupt_thread", "close_thread", "cancel_schedule"].includes(tool));
  const known = new Set(["spawn_thread", "send_message", "wait_threads", "get_thread", "read_thread", "list_threads", "list_interactions", "answer_interaction", "list_agents", "schedule_wakeup", "schedule_recurring", "list_schedules"]);
</script>

{#snippet title()}
  <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
    <span class="font-medium text-violet-800 dark:text-violet-300">{look.title}</span>
    {#if titled.has(tool) && target && !message}
      <ThreadLink threadId={target} fallback={str(args["title"]) || "Side thread"} />
    {:else if tool === "wait_threads"}
      {#each waitingFor as id (id)}<ThreadLink threadId={id} />{/each}
    {/if}
  </span>
{/snippet}
{#snippet aside()}
  {#if detail}<span class="max-sm:hidden">{detail}</span>{/if}
  {#if call.isError && status !== ItemStatus.FAILED}<span class="text-rose-700 dark:text-rose-400">Refused</span>{/if}
{/snippet}

{#snippet well(label: string, text: string)}
  <AgentWell>
    <p class="mb-1 text-sm/5 font-medium text-violet-800 sm:text-xs/5 dark:text-violet-300">{label}</p>
    <Markdown {text} />
  </AgentWell>
{/snippet}

{#snippet facts(lines: (string | false | undefined)[])}
  {@const shown = lines.filter((l): l is string => typeof l === "string" && l !== "")}
  {#if shown.length > 0}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{shown.join(" · ")}</p>{/if}
{/snippet}

{#snippet body()}
  {#if call.isError}
    <ErrorText text={busError(call.resultJson, tool) || "The call was refused."} />
  {/if}
  {#if tool === "spawn_thread"}
    {#if str(args["prompt"])}{@render well("Prompt", str(args["prompt"]))}{/if}
    {#if str(args["instructions"])}<Section label="Instructions"><LongText text={str(args["instructions"])} markdown lines={4} /></Section>{/if}
    {@render facts([
      args["fork"] === true && "Starts from this thread's history",
      str(args["interactions"]) === "human" ? "Its questions go to you" : "Its questions come to this agent",
      args["notify"] === false && "No message when it finishes",
    ])}
  {:else if tool === "send_message"}
    {#if str(args["prompt"])}{@render well("Message", str(args["prompt"]))}{/if}
    {#if !call.isError && !running}{@render facts([deliveryOf(args, result), args["notify"] === false && "No message when it finishes"])}{/if}
  {:else if tool === "wait_threads"}
    {@render facts([
      str(args["until"]) === "all" ? "Until all finish" : waitingFor.length > 1 ? "Until one finishes" : "",
      typeof args["timeout_seconds"] === "number" && `At most ${humanizeSeconds(args["timeout_seconds"])}`,
      result["done"] === false && "Stopped waiting; still working",
    ])}
    {#if threads.length > 0}<ThreadSummaryList {threads} />{/if}
  {:else if tool === "get_thread" || tool === "list_threads"}
    {#if threads.length > 0}
      <ThreadSummaryList {threads} />
    {:else if !running && !call.isError}
      <EmptyNote>No subagents yet.</EmptyNote>
    {/if}
  {:else if tool === "read_thread"}
    {@render facts([
      str(args["view"]) === "items" && "Messages and every tool call",
      typeof args["limit"] === "number" && `Up to ${plural(args["limit"], "entry", "entries")}`,
      typeof args["after_seq"] === "number" && args["after_seq"] > 0 && "Only what came after its last read",
    ])}
    {#if transcript.length > 0}
      <MiniTranscript lines={transcript} />
    {:else if !running && !call.isError}
      <EmptyNote>Nothing new in that thread.</EmptyNote>
    {/if}
    {#if target}
      <p class="text-sm/5 sm:text-xs/5">
        <a href="/threads/{target}" class="inline-flex items-center gap-1 font-medium text-violet-800 hover:underline focus-ring dark:text-violet-300">Open thread<Icon name="chevron-right" class="size-3.5 fill-current" /></a>
      </p>
    {/if}
  {:else if tool === "list_interactions"}
    {@const interactions = interactionsOf(result)}
    {#if interactions.length === 0 && !running && !call.isError}
      <EmptyNote>Nothing is waiting for an answer.</EmptyNote>
    {/if}
    <ul role="list" class="grid divide-y divide-zinc-950/5 dark:divide-white/10">
      {#each interactions as interaction, index (index)}
        <li class="grid gap-1.5 py-2 first:pt-0 last:pb-0">
          <p class="flex min-w-0 flex-wrap items-center gap-1.5 text-base/6 sm:text-sm/6">
            <Badge tone="amber">{interaction.kind}</Badge>
            <span class="font-medium text-zinc-950 dark:text-white">{interaction.tool}</span>
            {#if interaction.threadId}<span class="text-zinc-500 dark:text-zinc-400">from</span><ThreadLink threadId={interaction.threadId} fallback="Side thread" />{/if}
          </p>
          <StructuredView node={structure(interaction.request)} />
        </li>
      {/each}
    </ul>
  {:else if tool === "answer_interaction"}
    {#if str(args["message"])}<Section label="Message"><LongText text={str(args["message"])} lines={4} /></Section>{/if}
    {#if str(args["answer_json"])}<Section label="Answer"><StructuredView node={structureJson(str(args["answer_json"]))} /></Section>{/if}
    {#if str(result["status"])}{@render facts([`The question is now ${statusLook(str(result["status"])).label.toLowerCase()}`])}{/if}
  {:else if tool === "list_agents"}
    {@const agents = agentsOf(result)}
    {#if agents.length > 0}
      <ul role="list" class="grid gap-1.5 text-base/6 sm:text-sm/6">
        {#each agents as agent (agent.name)}
          <li class="grid min-w-0">
            <p class="font-medium text-zinc-950 dark:text-white">{agent.name}{#if agent.settings}<span class="font-normal text-zinc-500 dark:text-zinc-400"> · {agent.settings}</span>{/if}</p>
            {#if agent.description}<p class="text-zinc-600 dark:text-zinc-400">{agent.description}</p>{/if}
          </li>
        {/each}
      </ul>
    {:else if !running && !call.isError}
      <EmptyNote>No providers reported yet: a subagent starts as a copy of this agent.</EmptyNote>
    {/if}
  {:else if tool === "schedule_wakeup" || tool === "schedule_recurring"}
    {@const schedule = scheduleOf(args, result)}
    <ScheduleSummary {schedule} />
    {#if schedule.threadId && schedule.threadId !== directory.currentId}
      <p class="flex items-center gap-1.5 pl-6 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Runs in <ThreadLink threadId={schedule.threadId} fallback="Side thread" /></p>
    {/if}
  {:else if tool === "list_schedules"}
    {@const schedules = schedulesOf(result)}
    {#if schedules.length === 0 && !running && !call.isError}
      <EmptyNote>No schedules.</EmptyNote>
    {/if}
    <ul role="list" class="grid divide-y divide-zinc-950/5 dark:divide-white/10">
      {#each schedules as schedule, index (index)}<li class="py-2 first:pt-0 last:pb-0"><ScheduleSummary {schedule} /></li>{/each}
    </ul>
  {:else if !known.has(tool)}
    <Section label="Arguments"><StructuredView node={structure(args)} /></Section>
    {#if !call.isError}<Section label="Result"><StructuredView node={structureJson(call.resultJson)} /></Section>{/if}
  {/if}
  <RawToggle
    parts={[
      { label: "Arguments", text: call.argumentsJson === "{}" ? "" : call.argumentsJson },
      { label: "Result", text: call.resultJson },
    ]}
  />
  {#if subagent}
    <SubagentCard threadId={target} title={str(args["title"]) || "Subagent"} {spawned} />
  {/if}
  {#if message}
    <MessageDeliveryCard callId={call.callId} threadId={target} sentDelivery={str(result["delivery"])} />
  {/if}
{/snippet}

{#if hasBody}
  <ItemFrame icon={look.icon} tone={call.isError ? "rose" : "violet"} {status} {title} {aside}>{@render body()}</ItemFrame>
{:else}
  <ItemFrame icon={look.icon} tone={call.isError ? "rose" : "violet"} {status} {title} {aside} />
{/if}
