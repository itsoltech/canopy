<script lang="ts">
  import { goto } from "$app/navigation";
  import { tick } from "svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import KeyHint from "#lib/shared/ui/KeyHint.svelte";
  import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
  import { exitDuration, pageIn } from "#lib/shared/ui/motion.ts";
  import { PALETTE_HOTKEY, type PaletteState } from "./commands.svelte.ts";
  import CommandCrumb from "./CommandCrumb.svelte";
  import CommandRow from "./CommandRow.svelte";
  import {
    actionOf,
    enterLevel,
    flatEntries,
    leaveLevel,
    levelCommands,
    moveActive,
    paletteView,
    type PaletteEntry,
    type PaletteLevel,
  } from "./palette.ts";
  import type { ClassValue } from "svelte/elements";
  import type { Command, CommandRegistry } from "./registry.ts";

  /**
   * Command palette (T3 Code's): Mod+K or `palette.show()` opens a panel over the dimmed page with a
   * search over the registry's commands, grouped (Actions, Recent threads, Projects, Settings). A
   * submenu (›) opens in place with a crumb; Backspace on an empty query, ← or the back button leave it.
   * WAI-ARIA combobox + listbox: focus stays in the input, ↑↓ Home End PageUp PageDown move the active
   * option, Enter chooses it, Escape closes. A modal `<dialog>` traps focus; closing returns it to the
   * opener. Opens and closes like the kit's dialogs (motion.css `t-modal`); centred near the top from
   * `sm`, a full-width sheet at the top on phones (the keyboard covers the bottom).
   *
   * It also binds the hotkeys the commands advertise, globally: those with a modifier work while typing
   * too, bare keys only outside text fields; none while another modal dialog is open.
   */
  let {
    registry,
    palette,
    class: className,
  }: { registry: CommandRegistry; palette: PaletteState; class?: ClassValue } = $props();

  const id = $props.id();
  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let query = $state("");
  let stack = $state.raw<PaletteLevel[]>([]);

  /** Direction of the last level change (submenu slide). */
  let direction = $state(1);
  let activeKey = $state<string>();

  /** How the active row last changed: keys scroll it into view, the pointer does not. */
  let movedBy: "key" | "pointer" = "key";
  let closing = $state(false);
  let closed: ReturnType<typeof setTimeout> | undefined;
  let opener: HTMLElement | undefined;

  const level = $derived(stack.at(-1));

  const sections = $derived(
    palette.open || closing
      ? paletteView(levelCommands(registry.list(), stack), query, { nested: Boolean(level) })
      : [],
  );

  const entries = $derived(flatEntries(sections));

  const activeIndex = $derived.by(() => {
    const index = entries.findIndex((e) => e.key === activeKey);

    return index >= 0 ? index : entries.length > 0 ? 0 : -1;
  });

  const optionId = (index: number) => `${id}-option-${index}`;

  const placeholder = $derived(
    level?.command.placeholder ?? (level ? "Search…" : "Search commands, projects, and threads…"),
  );

  $effect(() => {
    if (!dialog) return;

    if (palette.open && !dialog.open) {
      clearTimeout(closed);
      closing = false;
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      query = "";
      stack = [];
      activeKey = undefined;
      dialog.showModal();
      input?.focus();
    }

    if (!palette.open && dialog.open) {
      dialog.close();
      exit();
    }
  });

  $effect(() => () => clearTimeout(closed));

  // The active row stays in view while the keys move it (the first one scrolls the list to the top,
  // so its group heading shows).
  $effect(() => {
    const index = activeIndex;

    if (index < 0 || movedBy !== "key") return;

    if (index === 0) document.getElementById(`${id}-list`)?.scrollTo({ top: 0 });
    else document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  });

  function exit() {
    if (!dialog) return;
    closing = true;
    clearTimeout(closed);
    closed = setTimeout(() => (closing = false), exitDuration(dialog));

    // Back to the opener unless the command moved focus elsewhere (another dialog).
    if (opener?.isConnected && (document.activeElement === document.body || dialog.contains(document.activeElement)))
      opener.focus({ preventScroll: true });
  }

  function close() {
    palette.open = false;
  }

  function setLevel(next: PaletteLevel[], nextQuery: string, from: number) {
    direction = from;
    stack = next;
    query = nextQuery;
    activeKey = undefined;
    movedBy = "key";
  }

  function back(): boolean {
    if (!level) return false;
    const up = leaveLevel(stack);
    setLevel(up.stack, up.query, -1);

    return true;
  }

  /** Runs a command after the palette closed (focus is back on the opener, a dialog it opens takes it). */
  async function run(command: Command) {
    close();
    await tick();

    if (command.run) await command.run();
    else if (command.href) await goto(command.href);
  }

  function choose(entry: PaletteEntry, event?: MouseEvent) {
    const command = entry.command;
    const action = actionOf(command);

    if (action === "enter") {
      event?.preventDefault();
      setLevel(enterLevel(stack, command, query), "", 1);
      input?.focus();

      return;
    }

    if (action === "none") {
      event?.preventDefault();

      return;
    }

    if (command.href && !command.run) {
      // A link: a click follows it itself (a modifier opens a new tab); the keyboard clicks it.
      if (!event) document.getElementById(optionId(entries.indexOf(entry)))?.click();
      else close();

      return;
    }

    event?.preventDefault();
    void run(command);
  }

  function move(key: Parameters<typeof moveActive>[1]) {
    const next = moveActive(activeIndex, key, entries.length);
    movedBy = "key";
    activeKey = entries[next]?.key;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

    const keys: Record<string, Parameters<typeof moveActive>[1]> = {
      ArrowDown: "next",
      ArrowUp: "previous",
      PageDown: "pageDown",
      PageUp: "pageUp",
      Home: "first",
      End: "last",
    };

    const movement = keys[event.key];

    if (movement && (plain || event.key.startsWith("Arrow"))) {
      event.preventDefault();
      move(movement);

      return;
    }

    if (event.key === "Enter" && plain) {
      event.preventDefault();
      const entry = entries[activeIndex];

      if (entry) choose(entry);

      return;
    }

    if ((event.key === "Backspace" || event.key === "ArrowLeft") && plain && query === "" && back()) {
      event.preventDefault();

      return;
    }

    if (event.key === "ArrowRight" && plain && input?.selectionStart === query.length) {
      const entry = entries[activeIndex];

      if (entry && actionOf(entry.command) === "enter") {
        event.preventDefault();
        choose(entry);
      }
    }
  }

  const isEditable = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("input:not([type=checkbox],[type=radio],[type=button],[type=submit]), textarea, select"));

  const hasModifier = (hotkey: string) => /(^|\+)(mod|ctrl|meta|alt)\+/i.test(hotkey);

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;

    if (matchesHotkey(event, PALETTE_HOTKEY)) {
      event.preventDefault();
      palette.toggle();

      return;
    }

    if (palette.open || document.querySelector("dialog:modal")) return;
    const command = registry.list().find((c) => c.hotkey && matchesHotkey(event, c.hotkey));

    if (!command || actionOf(command) !== "run") return;

    if (isEditable(event.target) && !hasModifier(command.hotkey!)) return;
    event.preventDefault();

    if (command.run) void command.run();
    else if (command.href) void goto(command.href);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<dialog
  use:windowModal
  bind:this={dialog}
  aria-label="Command palette"
  onclose={() => {
    if (!palette.open) return;
    palette.open = false;
    exit();
  }}
  onclick={(event) => {
    if (event.target === dialog) close(); // click on the backdrop
  }}
  inert={closing || undefined}
  class={[
    "t-modal top-(--window-safe-top) m-0 mb-auto flex max-h-[min(85dvh,var(--window-safe-height))] w-full max-w-none flex-col overflow-hidden rounded-b-2xl bg-white p-0 text-zinc-950 shadow-xl ring-1 ring-zinc-950/10 not-open:hidden backdrop:bg-zinc-950/30 backdrop:backdrop-blur-xs sm:mx-auto sm:mt-[12dvh] sm:max-h-[min(36rem,76dvh,var(--window-safe-height)-12dvh)] sm:w-[calc(100%-2rem)] sm:max-w-160 sm:rounded-2xl dark:bg-zinc-900 dark:text-white dark:shadow-none dark:ring-white/10 dark:backdrop:bg-black/50",
    className,
  ]}
>
  {#if palette.open || closing}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-zinc-950/5 px-3 pt-[max(--spacing(0),env(safe-area-inset-top))] dark:border-white/8"
    >
      {#if level}
        <IconButton icon="arrow-left" label="Back" size="sm" onclick={() => (back(), input?.focus())} />
        <CommandCrumb titles={stack.map((l) => l.command.title)} />
      {:else}
        <Icon name="magnifying-glass" class="fill-zinc-400 dark:fill-zinc-500" />
      {/if}
      <input
        bind:this={input}
        bind:value={query}
        name="command"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="{id}-list"
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={level ? `Search ${level.command.title}` : "Search commands, projects, and threads"}
        {placeholder}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        oninput={() => {
          activeKey = undefined;
          movedBy = "key";
        }}
        {onkeydown}
        class="h-12 min-w-0 flex-1 bg-transparent text-base/6 text-zinc-950 placeholder:text-zinc-500 focus:outline-none sm:h-13 sm:text-sm/6 dark:text-white dark:placeholder:text-zinc-400"
      />
      <IconButton icon="x-mark" label="Close" size="sm" class="sm:hidden" onclick={close} />
    </div>

    {#key stack.length}
      <div
        id="{id}-list"
        role="listbox"
        aria-label={level?.command.title ?? "Commands"}
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 pb-[max(--spacing(1.5),env(safe-area-inset-bottom))] sm:pb-1.5"
        in:pageIn={{ from: direction }}
      >
        {#each sections as section, s (section.group ?? s)}
          <div role="group" aria-labelledby={section.label ? `${id}-group-${s}` : undefined}>
            {#if section.label}
              <div
                id="{id}-group-{s}"
                role="presentation"
                class="px-3 pt-3 pb-1 text-sm/5 font-medium text-zinc-500 first:pt-1.5 sm:text-xs/4 dark:text-zinc-400"
              >
                {section.label}
              </div>
            {/if}
            {#each section.entries as entry (entry.key)}
              {@const index = entries.indexOf(entry)}
              <CommandRow
                id={optionId(index)}
                {entry}
                active={index === activeIndex}
                onchoose={(event) => choose(entry, event)}
                onpoint={() => {
                  movedBy = "pointer";
                  activeKey = entry.key;
                }}
              />
            {/each}
          </div>
        {/each}
        {#if entries.length === 0}
          <p class="px-4 py-10 text-center text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            No results{query.trim() ? ` for “${query.trim()}”` : ""}
          </p>
        {/if}
      </div>
    {/key}
    <p class="sr-only" role="status">
      {entries.length === 0 ? "No results" : `${entries.length} ${entries.length === 1 ? "result" : "results"}`}
    </p>

    <div
      class="flex shrink-0 items-center gap-4 border-t border-zinc-950/5 px-4 py-2.5 text-xs/4 text-zinc-500 dark:border-white/8 dark:text-zinc-400 pointer-coarse:hidden"
      aria-hidden="true"
    >
      <KeyHint hotkeys={["ArrowUp", "ArrowDown"]} label="Navigate" />
      <KeyHint hotkeys={["Enter"]} label="Select" />
      {#if level}<KeyHint hotkeys={["Backspace"]} label="Back" />{/if}
      <KeyHint hotkeys={["Escape"]} label="Close" />
    </div>
  {/if}
</dialog>
