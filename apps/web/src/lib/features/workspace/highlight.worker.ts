import { WindowHighlighter } from "@canopy/syntax/window";
import type { HighlightCommand, HighlightReply } from "./highlight-protocol.ts";

const scope = self;
let current: WindowHighlighter | undefined;
let revision = 0;
const reply = (value: HighlightReply) => scope.postMessage(value);

scope.onmessage = async (event: MessageEvent<HighlightCommand>) => {
  const command = event.data;

  try {
    if (command.kind === "source") {
      revision = command.revision;
      const value = new WindowHighlighter(command.path, command.source);
      current = value;
      await value.ready();

      if (current === value) reply({ kind: "ready", revision });
    } else if (command.kind === "changes") {
      current?.change(command.changes);
      revision = command.revision;
      reply({ kind: "ready", revision });
    } else if (current && command.revision === revision) {
      reply({ kind: "window", revision, id: command.id, result: current.render(command.start, command.count) });
    }
  } catch {
    reply({ kind: "error", revision });
  }
};
