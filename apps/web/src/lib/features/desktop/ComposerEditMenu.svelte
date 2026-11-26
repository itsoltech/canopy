<script lang="ts">
  import type { DesktopComposerMenu, DesktopComposerMenuResponse } from "@canopy/ui/desktop";
  import { beforeNavigate } from "$app/navigation";
  import { onMount } from "svelte";
  import { matchesHotkey } from "#lib/shared/ui/hotkeys.ts";
  import { focusItem, menuKeydown, provideMenu } from "#lib/shared/ui/menu.ts";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";

  interface OpenMenu {
    offer: DesktopComposerMenu;
    editor: HTMLElement;
    restoreSelection: () => void;
    x: number;
    y: number;
  }

  let invocation: MouseEvent | undefined;
  let current = $state.raw<OpenMenu>();
  let positionAnchor = $state<HTMLSpanElement>();
  let open = $state(false);
  const navigate = menuKeydown();

  provideMenu({ openSub: undefined, closeAll: () => (open = false) });

  function respond(id: number, answer: DesktopComposerMenuResponse) {
    return window.canopyDesktop?.composerMenu?.respond(id, answer).catch(() => false);
  }

  function rememberSelection(editor: HTMLElement) {
    if (editor instanceof HTMLTextAreaElement) {
      const { selectionStart, selectionEnd, selectionDirection } = editor;

      return () => editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }

    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const backward = selection?.direction === "backward";

    return () => {
      if (!selection || !range || !editor.contains(range.startContainer) || !editor.contains(range.endContainer))
        return;
      const { startContainer, startOffset, endContainer, endOffset } = range;

      if (backward) selection.setBaseAndExtent(endContainer, endOffset, startContainer, startOffset);
      else selection.setBaseAndExtent(startContainer, startOffset, endContainer, endOffset);
    };
  }

  async function show(offer: DesktopComposerMenu) {
    const event = invocation;
    const target = event?.target;

    const editor =
      target instanceof Element && target.closest("[data-composer-editor]")
        ? target.closest("[contenteditable], textarea")
        : undefined;

    if (
      !event ||
      event.defaultPrevented ||
      performance.now() - event.timeStamp > 500 ||
      !(editor instanceof HTMLElement) ||
      !(editor.isContentEditable || editor instanceof HTMLTextAreaElement)
    ) {
      void respond(offer.id, "native");

      return;
    }

    const restoreSelection = rememberSelection(editor);

    if (!(await respond(offer.id, "show"))) return;

    if (event !== invocation || !editor.isConnected) {
      void respond(offer.id, "dismiss");

      return;
    }

    invocation = undefined;
    const anchor = offer.keyboard && event.clientX === 0 && event.clientY === 0 ? editor.getBoundingClientRect() : null;
    current = { offer, editor, restoreSelection, x: anchor?.left ?? event.clientX, y: anchor?.bottom ?? event.clientY };
    open = true;
  }

  function dismiss() {
    invocation = undefined;
    open = false;
  }

  beforeNavigate(dismiss);

  onMount(() => {
    const bridge = window.canopyDesktop?.composerMenu;

    if (!bridge) return;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const forgetInvocation = () => (invocation = undefined);

    // Pair Electron's edit state with the actual DOM target and CSS coordinates, including at non-default zoom.
    window.addEventListener(
      "contextmenu",
      (event) => {
        if (!event.isTrusted) return;
        open = false;
        invocation = event;
      },
      options,
    );
    window.addEventListener("pointerdown", forgetInvocation, options);
    window.addEventListener("keydown", forgetInvocation, options);
    window.addEventListener("blur", dismiss, { signal: controller.signal });
    const unsubscribe = bridge.subscribe((offer) => void show(offer));

    return () => {
      controller.abort();
      unsubscribe();

      if (current) void bridge.respond(current.offer.id, "dismiss").catch(() => {});
    };
  });

  $effect(() => {
    if (!open && current) void respond(current.offer.id, "dismiss");
  });

  function focusEditor(menu: OpenMenu) {
    if (!menu.editor.isConnected || !menu.editor.matches(":read-write")) return false;
    menu.editor.focus({ preventScroll: true });

    if (document.activeElement !== menu.editor) return false;
    menu.restoreSelection();

    return true;
  }

  function choose(index: number) {
    if (open && current && focusEditor(current)) void respond(current.offer.id, index);
    open = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (!current) return;

    if (event.key === "Escape" || event.key === "Tab") {
      focusEditor(current);
      open = false;

      return;
    }

    const index = current.offer.items.findIndex((item) => item?.shortcut && matchesHotkey(event, item.shortcut));

    if (index < 0) return navigate(event);
    event.preventDefault();

    if (current.offer.items[index]?.enabled) choose(index);
  }
</script>

{#if current}
  <span
    bind:this={positionAnchor}
    aria-hidden="true"
    class="pointer-events-none fixed size-0"
    style:left={`${current.x}px`}
    style:top={`${current.y}px`}
  ></span>
{/if}

<Popover
  bind:open
  label="Edit message"
  role="menu"
  anchor={current?.editor}
  {positionAnchor}
  offset={0}
  initialFocus={(panel) => focusItem(panel, "first")}
  panelKeydown={onkeydown}
  onclose={() => {
    if (!open) current = undefined;
  }}
  class="min-w-40"
>
  <div class="p-1">
    {#each current?.offer.items ?? [] as item, index (index)}
      {#if item}
        <MenuItem disabled={!item.enabled} shortcut={item.shortcut} onselect={() => choose(index)}
          >{item.label}</MenuItem
        >
      {:else}
        <MenuSeparator />
      {/if}
    {/each}
  </div>
</Popover>
