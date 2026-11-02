<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { parseFileList, parseGrepOutput, type FileMatches } from "./parse.ts";
  import EmptyNote from "./EmptyNote.svelte";
  import PathList from "./PathList.svelte";
  import ResultText from "./ResultText.svelte";

  /**
   * Grep, Glob and LS: where it looked and with which filters, then the files it found (with match counts)
   * or the matching lines grouped by file.
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const listing = $derived(call.name !== "Grep");
  const mode = $derived(str(input["output_mode"]) || "files_with_matches");
  const base = $derived(str(input["path"]));
  const filters = $derived(
    [
      str(input["glob"]) && `Files ${str(input["glob"])}`,
      str(input["type"]) && `Type ${str(input["type"])}`,
      input["-i"] === true && "Ignore case",
      input["multiline"] === true && "Multiline",
      typeof input["head_limit"] === "number" && `First ${input["head_limit"]}`,
    ].filter((f): f is string => typeof f === "string" && f !== ""),
  );
  const done = $derived(!streaming && !call.isError && call.output !== "");
  const files = $derived(done ? (listing ? parseFileList(call.output).map((path): FileMatches => ({ path, count: undefined, lines: [] })) : parseGrepOutput(call.output, mode)) : []);
  const content = $derived(!listing && mode === "content");
  let all = $state(false);
  const shownFiles = $derived(all ? files : files.slice(0, 6));
  const prefix = $derived(base ? `${base.replace(/\/$/, "")}/` : "");
</script>

{#if base || filters.length > 0}
  <div class="flex min-w-0 flex-wrap items-center gap-1.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    {#if base}<span class="shrink-0">in</span><code class="min-w-0 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={base}>{base}</code>{/if}
    {#each filters as filter (filter)}<Badge>{filter}</Badge>{/each}
  </div>
{/if}
{#if done && files.length === 0 && !call.isError}
  <EmptyNote>Nothing found.</EmptyNote>
{:else if content}
  <div class="grid gap-2">
    {#each shownFiles as file (file.path)}
      <div class="grid min-w-0 gap-0.5">
        <p class="flex min-w-0 items-baseline justify-between gap-3 text-sm/5">
          <span class="truncate font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100" title={file.path}>{prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path}</span>
          <span class="shrink-0 text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400">{file.count}</span>
        </p>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre data-quote-kind="tool_call" tabindex="0" aria-label="Matches in {file.path}" class="code-surface max-h-48 rounded-lg bg-zinc-950/2.5 px-3 py-2 text-zinc-800 focus-ring dark:bg-white/5 dark:text-zinc-200">{#each file.lines as line, index (index)}{index > 0 ? "\n" : ""}<span class="text-zinc-400 select-none dark:text-zinc-500">{line.line ?? ""}{line.line !== undefined ? "  " : ""}</span>{line.text}{/each}</pre>
      </div>
    {/each}
    {#if files.length > 6}
      <MoreButton expanded={all} onclick={() => (all = !all)}>{all ? "Show fewer files" : `Show ${files.length - 6} more files`}</MoreButton>
    {/if}
  </div>
{:else if files.length > 0}
  <PathList {files} {base} />
{:else}
  <ResultText {call} {status} {streaming} />
{/if}
