import { WindowHighlighter } from "@canopy/syntax/window";
import type { HighlightCommand, HighlightReply, HighlightTask } from "./highlight-protocol.ts";

declare const self: Worker;

const sessions = new Map<string, { value: WindowHighlighter; bytes: number; touched: number }>();
let active: { task: HighlightTask; value: WindowHighlighter } | undefined;

function trim() {
  const expiry = Date.now() - 30_000;
  let bytes = [...sessions.values()].reduce((sum, session) => sum + session.bytes, 0);

  for (const [key, session] of sessions) {
    if (session.touched > expiry && sessions.size <= 8 && bytes <= 8 * 1024 * 1024) continue;
    sessions.delete(key);
    bytes -= session.bytes;
  }
}

const timer = setInterval(trim, 30_000);

timer.unref();

const reply = (value: HighlightReply) => self.postMessage(value);

self.onmessage = async (event: MessageEvent<HighlightCommand>) => {
  if ("run" in event.data) {
    const current = active;

    if (!current || current.task.id !== event.data.run) return;
    active = undefined;

    try {
      reply({ id: current.task.id, result: current.value.render(current.task.start, current.task.count) });
    } catch {
      reply({ id: current.task.id, error: "Highlighting is unavailable. The file remains readable." });
    }

    return;
  }

  const task = event.data.prepare;

  try {
    trim();
    let session = sessions.get(task.key);

    if (!session) {
      const value = new WindowHighlighter(task.path, task.source);
      await value.ready();
      session = { value, bytes: new TextEncoder().encode(task.source).length, touched: Date.now() };
    }

    session.touched = Date.now();
    sessions.delete(task.key);
    sessions.set(task.key, session);
    trim();
    active = { task, value: session.value };
    reply({ id: task.id, ready: true });
  } catch {
    reply({ id: task.id, error: "Highlighting is unavailable. The file remains readable." });
  }
};
