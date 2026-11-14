import { expect, test } from "bun:test";
import {
  clearVisualSession,
  rememberVisualSession,
  visualSession,
} from "../../apps/mobile/src/features/visuals/visual-session";

test("HTML run consent survives row remounts but cannot cross versions, visuals, failures or pairings", () => {
  clearVisualSession();
  expect(visualSession("visual-a", 1)?.run).toBeUndefined();
  rememberVisualSession("visual-a", 1, { run: true });
  rememberVisualSession("visual-a", 1, { height: 240 });
  // New row/fullscreen mounts read the session without inheriting another visual's consent.
  expect(visualSession("visual-a", 1)).toEqual({ run: true, height: 240 });
  expect(visualSession("visual-a", 2)?.run).toBeUndefined();
  expect(visualSession("visual-b", 1)?.run).toBeUndefined();
  // A failed renderer must remain inert after its row is virtualized away and then mounted again.
  rememberVisualSession("visual-a", 1, { run: false });
  expect(visualSession("visual-a", 1)).toEqual({ run: false, height: 240 });
  rememberVisualSession("visual-b", 1, { run: true });
  clearVisualSession();
  expect(visualSession("visual-a", 1)).toBeUndefined();
  expect(visualSession("visual-b", 1)).toBeUndefined();
});
