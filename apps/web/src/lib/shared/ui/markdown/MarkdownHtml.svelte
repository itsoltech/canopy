<script lang="ts">
  import type { HtmlNode } from "@canopy/domain/markdown";
  import { fileLinkHrefOf } from "@canopy/domain/file-references";
  import InlineLink from "../InlineLink.svelte";
  import { useFileLinks } from "./file-links.ts";
  import { htmlClasses } from "./html-classes.ts";
  import MarkdownHtml from "./MarkdownHtml.svelte";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownInline from "./MarkdownInline.svelte";
  import MarkdownBlocks from "./MarkdownBlocks.svelte";
  import MarkdownFileLink from "./MarkdownFileLink.svelte";

  let {
    nodes,
    inline = false,
    streaming = false,
    breaks = false,
  }: { nodes: HtmlNode[]; inline?: boolean; streaming?: boolean; breaks?: boolean } = $props();

  const files = useFileLinks();
</script>

{#each nodes as node, index (index)}
  {#if node.kind === "text"}{node.text}
  {:else if node.kind === "image"}<MarkdownImage value={node.image} />
  {:else if node.kind === "markdown"}
    {#if inline}<MarkdownInline tokens={[node.token]} />
    {:else}<MarkdownBlocks tokens={[node.token]} {streaming} {breaks} />{/if}
  {:else if node.tag === "br"}<br />
  {:else if node.tag === "hr"}<hr class="border-zinc-950/10 dark:border-white/10" />
  {:else if node.tag === "a"}
    {@const path = node.href ? fileLinkHrefOf(node.href) : undefined}
    {#if path && files}
      <MarkdownFileLink
        {path}
        title={node.title}
        class="font-medium text-sky-700 underline decoration-sky-700/30 underline-offset-2 focus-ring hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
        ><MarkdownHtml nodes={node.children} {inline} {streaming} {breaks} /></MarkdownFileLink
      >
    {:else if node.href && !path}
      <InlineLink
        href={node.href}
        target={node.href.startsWith("#") ? undefined : "_blank"}
        rel="noopener noreferrer nofollow"
        title={node.title}
        class="font-medium text-sky-700 underline decoration-sky-700/30 underline-offset-2 focus-ring hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
        ><MarkdownHtml nodes={node.children} {inline} {streaming} {breaks} /></InlineLink
      >
    {:else}<MarkdownHtml nodes={node.children} {inline} {streaming} {breaks} />{/if}
  {:else if node.tag === "table"}
    <div class="min-w-0 overflow-x-auto">
      <table class={htmlClasses("table")}>
        <MarkdownHtml nodes={node.children} {inline} {streaming} {breaks} />
      </table>
    </div>
  {:else}
    <svelte:element
      this={node.tag}
      class={[
        "markdown-html min-w-0",
        htmlClasses(node.tag),
        node.align === "center" && "text-center",
        node.align === "right" && "text-right",
        node.align === "left" && "text-left",
      ]}
      title={node.title}
      open={node.tag === "details" ? node.open : undefined}
      start={node.tag === "ol" ? node.start : undefined}
      colspan={node.tag === "td" || node.tag === "th" ? node.colspan : undefined}
      rowspan={node.tag === "td" || node.tag === "th" ? node.rowspan : undefined}
      ><MarkdownHtml nodes={node.children} {inline} {streaming} {breaks} /></svelte:element
    >
  {/if}
{/each}

<style>
  .markdown-html > :global(:is(p, div, h1, h2, h3, h4, h5, h6, pre, blockquote, ul, ol, dl, details) + *) {
    margin-top: 0.75rem;
  }

  .markdown-html:is(details) > :global(summary + *) {
    margin-top: 0.75rem;
  }

  .markdown-html:is(ul, ol) > :global(li + li) {
    margin-top: 0.25rem;
  }

  .markdown-html:is(pre) :global(code) {
    padding: 0;
    background: none;
  }
</style>
