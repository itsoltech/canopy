import type { HighlightWindow } from "@canopy/syntax/window";

export interface HighlightTask {
  id: number;
  key: string;
  path: string;
  source: string;
  start: number;
  count: number;
}

export type HighlightCommand = { prepare: HighlightTask } | { run: number };

export type HighlightReply =
  | { id: number; ready: true }
  | { id: number; result: HighlightWindow }
  | { id: number; error: string };
