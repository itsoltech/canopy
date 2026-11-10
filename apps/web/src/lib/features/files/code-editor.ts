import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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
import { tags } from "@lezer/highlight";

/**
 * The file viewer's editor (CodeMirror 6, loaded on first edit). Colours come from the code tokens in
 * shared/ui/code/syntax.css and the palette, so it follows every theme and the light/dark scheme.
 */
const highlight = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--code-comment)" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.moduleKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "var(--code-string)" },
  { tag: [tags.regexp, tags.escape], color: "var(--code-regexp)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name)], color: "var(--code-constant)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--code-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.tagName, tags.heading], color: "var(--code-tag)", fontWeight: "600" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--code-property)" },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: "var(--code-punctuation)" },
  { tag: tags.inserted, color: "var(--code-inserted)" },
  { tag: tags.deleted, color: "var(--code-deleted)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.link, textDecoration: "underline" },
]);

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
  destroy(): void;
}

export interface CodeEditorOptions {
  text: string;
  fileName: string;
  wrap: boolean;
  onchange: (text: string) => void;
  onsave: () => void;
}

export function createCodeEditor(parent: HTMLElement, options: CodeEditorOptions): CodeEditor {
  const language = new Compartment();
  let resetting = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
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
        syntaxHighlighting(highlight),
        theme,
        language.of([]),
        ...(options.wrap ? [EditorView.lineWrapping] : []),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (options.onsave(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !resetting) options.onchange(update.state.doc.toString());
        }),
      ],
    }),
  });

  // The grammar loads by the file's name (`.sql`, `.cs`, `Dockerfile`); unknown files stay plain text.
  const description = LanguageDescription.matchFilename(languages, options.fileName);
  void description?.load().then((support) => view.dispatch({ effects: language.reconfigure(support) }));

  return {
    text: () => view.state.doc.toString(),
    reset(text) {
      resetting = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      resetting = false;
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
