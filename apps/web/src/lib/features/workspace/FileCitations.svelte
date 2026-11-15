<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import CiteLayer from "#lib/features/quotes/CiteLayer.svelte";
  import { selectedQuote } from "#lib/features/quotes/selection.ts";

  let {
    document,
    threadId,
    rendered,
    selectedText,
    beforeinsert,
    children,
    class: className,
  }: {
    document: WorkspaceFile;
    threadId: string;
    rendered: boolean;
    selectedText: () => string | undefined;
    beforeinsert: () => Promise<void>;
    children: Snippet;
    class?: ClassValue;
  } = $props();

  let root = $state<HTMLDivElement>();

  function select(selection: Selection | null) {
    if (!selection?.rangeCount || !document.file || document.file.binary) return;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;

    // Exclude editor search controls, line gutters and file notices.
    if (!element?.closest(".cm-content, [data-select-content]") || !root?.contains(node)) return;
    const editor = element.closest(".cm-content");
    const text = rendered ? undefined : selectedText();

    if (editor && text === undefined) return;

    return selectedQuote(selection, {
      source: {
        itemId: "",
        threadId: document.target.threadId,
        kind: "file",
        language: rendered ? "" : (languageOfPath(document.path) ?? ""),
        author: document.file.relativePath || document.path,
      },
      pre: rendered ? undefined : true,
      text,
    });
  }
</script>

<div bind:this={root} class={["h-full", className]}>
  {@render children()}
</div>
<CiteLayer {threadId} {root} {select} {beforeinsert} />
