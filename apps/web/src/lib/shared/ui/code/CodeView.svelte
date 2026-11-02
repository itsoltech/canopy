<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import MoreButton from "../MoreButton.svelte";
  import { useRemembered } from "../memory.ts";
  import CodeLines from "./CodeLines.svelte";
  import type { LanguageId } from "./languages.ts";

  /**
   * Code to read (a file the agent read, a script it ran): highlighted in `lang`, with line numbers from
   * `start` when given. Longer than `max` lines it shows the first `max` until "Show all"; highlighting
   * covers only what is shown, and loads with its grammar (lazy). Other code surfaces: CodeBlock (plain
   * text), CodeFence (markdown).
   */
  let {
    code,
    lang,
    label,
    start,
    max = 24,
    quoteKind,
    class: className,
  }: { code: string; lang?: LanguageId | undefined; label: string; start?: number | undefined; max?: number; quoteKind?: string | undefined; class?: ClassValue } = $props();

  const lines = $derived(code.split("\n"));
  const cut = $derived(lines.length > max + 4);
  const memory = useRemembered<boolean>("code-all");
  let all = $state(memory?.get() ?? false);
  $effect(() => memory?.set(all));
  const shown = $derived(cut && !all ? lines.slice(0, max).join("\n") : code);
  const shownCount = $derived(cut && !all ? max : lines.length);
  const gutter = $derived(start !== undefined ? `calc(${String(start + shownCount - 1).length}ch + 1.25rem)` : undefined);
</script>

<div class={["grid min-w-0 gap-1", className]}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="code-surface flex max-h-[32rem] rounded-lg bg-zinc-950/2.5 focus-ring dark:bg-white/5" tabindex="0" role="region" aria-label={label}>
    {#if start !== undefined}
      <pre aria-hidden="true" data-quote-skip class="w-(--gutter) shrink-0 py-3 pr-2 pl-3 text-right text-zinc-400 select-none dark:text-zinc-500" style:--gutter={gutter}>{Array.from({ length: shownCount }, (_, i) => start + i).join("\n")}</pre>
    {/if}
    <pre data-quote-kind={quoteKind} data-quote-lang={lang} class={["flex-1 py-3 pr-3 text-zinc-800 dark:text-zinc-200", start === undefined && "pl-3"]}><CodeLines text={shown} {lang} /></pre>
  </div>
  {#if cut}
    <div data-quote-skip class="flex items-center justify-between gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <p class="tabular-nums">{all ? `${lines.length} lines` : `First ${max} of ${lines.length} lines`}</p>
      <MoreButton expanded={all} onclick={() => (all = !all)}>{all ? "Show less" : `Show all ${lines.length} lines`}</MoreButton>
    </div>
  {/if}
</div>
