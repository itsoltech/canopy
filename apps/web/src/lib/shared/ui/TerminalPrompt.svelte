<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "./Button.svelte";
  import CodeTokens from "./code/CodeTokens.svelte";
  import { Highlight } from "./code/highlight.svelte.ts";
  import { terminalCwd } from "./terminal.ts";

  let { command, cwd, class: className }: { command: string; cwd: string; class?: ClassValue } = $props();
  let expanded = $state(false);
  let prompt = $state<HTMLPreElement>();
  let expandable = $state(false);
  const id = $props.id();
  const highlight = new Highlight(() => command, () => "shellscript");
  const lines = $derived(command.split("\n"));
  $effect(() => {
    if (!prompt) return;
    const measure = () => { expandable = prompt!.scrollHeight > 60; };
    const observer = new ResizeObserver(measure);
    observer.observe(prompt);
    measure();
    return () => observer.disconnect();
  });
</script>

<div class={["grid min-w-0 shrink-0 gap-1 border-b border-white/10 px-4 py-3", className]}>
  <pre bind:this={prompt} {id} class={["min-w-0 font-mono text-sm/5 whitespace-pre-wrap wrap-anywhere", expanded ? "max-h-[30dvh] overflow-y-auto" : "max-h-15 overflow-hidden"]}><span class="text-emerald-300" title={cwd}>{terminalCwd(cwd, 30)} $ </span>{#each lines as line, index}{#if index > 0}{"\n"}{/if}{#if highlight.lines[index]?.text === line}<CodeTokens tokens={highlight.lines[index]!.tokens} />{:else}{line}{/if}{/each}</pre>
  {#if expandable || expanded}<div><Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={id} onclick={() => (expanded = !expanded)}>{expanded ? "Collapse command" : "Show full command"}</Button></div>{/if}
</div>
