<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";

  /** One shell command to run elsewhere, on a single line with a copy button (multi-line scripts: CommandBlock). */
  let {
    text,
    copyLabel = "Copy command",
    class: className,
  }: { text: string; copyLabel?: string; class?: ClassValue } = $props();
</script>

<div class={["flex items-center gap-2", className]}>
  <code
    class="min-w-0 flex-1 truncate rounded-lg bg-zinc-950/5 px-2.5 py-1.5 font-mono text-sm/5 text-zinc-800 dark:bg-white/5 dark:text-zinc-200"
    title={text}>{text}</code
  >
  <CopyButton {text} label={copyLabel} />
</div>
