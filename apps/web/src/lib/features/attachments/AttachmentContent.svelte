<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { attachmentPreviewKind, type AttachmentTextPreview } from "@canopy/domain/attachment-preview";
  import type { ClassValue } from "svelte/elements";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { readAttachmentPreview } from "./preview.ts";

  let {
    file,
    compact = false,
    source = false,
    wrap = true,
    onload,
    class: className,
  }: {
    file: ui.Attachment;
    compact?: boolean;
    source?: boolean;
    wrap?: boolean;
    onload?: (preview: AttachmentTextPreview) => void;
    class?: ClassValue;
  } = $props();

  let result = $state<AttachmentTextPreview>();
  let failed = $state(false);
  let retry = $state(0);

  $effect(() => {
    void retry;
    let active = true;
    result = undefined;
    failed = false;
    void readAttachmentPreview(file)
      .then((preview) => {
        if (!active) return;
        result = preview;
        onload?.(preview);
      })
      .catch(() => {
        if (active) failed = true;
      });

    return () => {
      active = false;
    };
  });

  const excerpt = $derived(result?.text?.split("\n").slice(0, 8).join("\n").slice(0, 1200) ?? "");
  const lines = $derived((result?.text ?? "").split("\n"));
</script>

<div class={["min-w-0", className]}>
  {#if failed}
    <p role="alert" class="text-muted">Could not load the preview. Check the connection, then retry.</p>
    <Button variant="ghost" size="sm" onclick={() => retry++}>Retry</Button>
  {:else if !result}
    <p role="status" class="text-muted">Loading preview…</p>
  {:else if result.text === undefined}
    <p class="text-muted">No text preview. Download the file to open it.</p>
  {:else}
    {#if result.truncated && !compact}
      <p class="mb-3 text-sm/5 text-muted">Showing up to 128 KB and 2,000 lines. Download for the full file.</p>
    {/if}
    {#if attachmentPreviewKind(file) === "markdown" && !source}
      <Markdown text={compact ? excerpt : result.text} />
    {:else if compact}
      <pre class="overflow-hidden font-mono text-xs/5 break-all whitespace-pre-wrap">{excerpt}</pre>
    {:else}
      <div class="overflow-x-auto rounded-lg bg-zinc-950/3 py-3 font-mono text-sm/6 dark:bg-white/5">
        {#each lines as line, i (i)}
          <div class="flex min-w-full items-start">
            <span
              aria-hidden="true"
              class="w-12 shrink-0 pr-3 text-right text-muted tabular-nums select-none max-sm:hidden">{i + 1}</span
            >
            <span class={["min-w-0 grow px-3 sm:pl-0", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"]}
              >{line || "\n"}</span
            >
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
