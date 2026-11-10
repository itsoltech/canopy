<script lang="ts">
  import { untrack } from "svelte";
  import type { CodeEditor } from "./code-editor.ts";

  /**
   * CodeMirror for the file viewer; its module loads on first use, so reading files never pays for it.
   * `text` is the starting content: later changes of the prop replace the content (a reload).
   */
  let {
    text,
    fileName,
    wrap,
    onchange,
    onsave,
  }: {
    text: string;
    fileName: string;
    wrap: boolean;
    onchange: (text: string) => void;
    onsave: () => void;
  } = $props();

  let host = $state<HTMLDivElement>();
  let editor = $state<CodeEditor>();
  let failed = $state(false);

  $effect(() => {
    const parent = host;

    if (!parent) return;
    let active = true;
    let created: CodeEditor | undefined;

    void import("./code-editor.ts")
      .then(({ createCodeEditor }) => {
        if (!active) return;
        created = untrack(() =>
          createCodeEditor(parent, {
            text,
            fileName,
            wrap,
            onchange: (next) => onchange(next),
            onsave: () => onsave(),
          }),
        );
        editor = created;
        created.focus();
      })
      .catch(() => {
        if (active) failed = true;
      });

    return () => {
      active = false;
      created?.destroy();
      editor = undefined;
    };
  });

  // A reload brings new content: replace it unless it is already what the editor shows.
  $effect(() => {
    const next = text;

    untrack(() => {
      if (editor && editor.text() !== next) editor.reset(next);
    });
  });
</script>

{#if failed}
  <p role="alert" class="text-muted">The editor could not load. Reload Canopy and try again.</p>
{/if}
<div bind:this={host} class="h-full min-h-64 font-mono text-sm/6" aria-label="File content"></div>
