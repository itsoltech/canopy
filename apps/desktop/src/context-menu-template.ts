import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

interface ContextMenuActions {
  copyLink(url: string): void;
  openExternal(url: string): void;
  replaceMisspelling(word: string): void;
}

type MenuContext = Pick<
  ContextMenuParams,
  | "editFlags"
  | "isEditable"
  | "selectionText"
  | "misspelledWord"
  | "dictionarySuggestions"
  | "spellcheckEnabled"
  | "linkURL"
>;

/** External navigation from a message must never launch a local file or another protocol handler. */
export function browserLink(url: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function contextMenuTemplate(
  params: MenuContext,
  actions: ContextMenuActions,
  spellcheck: boolean,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags;

  if (params.isEditable) {
    if (spellcheck && params.spellcheckEnabled && params.misspelledWord && params.dictionarySuggestions.length) {
      for (const word of params.dictionarySuggestions)
        items.push({ label: word, click: () => actions.replaceMisspelling(word) });
      items.push({ type: "separator" });
    }

    items.push(
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    );
  } else if (params.selectionText) items.push({ role: "copy", enabled: flags.canCopy });

  if (params.linkURL) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: "Copy link", click: () => actions.copyLink(params.linkURL) });

    if (browserLink(params.linkURL))
      items.push({
        label: "Open link in browser",
        click: () => {
          if (browserLink(params.linkURL)) actions.openExternal(params.linkURL);
        },
      });
  }

  return items;
}
