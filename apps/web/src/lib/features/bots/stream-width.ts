import type { Attachment } from "svelte/attachments";

/** Keep markdown reparsing from shrinking a live reply; a settled message gets its own natural width. */
export const retainStreamWidth: Attachment<HTMLElement> = (node) => {
  const row = node.parentElement;

  if (!row) return;
  const actions = row.querySelector('[role="toolbar"]');
  let widest = 0;

  const measure = () => {
    widest = Math.max(widest, node.getBoundingClientRect().width);
    const actionsWidth = actions?.getBoundingClientRect().width ?? 0;
    const gap = actionsWidth > 0 ? Number.parseFloat(getComputedStyle(row).columnGap) : 0;
    const available = Math.max(0, row.clientWidth - actionsWidth - gap);

    node.style.setProperty("--chat-stream-width", `min(${widest}px, var(--chat-bubble-width), ${available}px)`);
  };

  const observer = new ResizeObserver(measure);
  observer.observe(node);
  observer.observe(row);

  if (actions) observer.observe(actions);

  measure();

  return () => {
    observer.disconnect();
    node.style.removeProperty("--chat-stream-width");
  };
};
