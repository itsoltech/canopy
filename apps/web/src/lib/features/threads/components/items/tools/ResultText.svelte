<script lang="ts">
  import { ItemStatus, type ToolCall } from "@open-agents/contracts";
  import { isEmptyNode, structureJson } from "#lib/shared/structure.ts";
  import OutputBlock from "../OutputBlock.svelte";
  import ErrorText from "./ErrorText.svelte";
  import { stripReminders, unwrapContent } from "./parse.ts";
  import StructuredView from "./StructuredView.svelte";

  /**
   * A tool's result when no special view applies: an error as a sentence in red, JSON as a structured
   * view, text as output (streamed line by line while it runs, collapsed when long).
   */
  let { call, status, streaming = false }: { call: ToolCall; status: ItemStatus; streaming?: boolean } = $props();
  const text = $derived(stripReminders(unwrapContent(call.output)));
  const node = $derived(streaming ? undefined : structureJson(text));
</script>

{#if call.isError && text}
  <ErrorText {text} />
{:else if node && (node.kind === "object" || node.kind === "list") && !isEmptyNode(node)}
  <StructuredView {node} />
{:else}
  <OutputBlock quoteKind="tool_call" output={text} blob={call.outputBlob} label="Result of {call.name}" empty={status === ItemStatus.IN_PROGRESS ? "Waiting for the result…" : "No result."} {streaming} />
{/if}
