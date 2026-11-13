<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import FileImage from "./FileImage.svelte";
  import type { FilePosition } from "@canopy/domain/file-references";

  /**
   * A read file, read-only: Markdown rendered, everything else highlighted by its extension with line numbers
   * (not selectable). Mod+A in the focused workspace selects only the file's text (select-all.ts).
   */
  let {
    file,
    text,
    name,
    loading,
    rendered,
    local,
    position,
  }: {
    file: ui.ThreadFile | undefined;
    text: string;
    name: string;
    loading: boolean;
    rendered: boolean;
    /** The file is on this computer: its default app can show what Canopy cannot. */
    local: boolean;
    position?: FilePosition | undefined;
  } = $props();
</script>

{#if !file}
  {#if loading}<p role="status" class="p-4 text-sm text-muted">Opening the file…</p>{/if}
{:else if file.truncated && file.binary}
  <p class="p-4 text-sm text-muted">This file exceeds the 2 MB preview limit. Open a smaller file to preview it.</p>
{:else if /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType)}
  <FileImage {file} {name} />
{:else if file.binary}
  <p class="p-4 text-sm text-muted">
    Canopy cannot show this file.{local ? " Open it in its default app." : " Open it on the thread’s computer."}
  </p>
{:else if rendered}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="min-h-full p-4 focus-ring" tabindex="0" role="region" aria-label={name} data-select-content>
    <Markdown {text} />
  </div>
{:else if text}
  <CodeView
    code={text}
    lang={languageOfPath(name)}
    label={name}
    start={1}
    max={Number.MAX_SAFE_INTEGER}
    fill
    class="min-h-full"
    {position}
  />
{:else}
  <p class="p-4 text-sm text-muted">This file is empty.</p>
{/if}
