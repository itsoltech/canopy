export type BindingContext = "global" | "thread" | "composer" | "selection" | "models";

export type BindingGroup = "Navigation" | "Threads" | "Composer" | "Messages" | "Models" | "Appearance" | "Settings";

export interface BindingDefinition {
  id: string;
  title: string;
  group: BindingGroup;
  context: BindingContext;
  when: string;
  defaults: readonly string[];
}

const define = (
  id: string,
  title: string,
  group: BindingGroup,
  context: BindingContext,
  when: string,
  defaults: string[] = [],
): BindingDefinition => ({ id, title, group, context, when, defaults });

export const bindingCatalogue: readonly BindingDefinition[] = [
  define("command-palette", "Open command palette", "Navigation", "global", "Anywhere, including dialogs", ["Mod+K"]),
  define("new-thread", "Create thread in current project", "Threads", "global", "Outside modal dialogs", [
    "Mod+Shift+O",
  ]),
  define("toggle-sidebar", "Toggle sidebar", "Navigation", "global", "Outside modal dialogs", ["Mod+B"]),
  define("open-settings", "Open settings", "Navigation", "global", "Outside modal dialogs"),
  define("new-project", "Add project", "Navigation", "global", "Outside modal dialogs"),
  define(
    "new-thread-in",
    "Create thread in project",
    "Threads",
    "global",
    "Multiple projects available outside modal dialogs",
  ),
  define("theme", "Change theme", "Appearance", "global", "Outside modal dialogs"),
  define("appearance", "Change appearance", "Appearance", "global", "Outside modal dialogs"),
  define("chat-width", "Set thread width", "Appearance", "global", "Outside modal dialogs"),
  ...[
    ["interrupt", "Interrupt", "A thread is working"],
    ["side", "Create side thread", "A worker thread can branch"],
    ["fork", "Fork thread", "A thread can fork"],
    ["schedule", "Schedule a task", "A thread can schedule work"],
    ["model", "Set model and effort", "An open thread"],
    ["regenerate-title", "Regenerate title", "An open thread"],
    ["permissions", "Set permissions", "An open thread"],
    ["goal", "Set or replace goal", "A worker thread supports goals"],
    ["details", "Toggle thread details", "A thread is open"],
    ["copy-link", "Copy thread link", "A thread is open"],
    ["copy-id", "Copy thread id", "A thread is open"],
    ["copy-cwd", "Copy working directory", "A thread is open"],
  ].map(([id, title, when]) => define(`thread:${id}`, title!, "Threads", "thread", `${when} outside modal dialogs`)),
  ...["pin", "rename", "archive", "delete", "read", "filter"].map((id) =>
    define(
      `thread-action:${id}`,
      `${id[0]!.toUpperCase()}${id.slice(1)} thread`,
      "Threads",
      "thread",
      "A thread is open outside modal dialogs",
    ),
  ),
  define("composer:send", "Send message", "Composer", "composer", "A message can be sent from the focused composer", [
    "Enter",
  ]),
  define(
    "composer:alternate",
    "Queue or steer message",
    "Composer",
    "composer",
    "Queue or steer is available in the focused composer",
    ["Mod+Enter"],
  ),
  define("message:quote", "Quote selected text", "Messages", "selection", "A quotable selection in thread messages", [
    "Alt+Q",
  ]),
  define("model:favorite", "Toggle favorite model", "Models", "models", "Model picker open with an active model", [
    "Mod+Shift+F",
  ]),
  define("model:next-tab", "Show next model tab", "Models", "models", "Model picker open", ["Alt+ArrowDown"]),
  define("model:previous-tab", "Show previous model tab", "Models", "models", "Model picker open", ["Alt+ArrowUp"]),
  ...Array.from({ length: 9 }, (_, i) =>
    define(`model:pick-${i + 1}`, `Choose favorite model ${i + 1}`, "Models", "models", "Model picker open", [
      `Mod+${i + 1}`,
    ]),
  ),
];

export function contextsOverlap(a: BindingContext, b: BindingContext): boolean {
  if (a === b || a === "global" || b === "global") return true;

  return (a === "thread" && b !== "models") || (b === "thread" && a !== "models");
}
