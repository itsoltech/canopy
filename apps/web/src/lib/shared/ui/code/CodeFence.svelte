<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "../CopyButton.svelte";
  import CodeFrame from "./CodeFrame.svelte";
  import CodeLines from "./CodeLines.svelte";
  import DiffLines from "./DiffLines.svelte";
  import { languageOf } from "./languages.ts";

  /**
   * A fenced code block of markdown: its language and a copy button above the code, highlighted when the
   * language is one we know (a `diff` fence shows as a diff). While `streaming`, lines resolve in one by one.
   */
  let {
    code,
    lang,
    streaming = false,
    class: className,
  }: { code: string; lang?: string | undefined; streaming?: boolean; class?: ClassValue } = $props();

  const language = $derived(languageOf(lang));
</script>

<CodeFrame class={["code-fence", className]}>
  {#snippet header()}
    <p class="min-w-0 truncate pl-3 font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">{lang}</p>
    <CopyButton text={code} label="Copy code" />
  {/snippet}
  {#if language === "diff"}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="diff-surface max-h-[32rem] code-surface py-2 focus-ring"
      tabindex="0"
      role="region"
      aria-label="Diff"
      data-quote-kind="diff"
    >
      <DiffLines diff={code} {streaming} />
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre
      data-quote-kind="code"
      data-quote-lang={lang}
      class="max-h-[32rem] code-surface p-3 text-zinc-800 focus-ring dark:text-zinc-200"
      tabindex="0"><CodeLines text={code} lang={language} {streaming} /></pre>
  {/if}
</CodeFrame>
