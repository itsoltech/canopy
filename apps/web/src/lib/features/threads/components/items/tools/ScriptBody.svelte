<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import { humanizeToolName, plural } from "#lib/shared/humanize.ts";
  import { structure } from "#lib/shared/structure.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import OutputBlock from "../OutputBlock.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { parseScriptCalls, parseScriptOutput } from "./parse.ts";
  import ResultText from "./ResultText.svelte";
  import Section from "./Section.svelte";
  import StructuredView from "./StructuredView.svelte";

  /**
   * A Codex code-mode cell: the tools its script calls (commands as `$ …`), the script itself as
   * JavaScript, and what it printed — command output with its exit code, other tools' results as fields.
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const code = $derived(str(input["code"]));
  const calls = $derived(parseScriptCalls(code));
  const result = $derived(streaming ? undefined : parseScriptOutput(call.output));
</script>

{#if calls.length > 0}
  <Section label={calls.length === 1 ? "Calls" : `Calls · ${calls.length}`}>
    <ul role="list" class="grid gap-0.5 text-base/6 sm:text-sm/6">
      {#each calls as entry, index (index)}
        <li class="min-w-0">
          {#if entry.command !== undefined}
            <code class="font-mono text-[0.8125rem] break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200"><span class="text-zinc-400 select-none dark:text-zinc-500">$ </span>{entry.command}</code>
          {:else}
            <span class="text-zinc-700 dark:text-zinc-300">{humanizeToolName(entry.tool)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </Section>
{/if}
{#if code}
  <Section label="Script"><CodeView {code} lang="javascript" label="Script" max={8} quoteKind="tool_call" /></Section>
{/if}
{#if result}
  <Section label={result.failed ? "Failed" : "Output"}>
    {#snippet aside()}{#if result.wallSeconds !== undefined}<span class="tabular-nums">{result.wallSeconds < 1 ? "under a second" : plural(Math.round(result.wallSeconds), "second")}</span>{/if}{/snippet}
    {#if result.parts.length === 0}
      <p class="text-sm/5 text-zinc-500 italic sm:text-xs/5 dark:text-zinc-400">{result.failed ? result.status : "No output."}</p>
    {/if}
    <div class="grid gap-2">
      {#each result.parts as part, index (index)}
        {#if part.kind === "command"}
          <div class="grid gap-1">
            <div class="flex items-center gap-1.5 text-sm/5 sm:text-xs/5">
              {#if part.exitCode !== undefined}
                <Badge tone={part.exitCode === 0 ? "emerald" : "rose"}>{part.exitCode === 0 ? "Succeeded" : `Exit code ${part.exitCode}`}</Badge>
              {:else if part.running}
                <Badge tone="sky">Still running</Badge>
              {/if}
            </div>
            {#if part.output.trim()}<CodeBlock text={part.output.replace(/\n$/, "")} label="Command output" data-quote-kind="command_output" />{/if}
          </div>
        {:else if part.kind === "json"}
          <StructuredView node={structure(part.value)} />
        {:else}
          <CodeBlock text={part.text} label="Script output" data-quote-kind="tool_call" />
        {/if}
      {/each}
    </div>
  </Section>
{:else if streaming || call.output}
  <Section label="Output">
    {#if streaming}
      <OutputBlock quoteKind="tool_call" output={call.output} label="Script output" {streaming} />
    {:else}
      <ResultText {call} {status} />
    {/if}
  </Section>
{/if}
