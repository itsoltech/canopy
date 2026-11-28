/** Scripts the capture runs in an isolated world of one frame (browser-capture.ts). */

// Runs in an isolated world of one frame, so page scripts cannot read or replace it. Values never enter the
// page: the worker reads field contents and picks the fields to hide. Frames are handled one by one.
export const COLLECT = `(() => {
  const FIELDS = "input, textarea, [contenteditable]";
  const fields = [];
  // Each hidden field with its own text security, to restore once whatever happens.
  globalThis.canopyHidden = new Map();
  const hideOne = (element) => {
    if (globalThis.canopyHidden.has(element)) return;
    const style = element.style;
    globalThis.canopyHidden.set(element, [style.getPropertyValue("-webkit-text-security"), style.getPropertyPriority("-webkit-text-security")]);
    style.setProperty("-webkit-text-security", "disc", "important");
  };
  // A rich text field renders through its children, which can set their own text security.
  globalThis.canopyHide = (field) => {
    hideOne(field);
    if (field.isContentEditable) for (const child of field.querySelectorAll("*")) hideOne(child);
  };
  // A field the page adds while the capture runs (a rerender, a remount, also inside a web component's open
  // shadow root) shows dots before the next paint, and is checked afterwards too.
  globalThis.canopyAdded = new Set();
  const added = (node, depth) => {
    if (!(node instanceof Element) || depth > 32) return;
    // New content inside a hidden rich text field.
    const host = node.parentElement?.closest("[contenteditable]");
    if (host && globalThis.canopyHidden.has(host)) globalThis.canopyHide(host);
    for (const field of [...(node.matches(FIELDS) ? [node] : []), ...node.querySelectorAll(FIELDS)]) {
      globalThis.canopyAdded.add(field);
      globalThis.canopyHide(field);
    }
    for (const host of [node, ...node.querySelectorAll("*")])
      if (host.shadowRoot) {
        watch(host.shadowRoot);
        for (const child of host.shadowRoot.children) added(child, depth + 1);
      }
  };
  globalThis.canopyObserver = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) added(node, 0);
  });
  const watch = (root) => globalThis.canopyObserver.observe(root, { childList: true, subtree: true });
  const visit = (root, depth) => {
    if (depth > 32) return;
    watch(root);
    for (const element of root.querySelectorAll(FIELDS)) fields.push(element);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot, depth + 1);
  };
  visit(document, 0);
  globalThis.canopyFields = fields;
  return fields.length;
})()`;

export const READ = (from: number, to: number) =>
  `globalThis.canopyFields.slice(${from}, ${to}).map((field) => field.isContentEditable ? field.textContent : field.value)`;

export const HIDE = (indices: readonly number[]) => `(() => {
  for (const index of ${JSON.stringify(indices)}) globalThis.canopyHide(globalThis.canopyFields[index]);
  return true;
})()`;

export const RESTORE = `(() => {
  globalThis.canopyObserver?.disconnect();
  for (const [field, [value, priority]] of globalThis.canopyHidden || []) {
    if (value) field.style.setProperty("-webkit-text-security", value, priority);
    else field.style.removeProperty("-webkit-text-security");
  }
  globalThis.canopyHidden = new Map();
  globalThis.canopyFields = [];
  globalThis.canopyAdded = new Set();
  globalThis.canopyChecked = [];
  return true;
})()`;

/** After a capture: every field now in the frame, and every field added meanwhile, to read with READ_CHECKED. */
export const CHECK = `(() => {
  const fields = new Set(globalThis.canopyAdded || []);
  const visit = (root, depth) => {
    if (depth > 32) return;
    for (const element of root.querySelectorAll("input, textarea, [contenteditable]")) fields.add(element);
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) visit(host.shadowRoot, depth + 1);
  };
  visit(document, 0);
  globalThis.canopyChecked = [...fields];
  return globalThis.canopyChecked.length;
})()`;

/**
 * Each checked field's text, and whether it showed as dots. A field the page removed meanwhile was hidden as it
 * was added and is no longer drawn.
 */
export const READ_CHECKED = (from: number, to: number) =>
  `globalThis.canopyChecked.slice(${from}, ${to}).map((field) => field.isConnected ? [field.isContentEditable ? field.textContent : field.value, [field, ...(field.isContentEditable ? field.querySelectorAll("*") : [])].every((element) => getComputedStyle(element).webkitTextSecurity === "disc")] : [null, true])`;
