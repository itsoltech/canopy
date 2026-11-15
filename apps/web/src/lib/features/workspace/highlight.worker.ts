import { WindowHighlighter } from "@canopy/syntax/window";
import type { HighlightCommand, HighlightReply } from "./highlight-protocol.ts";

const scope = self;
let current: WindowHighlighter | undefined;
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let next = 1;
let total = 0;
const reply = (value: HighlightReply) => scope.postMessage(value);

function prepare() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!current || next > total) return;

    try {
      reply({ kind: "working", revision });
      const result = current.render(next, 200);
      reply({ kind: "tokens", revision, result });
      const last = result.lines.at(-1)?.line;

      if (last === undefined) return;
      next = last + 1;
      prepare();
    } catch {
      reply({ kind: "error", revision });
    }
  }, 0);
}

scope.onmessage = async (event: MessageEvent<HighlightCommand>) => {
  const command = event.data;

  try {
    if (command.kind === "source") {
      revision = command.revision;
      clearTimeout(timer);
      next = 1;
      const value = new WindowHighlighter(command.path, command.source);
      current = value;
      total = value.lineCount;
      await value.ready();

      if (current === value) {
        reply({ kind: "ready", revision });
        prepare();
      }
    } else if (command.kind === "changes") {
      current?.change(command.changes);
      revision = command.revision;
      // Cached prefix returns without tokenization; the changed suffix is rebuilt in bounded tasks.
      next = 1;
      total = current?.lineCount ?? 0;
      reply({ kind: "ready", revision });
      prepare();
    } else if (current && command.revision === revision) {
      reply({ kind: "window", revision, id: command.id, result: current.render(command.start, command.count) });
    }
  } catch {
    reply({ kind: "error", revision });
  }
};
