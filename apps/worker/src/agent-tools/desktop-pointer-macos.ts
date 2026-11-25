import { runProcess } from "@canopy/process-governor";
import { agentCursor } from "@canopy/ui/agent-cursor";
import renderer from "./desktop-pointer-macos.jxa.txt" with { type: "text" };
import type { DesktopPointerAction } from "./desktop-pointer-types.ts";

export async function showMacDesktopPointer(action: DesktopPointerAction, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin" || signal.aborted) return;

  // Bun embeds the JXA program in the standalone worker. osascript receives action data as one argument.
  const result = await runProcess(
    {
      argv: ["/usr/bin/osascript", "-l", "JavaScript", "-", JSON.stringify({ ...action, glyph: agentCursor })],
      input: renderer,
      signal,
      timeoutMs: 9_000,
      maxBytes: 2048,
    },
    { kind: "utility", priority: "background", maxQueueMs: 100, signal },
  );

  if (result.code !== 0) throw new Error("Could not display the macOS desktop pointer");
}
