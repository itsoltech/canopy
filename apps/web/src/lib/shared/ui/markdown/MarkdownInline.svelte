<script lang="ts">
  import type { Token, Tokens } from "marked";
  import Math from "./Math.svelte";
  import { isMathToken, safeHref } from "@canopy/domain/markdown";
  import MarkdownInline from "./MarkdownInline.svelte";
  import { splitSentinels, useInlineElements } from "./inline-elements.ts";
  import { tooltip } from "../tooltip.ts";
  import { useFileLinks } from "./file-links.ts";
  import { fileHrefOf, filePathOf } from "./file-paths.ts";
  import InlineLink from "../InlineLink.svelte";

  let { tokens }: { tokens: Token[] } = $props();
  const elements = useInlineElements();
  const files = useFileLinks();
</script>

{#each tokens as token, index (index)}
  {#if isMathToken(token)}
    <Math text={token.text} raw={token.raw} display={token.display} />
  {:else if token.type === "strong"}
    <strong class="font-semibold text-zinc-950 dark:text-white"
      ><MarkdownInline tokens={(token as Tokens.Strong).tokens} /></strong
    >
  {:else if token.type === "em"}
    <em><MarkdownInline tokens={(token as Tokens.Em).tokens} /></em>
  {:else if token.type === "del"}
    <del><MarkdownInline tokens={(token as Tokens.Del).tokens} /></del>
  {:else if token.type === "codespan"}
    {@const text = elements ? elements.restore((token as Tokens.Codespan).text) : (token as Tokens.Codespan).text}
    {@const path = files ? filePathOf(text) : undefined}
    {#if files && path}
      <!-- A file the agent named: opens in the viewer or the default app (docs/ui-api.md, "Pliki wątku"). -->
      <InlineLink
        class="cursor-pointer rounded-sm bg-zinc-950/5 box-decoration-clone px-1 py-px text-left font-mono text-[0.875em] text-sky-700 underline decoration-sky-700/30 decoration-dotted underline-offset-2 focus-ring hover:decoration-sky-700 dark:bg-white/10 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
        onactivate={() => files.open(path)}
        {@attach tooltip(`Open ${path}`)}>{text}</InlineLink
      >
    {:else}
      <code
        class="rounded-sm bg-zinc-950/5 box-decoration-clone px-1 py-px font-mono text-[0.875em] text-zinc-950 dark:bg-white/10 dark:text-white"
        >{text}</code
      >
    {/if}
  {:else if token.type === "link"}
    {@const link = token as Tokens.Link}
    {@const href = safeHref(link.href)}
    {@const path = files ? fileHrefOf(link.href) : undefined}
    {#if files && path}
      <InlineLink
        class="cursor-pointer text-left font-medium text-sky-700 underline decoration-sky-700/30 underline-offset-2 focus-ring hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
        onactivate={() => files.open(path)}
        {@attach tooltip(`Open ${path}`)}><MarkdownInline tokens={link.tokens} /></InlineLink
      >
    {:else if href}
      <InlineLink
        {href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="font-medium text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30 dark:hover:decoration-sky-400"
        ><MarkdownInline tokens={link.tokens} /></InlineLink
      >
    {:else}
      <MarkdownInline tokens={link.tokens} />
    {/if}
  {:else if token.type === "image"}
    {@const image = token as Tokens.Image}
    {@const href = safeHref(image.href)}
    {#if href}
      <InlineLink
        {href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="text-sky-700 underline underline-offset-2 dark:text-sky-400">{image.text || href}</InlineLink
      >
    {:else}
      {image.text}
    {/if}
  {:else if token.type === "br"}
    <br />
  {:else if token.type === "text" && "tokens" in token && token.tokens}
    <MarkdownInline tokens={token.tokens} />
  {:else if token.type === "escape" || token.type === "text"}
    {#if elements && (token as Tokens.Text).text.includes("\uE000")}
      {#each splitSentinels((token as Tokens.Text).text) as part, p (p)}{#if typeof part === "number"}{@render elements.render(
            part,
          )}{:else}{part}{/if}{/each}
    {:else}
      {(token as Tokens.Text).text}
    {/if}
  {:else}
    {token.raw}
  {/if}
{/each}
