<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import TerminalPrompt from "./TerminalPrompt.svelte";
  import TerminalOutput from "./TerminalOutput.svelte";
  import { terminalCwd } from "./terminal.ts";
  import { terminalPlainText } from "./terminal-ansi.ts";

  /** Always-dark command surface. Domain status and actions remain with the caller. */
  let {
    title,
    cwd,
    command,
    output,
    running,
    exitLine,
    status,
    actions,
    footer,
    class: className,
  }: {
    title: string;
    cwd: string;
    command: string;
    output: string;
    running: boolean;
    exitLine?: string | undefined;
    status?: Snippet;
    actions?: Snippet;
    footer?: Snippet | undefined;
    class?: ClassValue;
  } = $props();

  let outputView = $state<TerminalOutput>();

  export function latest() {
    outputView?.latest();
  }
</script>

<section
  aria-label={title}
  class={[
    "terminal-surface dark flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-200 scheme-only-dark",
    className,
  ]}
>
  <header class="flex min-w-0 shrink-0 flex-col gap-2 border-b border-white/10 bg-zinc-900 px-4 py-3">
    <div class="flex min-w-0 items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <Icon name="command-line" class="shrink-0 fill-zinc-400" />
        <h3 class="truncate font-mono text-sm font-medium" {title}>{title}</h3>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <CopyButton text={command} label="Copy command" />
        <CopyButton text={terminalPlainText(output)} label="Copy output" />
        {@render actions?.()}
      </div>
    </div>
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <p class="min-w-0 truncate font-mono text-sm/5 text-zinc-400" title={cwd}>{terminalCwd(cwd)}</p>
      {@render status?.()}
    </div>
  </header>
  {#if command}<TerminalPrompt {command} {cwd} />{/if}
  <TerminalOutput bind:this={outputView} {output} {running} {exitLine} />
  {#if footer}<div class="shrink-0 border-t border-white/10 px-4 py-2 text-sm/5 wrap-anywhere text-zinc-400">
      {@render footer()}
    </div>{/if}
</section>
