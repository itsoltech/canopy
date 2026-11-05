import { bindingCatalogue, type BindingDefinition, type BindingGroup } from "./binding-catalogue.ts";
import { keybindings } from "./keybindings.svelte.ts";
import type { Command } from "./registry.ts";

export function bindCommand(command: Command, parent = ""): Command {
  const bindingId = parent ? `${parent}/${command.id}` : command.id;
  const bindings = keybindings.get(bindingId, command.hotkey ? [command.hotkey] : []);

  return {
    ...command,
    bindingId,
    defaultHotkeys: command.hotkey ? [command.hotkey] : [],
    hotkey: bindings[0],
    hotkeys: bindings,
    ...(command.children && { children: () => command.children!().map((c) => bindCommand(c, bindingId)) }),
  };
}

export function flattenCommands(commands: readonly Command[], onlyAvailable: boolean): Command[] {
  return commands.flatMap((command) => {
    if (onlyAvailable && command.when && !command.when()) return [];

    return [command, ...flattenCommands(command.children?.() ?? [], onlyAvailable)];
  });
}

export function commandDefinitions(commands: readonly Command[]): BindingDefinition[] {
  const definitions = new Map(bindingCatalogue.map((d) => [d.id, d]));

  const groupOf = (command: Command): BindingGroup => {
    if (/^(theme|appearance|chat-width)\//.test(command.bindingId ?? "")) return "Appearance";

    if ((command.bindingId ?? "").startsWith("new-thread-in/")) return "Threads";

    if (command.group === "settings") return "Settings";

    if (command.group === "threads") return "Threads";

    return "Navigation";
  };

  for (const command of flattenCommands(commands, false)) {
    const id = command.bindingId ?? command.id;

    if (!definitions.has(id))
      definitions.set(id, {
        id,
        title: command.title,
        group: groupOf(command),
        context: "global",
        when: "The command is available outside modal dialogs",
        defaults: command.defaultHotkeys ?? [],
      });
  }

  return [...definitions.values()];
}
