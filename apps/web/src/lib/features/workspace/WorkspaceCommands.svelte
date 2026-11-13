<script lang="ts">
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import { contributeCommands } from "#lib/features/commands/commands.svelte.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { tabPath } from "@canopy/domain/workspace-modules";

  let { workspace }: { workspace: ThreadWorkspace } = $props();

  function step(delta: number) {
    const view = workspace.view;
    const ids = ["thread", ...view.tabs.map((tab) => tab.id)];
    const index = ids.indexOf(view.active);
    view.select(ids[(index + delta + ids.length) % ids.length]!);
  }

  contributeCommands(() => [
    {
      id: "workspace:select",
      title: "Switch tab",
      group: "actions",
      children: () => [
        { id: "thread", title: "Thread", group: "actions", run: () => workspace.view.select("thread") },
        ...workspace.view.tabs.map((tab) => ({
          id: tab.id,
          title: tabPath(tab),
          group: "actions" as const,
          run: () => workspace.view.select(tab.id),
        })),
      ],
    },
    {
      id: "workspace:close",
      title: "Close active tab",
      group: "actions",
      disabled: !workspace.current,
      run: () => workspace.close(workspace.view.active),
    },
    {
      id: "workspace:keep",
      title: "Keep preview tab",
      group: "actions",
      disabled: !workspace.current?.preview,
      run: () => workspace.view.keep(workspace.view.active),
    },
  ]);

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || document.querySelector("dialog:modal, [role=menu]:popover-open")) return;

    if (keybindings.matches(event, "workspace:close") && workspace.current) {
      event.preventDefault();
      workspace.close(workspace.view.active);
    }

    if (keybindings.matches(event, "workspace:keep") && workspace.current?.preview) {
      event.preventDefault();
      workspace.view.keep(workspace.view.active);
    }

    const target = event.target;

    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, [role=textbox]"))
    )
      return;

    if (keybindings.matches(event, "workspace:next")) {
      event.preventDefault();
      step(1);
    }

    if (keybindings.matches(event, "workspace:previous")) {
      event.preventDefault();
      step(-1);
    }
  }
</script>

<svelte:window onkeydown={keydown} />
