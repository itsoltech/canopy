import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { roleNames } from "@canopy/syntax/roles";
import { openHighlight } from "./highlight-client.ts";
import type { HighlightClient } from "./highlight-client.ts";

/** CodeMirror owns text/IME/undo and virtualization; only semantic decorations cross the CPU boundary. */
export function workspaceHighlight(path: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      readonly client: HighlightClient;
      readonly unsubscribe: () => void;
      frame = 0;

      constructor(readonly view: EditorView) {
        this.client = openHighlight(path, view.state.doc.toString());
        this.unsubscribe = this.client.subscribe(() => {
          if (this.frame) return;
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.paint();
            this.view.dispatch({});
          });
        });
        this.paint();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          const changes: { from: number; to: number; insert: string }[] = [];
          let first = update.startState.doc.lines;
          update.changes.iterChanges((from, to, _nextFrom, _nextTo, insert) => {
            first = Math.min(first, update.startState.doc.lineAt(from).number);
            changes.push({ from, to, insert: insert.toString() });
          });
          this.client.change(changes, first);
        }

        if (update.docChanged || update.viewportChanged) this.paint();
      }

      paint() {
        const doc = this.view.state.doc;
        const start = doc.lineAt(this.view.viewport.from).number;
        const end = doc.lineAt(this.view.viewport.to).number;
        const ranges = [];

        for (let number = start; number <= end; number++) {
          const line = this.client.tokens.get(number);

          if (!line) continue;
          const source = doc.line(line.line);

          ranges.push(
            ...line.spans.flatMap((span) =>
              span.to > source.length
                ? []
                : [
                    Decoration.mark({ attributes: { style: `color:var(--code-${roleNames[span.role]})` } }).range(
                      source.from + span.from,
                      source.from + span.to,
                    ),
                  ],
            ),
          );
        }

        this.decorations = Decoration.set(ranges, true);
      }

      destroy() {
        cancelAnimationFrame(this.frame);
        this.unsubscribe();
        this.client.close();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
