import { ipcRenderer } from "electron";
import type { ComposerMenuPage, EditShortcut } from "./composer-menu-page.ts";

const apple = process.platform === "darwin";

function isShortcut(event: KeyboardEvent, shortcut: EditShortcut) {
  return (
    event.key.toUpperCase() === shortcut.key &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.metaKey === apple &&
    event.ctrlKey !== apple &&
    !event.altKey
  );
}

window.addEventListener(
  "DOMContentLoaded",
  () => {
    const panel = document.getElementById("menu");

    if (!panel) return;
    let current: ComposerMenuPage | undefined;
    let buttons: HTMLButtonElement[] = [];

    function choose(index: number | null) {
      if (current) ipcRenderer.send("canopy:composer-menu-choice", current.id, index);
    }

    panel.addEventListener("keydown", (event) => {
      if (!event.isTrusted || !current) return;

      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        choose(null);

        return;
      }

      const index = current.items.findIndex((item) => item?.shortcut && isShortcut(event, item.shortcut));

      if (index >= 0) {
        event.preventDefault();

        if (current.items[index]?.enabled) choose(index);

        return;
      }

      const at = buttons.findIndex((button) => button === document.activeElement);
      let next: HTMLButtonElement | undefined;

      switch (event.key) {
        case "ArrowDown":
          next = buttons[(at + 1) % buttons.length];
          break;
        case "ArrowUp":
          next = buttons.at(at <= 0 ? -1 : at - 1);
          break;
        case "Home":
          next = buttons[0];
          break;
        case "End":
          next = buttons.at(-1);
          break;
        default:
          return;
      }

      event.preventDefault();
      next?.focus();
    });

    function itemNode(item: ComposerMenuPage["items"][number], index: number) {
      if (!item) {
        const separator = document.createElement("div");
        separator.setAttribute("role", "separator");

        return separator;
      }

      const button = document.createElement("button");
      button.setAttribute("role", "menuitem");
      button.type = "button";
      button.disabled = !item.enabled;
      button.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = item.label;
      label.title = item.label;
      button.append(label);

      if (item.shortcut) {
        const { key, shift } = item.shortcut;
        const kbd = document.createElement("kbd");
        kbd.textContent = apple ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
        kbd.setAttribute("aria-hidden", "true");
        button.setAttribute("aria-keyshortcuts", `${apple ? "Meta" : "Control"}+${shift ? "Shift+" : ""}${key}`);
        button.append(kbd);
      }

      if (item.enabled) buttons.push(button);
      button.addEventListener("click", (event) => {
        if (event.isTrusted) choose(index);
      });
      button.addEventListener("pointermove", (event) => {
        if (event.isTrusted && !button.disabled && document.activeElement !== button)
          button.focus({ preventScroll: true });
      });

      return button;
    }

    ipcRenderer.on("canopy:composer-menu-render", (_event, data: ComposerMenuPage) => {
      current = data;
      buttons = [];

      for (const [name, color] of Object.entries(data.colors)) panel.style.setProperty(`--${name}`, color);
      panel.replaceChildren(...data.items.map(itemNode));
      (buttons[0] ?? panel).focus();
      ipcRenderer.send("canopy:composer-menu-rendered", data.id);
    });
  },
  { once: true },
);
