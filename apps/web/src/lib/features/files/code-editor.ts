import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { FilePosition } from "@canopy/domain/file-references";
import { workspaceHighlight } from "#lib/features/workspace/workspace-editor.ts";

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--code-fg)", backgroundColor: "transparent", fontSize: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--code-fg)", paddingBlock: "0.75rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "currentColor" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-zinc-500)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, currentColor 5%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--color-sky-500) 25%, transparent)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--color-amber-400) 35%, transparent)" },
  ".cm-panels": { backgroundColor: "color-mix(in oklab, currentColor 4%, transparent)", color: "inherit" },
  ".cm-panels-bottom": { borderTop: "1px solid color-mix(in oklab, currentColor 10%, transparent)" },
});

export interface CodeEditor {
  text(): string;
  /** Replaces the content (a reload) without counting as an edit of the user's. */
  reset(text: string): void;
  focus(): void;
  locate(position: FilePosition): void;
  destroy(): void;
}

export interface CodeEditorMemory {
  state?: EditorState | undefined;
  events?: Compartment | undefined;
  positionRevision?: number;
}

export interface CodeEditorOptions {
  text: string;
  fileName: string;
  wrap: boolean;
  onchange: (text: string) => void;
  memory?: CodeEditorMemory | undefined;
}

export function createCodeEditor(parent: HTMLElement, options: CodeEditorOptions): CodeEditor {
  const memory = options.memory;
  const events = memory?.events ?? new Compartment();

  if (memory) {
    memory.events = events;
  }

  let resetting = false;

  const view = new EditorView({
    parent,
    state:
      memory?.state ??
      EditorState.create({
        doc: options.text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          workspaceHighlight(options.fileName),
          theme,
          ...(options.wrap ? [EditorView.lineWrapping] : []),
          events.of([]),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
        ],
      }),
  });

  view.dispatch({ effects: events.reconfigure(editorEvents(options, () => resetting)) });

  return {
    text: () => view.state.doc.toString(),
    reset(text) {
      resetting = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      resetting = false;
    },
    focus: () => view.focus(),
    locate(position) {
      const line = view.state.doc.line(Math.min(position.line, view.state.doc.lines));
      const end = view.state.doc.line(Math.min(position.end, view.state.doc.lines));
      const anchor = Math.min(line.to, line.from + position.column - 1);
      view.dispatch({
        selection: { anchor, head: position.end > position.line ? end.to : anchor },
        scrollIntoView: true,
      });
      view.focus();
    },
    destroy() {
      if (memory) memory.state = view.state.update({ effects: events.reconfigure([]) }).state;
      view.destroy();
    },
  };
}

function editorEvents(options: CodeEditorOptions, resetting: () => boolean) {
  return [
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !resetting()) options.onchange(update.state.doc.toString());
    }),
  ];
}
