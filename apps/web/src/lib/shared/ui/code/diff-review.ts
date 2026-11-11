import type { Snippet } from "svelte";
import type { DiffPoint, DiffRange } from "@canopy/domain/diff-anchors";

export interface DiffReview {
  selection?: DiffRange | undefined;
  onstart: (point: DiffPoint, extend: boolean, drag: boolean) => void;
  onenter: (point: DiffPoint) => void;
  editorAfter?: number | undefined;
  editor?: Snippet | undefined;
}
