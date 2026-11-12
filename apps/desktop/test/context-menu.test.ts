import { expect, test } from "bun:test";
import { browserLink, contextMenuTemplate } from "../src/context-menu-template.ts";

const context = {
  isEditable: false,
  selectionText: "Read docs/plan.md together",
  linkURL: "",
  misspelledWord: "",
  dictionarySuggestions: [],
  spellcheckEnabled: true,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: true,
    canPaste: false,
    canSelectAll: true,
    canEditRichly: false,
    canDelete: false,
  },
};

const actions = {
  copyLink: (_url: string) => {},
  openExternal: (_url: string) => {},
  replaceMisspelling: (_word: string) => {},
};

test("selection and editable menus use native roles and renderer edit permissions", () => {
  expect(contextMenuTemplate(context, actions, true)).toEqual([{ role: "copy", enabled: true }]);
  expect(contextMenuTemplate({ ...context, selectionText: "" }, actions, true)).toEqual([]);

  const items = contextMenuTemplate({ ...context, isEditable: true }, actions, true);

  expect(items.filter((item) => item.role).map((item) => [item.role, item.enabled])).toEqual([
    ["undo", false],
    ["redo", false],
    ["cut", false],
    ["copy", true],
    ["paste", false],
    ["selectAll", true],
  ]);
});

test("links can be copied but only HTTP(S) links can launch the browser", () => {
  for (const url of ["https://example.com/path?q=1", "http://example.com", "HTTPS://example.com"])
    expect(browserLink(url)).toBe(true);

  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,test",
    "mailto:user@example.com",
    "canopy://desktop",
    "ftp://example.com",
    "/relative/path",
    "not a URL",
  ]) {
    expect(browserLink(url)).toBe(false);
    expect(
      contextMenuTemplate({ ...context, selectionText: "", linkURL: url }, actions, true).map((item) => item.label),
    ).toEqual(["Copy link"]);
  }

  expect(
    contextMenuTemplate({ ...context, selectionText: "", linkURL: "https://example.com" }, actions, true).map(
      (item) => item.label,
    ),
  ).toEqual(["Copy link", "Open link in browser"]);
});

test("spelling suggestions require spellcheck both in the session and in the field", () => {
  const editable = { ...context, isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten"] };

  expect(
    contextMenuTemplate(editable, actions, true)
      .slice(0, 2)
      .map((item) => item.label),
  ).toEqual(["the", "ten"]);
  expect(contextMenuTemplate(editable, actions, false)[0]?.role).toBe("undo");
  expect(contextMenuTemplate({ ...editable, spellcheckEnabled: false }, actions, true)[0]?.role).toBe("undo");
  expect(contextMenuTemplate({ ...editable, isEditable: false }, actions, true)[0]?.role).toBe("copy");
});
