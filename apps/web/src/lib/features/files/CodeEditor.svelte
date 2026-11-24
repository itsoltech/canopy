<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import type { CodeEditor, CodeEditorMemory } from "./code-editor.ts";
  import type { FilePosition } from "@canopy/domain/file-references";
  import { useField } from "#lib/shared/ui/field.ts";

  /**
   * CodeMirror loads when an editable text file opens; read-only previews keep the smaller reader.
   * `text` is the starting content: later changes of the prop replace the content (a reload).
   */
  let {
    text,
    fileName,
    wrap,
    onchange,
    memory,
    position,
    positionRevision = 0,
    readonly = false,
    field,
    fallback,
  }: {
    text: string;
    fileName: string;
    wrap: boolean;
    onchange: (text: string) => void;
    memory?: CodeEditorMemory;
    position?: FilePosition | undefined;
    positionRevision?: number;
    readonly?: boolean;
    field?: { placeholder: string };
    fallback?: Snippet;
  } = $props();

  const fieldContext = useField();
  let host = $state<HTMLDivElement>();
  let editor = $state<CodeEditor>();
  let failed = $state(false);

  export function selectedText(): string | undefined {
    return editor?.selectedText();
  }

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
            onchange: (next) => {
              onchange(next);
              // A bounded draft can reject an edit without changing the text prop.
              void tick().then(() => {
                if (active && created && created.text() !== text) created.reset(text);
              });
            },
            memory,
            readonly,
            ...(field && { field }),
          }),
        );
        editor = created;

        if (!untrack(() => field)) created.focus();
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
    const attributes = field &&
      fieldContext && {
        id: fieldContext.id,
        "aria-labelledby": `${fieldContext.id}-label`,
        "aria-invalid": String(fieldContext.invalid),
        ...(fieldContext.describedBy && { "aria-describedby": fieldContext.describedBy }),
        autocapitalize: "off",
        spellcheck: "false",
      };

    editor?.configure(readonly, attributes);
  });

  $effect(() => {
    const next = text;

    untrack(() => {
      if (editor && editor.text() !== next) editor.reset(next);
    });
  });

  $effect(() => {
    if (!editor || !position || memory?.positionRevision === positionRevision) return;
    editor.locate(position);

    if (memory) memory.positionRevision = positionRevision;
  });
</script>

{#if failed && fallback}
  {@render fallback()}
{:else if failed}
  <p role="alert" class="text-muted">The editor could not load. Reload Canopy and try again.</p>
{:else if field}
  <div
    bind:this={host}
    class={[
      "h-32 min-w-0 overflow-hidden rounded-lg bg-surface px-2 font-mono text-base/6 outline-1 -outline-offset-1 outline-divider has-field-focus:outline-2 has-field-focus:outline-accent sm:text-sm/6",
      fieldContext?.invalid && "outline-rose-500",
    ]}
  ></div>
{:else}
  <div bind:this={host} class="h-full min-h-64 font-mono text-sm/6" aria-label="File content"></div>
{/if}
