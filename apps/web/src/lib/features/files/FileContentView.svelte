<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";

  /** A read file, read-only: Markdown rendered, everything else highlighted by its extension. */
  let {
    file,
    text,
    name,
    loading,
    rendered,
  }: { file: ui.ThreadFile | undefined; text: string; name: string; loading: boolean; rendered: boolean } = $props();
</script>

{#if !file}
  {#if loading}<p role="status" class="p-4 text-muted">Opening the file…</p>{/if}
{:else if file.binary}
  <p class="p-4 text-muted">Canopy cannot show this file. Open it in its default app.</p>
{:else if rendered}
  <div class="p-4"><Markdown {text} /></div>
{:else if text}
  <CodeView code={text} lang={languageOfPath(name)} label={name} max={Number.MAX_SAFE_INTEGER} class="min-h-full" />
{:else}
  <p class="p-4 text-muted">This file is empty.</p>
{/if}
