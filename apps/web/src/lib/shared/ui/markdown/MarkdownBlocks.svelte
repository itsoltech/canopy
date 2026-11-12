<script lang="ts">
  import ChoiceControl from "../ChoiceControl.svelte";
  import MathView from "./Math.svelte";
  import { isMathToken } from "@canopy/domain/markdown";
  import type { Token, Tokens } from "marked";
  import CodeFence from "../code/CodeFence.svelte";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";
  import MarkdownInline from "./MarkdownInline.svelte";
  import { useInlineElements } from "./inline-elements.ts";

  /** `streaming`: the text is still arriving (code blocks reveal per line, `CodeFence`). */
  let {
    tokens,
    streaming = false,
    breaks = false,
  }: { tokens: Token[]; streaming?: boolean; breaks?: boolean } = $props();

  const elements = useInlineElements();

  const headingSize = new Map<number, string>([
    [1, "text-lg/7 sm:text-base/7"],
    [2, "text-base/7 sm:text-base/7"],
    [3, "text-base/6 sm:text-sm/6"],
  ]);

  const inline = (token: Tokens.Text | Tokens.Paragraph | Tokens.Heading | Tokens.TableCell): Token[] =>
    token.tokens ?? [{ type: "text", raw: token.text, text: token.text }];

  const align = (value: "center" | "left" | "right" | null) =>
    value === "center" ? "text-center" : value === "right" ? "text-right" : "text-left";
</script>

{#each tokens as token, index (index)}
  {#if isMathToken(token)}
    <MathView text={token.text} raw={token.raw} display={token.display} />
  {:else if token.type === "paragraph"}
    <p class={breaks ? "whitespace-pre-wrap" : undefined}>
      <MarkdownInline tokens={inline(token as Tokens.Paragraph)} />
    </p>
  {:else if token.type === "heading"}
    {@const heading = token as Tokens.Heading}
    <p
      class={[
        "font-semibold text-zinc-950 dark:text-white",
        headingSize.get(heading.depth) ?? "text-base/6 sm:text-sm/6",
        breaks && "whitespace-pre-wrap",
      ]}
      role="heading"
      aria-level={Math.min(heading.depth + 2, 6)}
    >
      <MarkdownInline tokens={inline(heading)} />
    </p>
  {:else if token.type === "code"}
    {@const code = token as Tokens.Code}
    <CodeFence code={elements ? elements.restore(code.text) : code.text} lang={code.lang} {streaming} />
  {:else if token.type === "list"}
    {@const list = token as Tokens.List}
    <svelte:element
      this={list.ordered ? "ol" : "ul"}
      class={[
        "grid grid-cols-1 gap-1 pl-5",
        list.ordered ? "list-decimal" : "list-disc",
        "marker:text-zinc-400 dark:marker:text-zinc-500",
      ]}
      start={list.ordered && list.start !== "" && list.start !== 1 ? list.start : undefined}
    >
      {#each list.items as item, itemIndex (itemIndex)}
        <li class={["pl-1", item.task && "-ml-5 flex list-none gap-2"]}>
          {#if item.task}
            <div class="flex h-lh shrink-0 items-center">
              <ChoiceControl
                name="markdown-task"
                checked={item.checked}
                disabled
                aria-label={item.checked ? "Done" : "Not done"}
              />
            </div>
          {/if}
          <div class="grid min-w-0 grid-cols-1 gap-2">
            {#if item.loose}
              <MarkdownBlocks tokens={item.tokens} {streaming} {breaks} />
            {:else}
              {#each item.tokens as child, childIndex (childIndex)}
                {#if child.type === "text"}
                  <div class={breaks ? "whitespace-pre-wrap" : undefined}>
                    <MarkdownInline tokens={inline(child as Tokens.Text)} />
                  </div>
                {:else}
                  <MarkdownBlocks tokens={[child]} {streaming} {breaks} />
                {/if}
              {/each}
            {/if}
          </div>
        </li>
      {/each}
    </svelte:element>
  {:else if token.type === "blockquote"}
    <blockquote
      class="grid grid-cols-1 gap-2 border-l-2 border-zinc-950/10 pl-3 text-zinc-600 dark:border-white/15 dark:text-zinc-400"
    >
      <MarkdownBlocks tokens={(token as Tokens.Blockquote).tokens} {streaming} {breaks} />
    </blockquote>
  {:else if token.type === "table"}
    {@const table = token as Tokens.Table}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm/6">
        <thead>
          <tr class="border-b border-zinc-950/10 dark:border-white/10">
            {#each table.header as cell, cellIndex (cellIndex)}
              <th
                class={[
                  "px-2 py-1.5 font-semibold text-zinc-950 first:pl-0 dark:text-white",
                  align(table.align[cellIndex] ?? null),
                  breaks ? "whitespace-pre-wrap" : "whitespace-nowrap",
                ]}><MarkdownInline tokens={inline(cell)} /></th
              >
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-950/5 dark:divide-white/5">
          {#each table.rows as row, rowIndex (rowIndex)}
            <tr>
              {#each row as cell, cellIndex (cellIndex)}
                <td
                  class={[
                    "px-2 py-1.5 align-top first:pl-0",
                    align(table.align[cellIndex] ?? null),
                    breaks && "whitespace-pre-wrap",
                  ]}><MarkdownInline tokens={inline(cell)} /></td
                >
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if token.type === "hr"}
    <hr class="border-zinc-950/10 dark:border-white/10" />
  {:else if token.type === "text"}
    <p class={breaks ? "whitespace-pre-wrap" : undefined}><MarkdownInline tokens={inline(token as Tokens.Text)} /></p>
  {:else if token.type === "html"}
    <p class="whitespace-pre-wrap">{token.raw}</p>
  {/if}
{/each}
