<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "../CopyButton.svelte";
  import CodeLines from "./CodeLines.svelte";
  import DiffLines from "./DiffLines.svelte";
  import { languageOf } from "./languages.ts";

  /**
   * A fenced code block of markdown: its language and a copy button above the code, highlighted when the
   * language is one we know (a `diff` fence shows as a diff). While `streaming`, lines resolve in one by one.
   */
  let { code, lang, streaming = false, class: className }: { code: string; lang?: string | undefined; streaming?: boolean; class?: ClassValue } = $props();

  const language = $derived(languageOf(lang));
</script>

<div class={["overflow-hidden rounded-lg bg-zinc-950/2.5 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10", className]}>
  <div class="flex items-center justify-between gap-2 border-b border-zinc-950/5 pr-0.5 pl-3 dark:border-white/10">
    <p class="min-w-0 truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">{lang}</p>
    <CopyButton text={code} label="Copy code" />
  </div>
  {#if language === "diff"}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="code-surface max-h-[32rem] py-2 focus-ring" tabindex="0" role="region" aria-label="Diff"><DiffLines diff={code} {streaming} /></div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="code-surface max-h-[32rem] p-3 text-zinc-800 focus-ring dark:text-zinc-200" tabindex="0"><CodeLines text={code} lang={language} {streaming} /></pre>
  {/if}
</div>
