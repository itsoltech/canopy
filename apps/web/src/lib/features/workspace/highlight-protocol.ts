import type { HighlightWindow, SourceChange } from "@canopy/syntax/window";

export type HighlightCommand =
  | { kind: "source"; revision: number; path: string; source: string }
  | { kind: "changes"; revision: number; changes: readonly SourceChange[] }
  | { kind: "window"; revision: number; id: number; start: number; count: number };

export type HighlightReply =
  | { kind: "ready"; revision: number }
  | { kind: "window"; revision: number; id: number; result: HighlightWindow }
  | { kind: "error"; revision: number };
