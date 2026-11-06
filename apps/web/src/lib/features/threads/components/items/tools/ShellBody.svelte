<script lang="ts">
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { shellCommand } from "@canopy/domain/tools";
  import ResultText from "./ResultText.svelte";

  /** A shell command that arrives as a tool call: the command (highlighted), then its output streaming in. */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const command = $derived(shellCommand(input));
</script>

{#if command}<CodeView code={command} lang="shellscript" label="Command" max={12} quoteKind="tool_call" />{/if}
<ResultText {call} {status} {streaming} />
