<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import CodeView from "#lib/shared/ui/code/CodeView.svelte";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import WorkspaceMarkdown from "./WorkspaceMarkdown.svelte";
  import FileImage from "./FileImage.svelte";
  import VideoPlayer from "#lib/features/attachments/VideoPlayer.svelte";
  import { fileName, type FilePosition } from "@canopy/domain/file-references";
  import type { WorkspaceFileTarget } from "@canopy/domain/workspace-file";
  import { workspaceVideoUrl } from "./api.ts";

  /**
   * A read file, read-only: Markdown rendered, everything else highlighted by its extension with line numbers
   * (not selectable). Mod+A in the focused workspace selects only the file's text (select-all.ts).
   */
  let {
    file,
    text,
    name,
    video,
    loading,
    rendered,
    local,
    position,
    target,
  }: {
    file: ui.ThreadFile | undefined;
    text: string;
    name: string;
    video: boolean;
    loading: boolean;
    rendered: boolean;
    /** The file is on this computer: its default app can show what Canopy cannot. */
    local: boolean;
    position?: FilePosition | undefined;
    target: WorkspaceFileTarget;
  } = $props();
</script>

{#if !file || (video && loading)}
  {#if loading}<p role="status" class="p-4 text-sm text-muted">Opening the file…</p>{/if}
{:else if video}
  {@const path = file.path || file.relativePath || target.path}
  {@const src = workspaceVideoUrl(target.threadId, path, target.itemId)}
  {#key `${src}:${file.modifiedMs}:${file.size}:${file.sha256}`}
    <VideoPlayer {src} label={fileName(path)} embedded />
  {/key}
{:else if file.truncated && file.binary}
  <p class="p-4 text-sm text-muted">This file exceeds the 2 MB preview limit. Open it on the thread’s computer.</p>
{:else if /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType)}
  <FileImage {file} {name} />
{:else if file.binary}
  <p class="p-4 text-sm text-muted">
    Canopy cannot show this file.{local ? " Open it in its default app." : " Open it on the thread’s computer."}
  </p>
{:else if rendered}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="min-h-full p-4 focus-ring" tabindex="0" role="region" aria-label={name} data-select-content>
    <WorkspaceMarkdown {text} {target} path={file.path || file.relativePath || target.path} />
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
