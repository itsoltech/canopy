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
      timer: ReturnType<typeof setTimeout> | undefined;
      generation = 0;
      closed = false;

      constructor(readonly view: EditorView) {
        this.client = openHighlight(path, view.state.doc.toString());
        this.schedule();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          const changes: { from: number; to: number; insert: string }[] = [];
          update.changes.iterChanges((from, to, _nextFrom, _nextTo, insert) => {
            changes.push({ from, to, insert: insert.toString() });
          });
          this.client.change(changes);
          this.decorations = Decoration.none;
        }

        if (update.docChanged || update.viewportChanged) this.schedule();
      }

      schedule() {
        clearTimeout(this.timer);
        const generation = ++this.generation;
        this.timer = setTimeout(() => void this.highlight(generation), 40);
      }

      async highlight(generation: number) {
        const doc = this.view.state.doc;
        const start = doc.lineAt(this.view.viewport.from).number;
        const end = Math.min(start + 199, doc.lineAt(this.view.viewport.to).number);

        try {
          const result = await this.client.window(start, end - start + 1);

          if (this.closed || this.generation !== generation || this.view.state.doc !== doc) return;

          const ranges = result.lines.flatMap((line) => {
            if (line.line > doc.lines) return [];
            const source = doc.line(line.line);

            return line.spans.flatMap((span) =>
              span.to > source.length
                ? []
                : [
                    Decoration.mark({ attributes: { style: `color:var(--code-${roleNames[span.role]})` } }).range(
                      source.from + span.from,
                      source.from + span.to,
                    ),
                  ],
            );
          });

          this.decorations = Decoration.set(ranges, true);
          this.view.dispatch({});
        } catch {
          // Plain text remains immediately editable; a stale/expired result never changes the document.
        }
      }

      destroy() {
        this.closed = true;
        this.generation++;
        clearTimeout(this.timer);
        this.client.close();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
