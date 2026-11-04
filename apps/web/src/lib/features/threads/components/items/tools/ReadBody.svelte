<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import type { ToolBodyProps } from "./body.ts";
  import { parseNumberedLines } from "./parse.ts";
  import ResultText from "./ResultText.svelte";

  /** Claude Read: the full path, then the lines it read, highlighted by file type and numbered as in the file. */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const path = $derived(str(input["file_path"]));
  const file = $derived(call.isError ? undefined : parseNumberedLines(call.output));
</script>

<p class="truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400" title={path}>{path}</p>
{#if file}
  <CodeView
    code={file.lines.join("\n")}
    start={file.start}
    lang={languageOfPath(path)}
    label="Lines of {path}"
    quoteKind="tool_call"
  />
{:else if call.images.length === 0}
  <ResultText {call} {status} {streaming} />
{/if}
