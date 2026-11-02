<script lang="ts">
  import type { Token, Tokens } from "marked";
  import CodeLines from "./CodeLines.svelte";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";
  import MarkdownInline from "./MarkdownInline.svelte";

  /** `streaming`: the text is still arriving (code blocks reveal per line, `CodeLines`). */
  let { tokens, streaming = false }: { tokens: Token[]; streaming?: boolean } = $props();

  const headingSize: Record<number, string> = {
    1: "text-lg/7 sm:text-base/7",
    2: "text-base/7 sm:text-base/7",
    3: "text-base/6 sm:text-sm/6",
  };
  const inline = (token: Tokens.Text | Tokens.Paragraph | Tokens.Heading | Tokens.TableCell): Token[] =>
    token.tokens ?? [{ type: "text", raw: token.text, text: token.text }];
  const align = (value: "center" | "left" | "right" | null) => (value === "center" ? "text-center" : value === "right" ? "text-right" : "text-left");
</script>

{#each tokens as token, index (index)}
  {#if token.type === "paragraph"}
    <p><MarkdownInline tokens={inline(token as Tokens.Paragraph)} /></p>
  {:else if token.type === "heading"}
    {@const heading = token as Tokens.Heading}
    <p class={["font-semibold text-zinc-950 dark:text-white", headingSize[heading.depth] ?? "text-base/6 sm:text-sm/6"]} role="heading" aria-level={Math.min(heading.depth + 2, 6)}>
      <MarkdownInline tokens={inline(heading)} />
    </p>
  {:else if token.type === "code"}
    {@const code = token as Tokens.Code}
    <div class="overflow-hidden rounded-lg bg-zinc-950/2.5 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10">
      {#if code.lang}<div class="border-b border-zinc-950/5 px-3 py-1 font-mono text-xs/5 text-zinc-500 dark:border-white/10 dark:text-zinc-400">{code.lang}</div>{/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="code-surface max-h-[32rem] p-3 text-zinc-800 focus-ring dark:text-zinc-200" tabindex="0"><CodeLines text={code.text} {streaming} /></pre>
    </div>
  {:else if token.type === "list"}
    {@const list = token as Tokens.List}
    <svelte:element this={list.ordered ? "ol" : "ul"} class={["grid gap-1 pl-5", list.ordered ? "list-decimal" : "list-disc", "marker:text-zinc-400 dark:marker:text-zinc-500"]} start={list.ordered && list.start !== "" && list.start !== 1 ? list.start : undefined}>
      {#each list.items as item, itemIndex (itemIndex)}
        <li class={["pl-1", item.task && "list-none -ml-5 flex gap-2"]}>
          {#if item.task}
            <input type="checkbox" checked={item.checked} disabled class="mt-1.5 size-3.5 shrink-0 accent-zinc-700" aria-label={item.checked ? "Done" : "Not done"} />
          {/if}
          <div class="grid min-w-0 gap-2">
            {#if item.loose}
              <MarkdownBlocks tokens={item.tokens} {streaming} />
            {:else}
              {#each item.tokens as child, childIndex (childIndex)}
                {#if child.type === "text"}
                  <div><MarkdownInline tokens={inline(child as Tokens.Text)} /></div>
                {:else}
                  <MarkdownBlocks tokens={[child]} {streaming} />
                {/if}
              {/each}
            {/if}
          </div>
        </li>
      {/each}
    </svelte:element>
  {:else if token.type === "blockquote"}
    <blockquote class="grid gap-2 border-l-2 border-zinc-950/10 pl-3 text-zinc-600 dark:border-white/15 dark:text-zinc-400">
      <MarkdownBlocks tokens={(token as Tokens.Blockquote).tokens} {streaming} />
    </blockquote>
  {:else if token.type === "table"}
    {@const table = token as Tokens.Table}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm/6">
        <thead>
          <tr class="border-b border-zinc-950/10 dark:border-white/10">
            {#each table.header as cell, cellIndex (cellIndex)}
              <th class={["px-2 py-1.5 font-semibold whitespace-nowrap text-zinc-950 first:pl-0 dark:text-white", align(table.align[cellIndex] ?? null)]}><MarkdownInline tokens={inline(cell)} /></th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-950/5 dark:divide-white/5">
          {#each table.rows as row, rowIndex (rowIndex)}
            <tr>
              {#each row as cell, cellIndex (cellIndex)}
                <td class={["px-2 py-1.5 align-top first:pl-0", align(table.align[cellIndex] ?? null)]}><MarkdownInline tokens={inline(cell)} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if token.type === "hr"}
    <hr class="border-zinc-950/10 dark:border-white/10" />
  {:else if token.type === "text"}
    <p><MarkdownInline tokens={inline(token as Tokens.Text)} /></p>
  {:else if token.type === "html"}
    <p class="whitespace-pre-wrap">{token.raw}</p>
  {/if}
{/each}
