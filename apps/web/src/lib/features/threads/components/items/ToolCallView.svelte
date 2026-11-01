<script lang="ts">
  import { ItemStatus, type ToolCall } from "@open-agents/contracts";
  import { parseObject, prettyJson } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import OutputBlock from "./OutputBlock.svelte";

  /** Built-in, MCP or dynamic tool: name, a one-line hint of the input, full input and result inside. */
  let { call, status }: { call: ToolCall; status: ItemStatus } = $props();

  // The first short string argument usually says what the call is about (path, pattern, query).
  const hint = $derived(Object.values(parseObject(call.inputJson)).find((v): v is string => typeof v === "string" && v.length > 0 && v.length < 200) ?? "");
  const failed = $derived(call.isError || status === ItemStatus.FAILED);
</script>

<ItemFrame icon={call.server ? "code-bracket" : "wrench"} {status} tone={failed ? "rose" : "neutral"} defaultOpen={failed}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0 font-medium text-zinc-950 dark:text-white">
        {#if call.server}<span class="font-normal text-zinc-500 dark:text-zinc-400">{call.server} › </span>{/if}{call.name}
      </span>
      {#if hint}<span class="truncate font-mono text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{hint}</span>{/if}
    </span>
  {/snippet}
  {#snippet aside()}
    {#if call.isError && status !== ItemStatus.FAILED}<span class="text-rose-700 dark:text-rose-400">Error</span>{/if}
  {/snippet}
  {#if call.inputJson && call.inputJson !== "{}"}
    <CodeBlock text={prettyJson(call.inputJson)} label="Input of {call.name}" />
  {/if}
  <OutputBlock output={call.output} blob={call.outputBlob} label="Result of {call.name}" empty={status === ItemStatus.IN_PROGRESS ? "Waiting for the result…" : "No result."} />
</ItemFrame>
