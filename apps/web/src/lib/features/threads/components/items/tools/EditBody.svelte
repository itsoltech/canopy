<script lang="ts">
  import FileDiffEntry from "../FileDiffEntry.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { toolChanges } from "./changes.ts";
  import ResultText from "./ResultText.svelte";

  /**
   * File edits that arrive as tool calls (Write, Edit, MultiEdit, NotebookEdit, Codex apply_patch): each file
   * with its diff, as file changes show. The result is shown only when it failed (otherwise it just says
   * the file was updated).
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();

  const files = $derived(toolChanges(call.name, input));
</script>

{#each files as file, index (index)}
  <FileDiffEntry path={file.path} kind={file.kind} movePath={file.movePath} diff={file.diff} />
{/each}
{#if call.isError || files.length === 0}
  <ResultText {call} {status} {streaming} />
{/if}
