import type { windowColors } from "./window-appearance.ts";

export interface EditShortcut {
  key: string;
  shift?: boolean;
}

export interface ComposerMenuPage {
  id: number;
  items: ({ label: string; enabled: boolean; shortcut?: EditShortcut | undefined } | null)[];
  colors: Pick<ReturnType<typeof windowColors>, "surface" | "ink" | "muted" | "border" | "hover" | "accent">;
}

export const menuRowHeight = 28;
export const menuSeparatorHeight = 9;
export const menuFrameHeight = 10;

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Edit message</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px system-ui, sans-serif; user-select: none; }
  #menu { height: 100vh; overflow: auto; padding: 4px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--surface); color: var(--ink); outline: none; }
  button { display: flex; width: 100%; height: ${menuRowHeight}px; align-items: center; justify-content: space-between;
    gap: 12px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: inherit;
    font: inherit; text-align: left; }
  button:focus { outline: none; background: var(--hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  button:disabled, kbd { color: var(--muted); }
  button span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  kbd { font: 11px system-ui, sans-serif; white-space: nowrap; }
  [role="separator"] { height: ${menuSeparatorHeight}px; padding: 4px 8px; }
  [role="separator"]::after { content: ''; display: block; height: 1px; background: var(--border); }
</style>
<div id="menu" role="menu" aria-label="Edit message" tabindex="-1"></div>
</html>`;

export const composerMenuUrl = `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
