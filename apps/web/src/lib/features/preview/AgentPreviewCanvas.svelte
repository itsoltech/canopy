<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { create, type MessageInitShape } from "@bufbuild/protobuf";
  import { AgentPreviewInputSchema, type AgentPreviewEvent, type AgentPreviewInput } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { rise } from "#lib/shared/ui/motion.ts";
  import ViewportResizeHandles from "./ViewportResizeHandles.svelte";
  import PreviewFrame from "./PreviewFrame.svelte";

  let {
    event,
    previewId,
    enabled = true,
    emptyText = "Waiting for the first live frame…",
    notice = "",
    browser = false,
    focused = $bindable(false),
    onaddress,
    fit = $bindable("fit"),
    oninput,
    onpaint,
    onframeerror,
    class: className,
  }: {
    event?: AgentPreviewEvent;
    previewId: string;
    enabled?: boolean;
    emptyText?: string;
    notice?: string;
    browser?: boolean;
    focused?: boolean;
    onaddress?: () => void;
    fit?: "fit" | "actual";
    oninput: (input: AgentPreviewInput) => void;
    onpaint: (frame: AgentPreviewEvent) => void;
    onframeerror: (frame: AgentPreviewEvent) => void;
    class?: ClassValue;
  } = $props();

  let canvas = $state<HTMLCanvasElement>();
  let surface = $state<HTMLDivElement>();
  let surfaceBounds = $state<DOMRectReadOnly>();
  let keyboard = $state<HTMLTextAreaElement>();
  let viewport = $state<HTMLDivElement>();
  const pressed = new Map<string, string>();
  let composing = false;

  const frameWidth = $derived(event?.width || 0);
  const frameHeight = $derived(event?.height || 0);
  const viewportWidth = $derived(event?.viewportWidth || frameWidth);
  const viewportHeight = $derived(event?.viewportHeight || frameHeight);

  const scale = $derived(
    fit === "fit" && surfaceBounds && frameWidth && frameHeight
      ? Math.min(1, surfaceBounds.width / frameWidth, surfaceBounds.height / frameHeight)
      : 1,
  );

  onDestroy(() => {
    releaseKeys();
  });

  onMount(() => {
    const blur = () => {
      releaseKeys();
      focused = false;
      keyboard?.blur();
      send("release");
    };

    window.addEventListener("blur", blur);

    return () => window.removeEventListener("blur", blur);
  });

  function send(kind: string, values: MessageInitShape<typeof AgentPreviewInputSchema> = {}): void {
    if (!enabled || !previewId) return;
    oninput(create(AgentPreviewInputSchema, { kind, ...values }));
  }

  function sendResize(width: number, height: number): void {
    send("resize", { width, height });
  }

  function modifiers(event: KeyboardEvent | PointerEvent | WheelEvent): number {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }

  function coordinates(event: PointerEvent | WheelEvent) {
    const box = canvas?.getBoundingClientRect();

    if (!box || !box.width || !box.height) return { x: 0, y: 0 };

    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  }

  function focusSurface(): void {
    if (!focused) focused = true;
    keyboard?.focus({ preventScroll: true });
  }

  function releaseFocus(): void {
    releaseKeys();
    focused = false;
    keyboard?.blur();
    canvas?.focus({ preventScroll: true });
    send("release");
  }

  function releaseKeys(): void {
    for (const [code, key] of pressed) send("key-up", { key, code });
    pressed.clear();
  }

  function keydown(event: KeyboardEvent): void {
    if (!enabled || event.isComposing) return;
    event.stopPropagation();

    if (event.key === "Escape") {
      event.preventDefault();
      releaseFocus();

      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l" && onaddress) {
      event.preventDefault();
      onaddress();

      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r" && browser) {
      event.preventDefault();
      send("reload");

      return;
    }

    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key) && browser) {
      event.preventDefault();
      send(event.key === "ArrowLeft" ? "back" : "forward");

      return;
    }

    if (
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
      (event.shiftKey && event.key === "Insert")
    )
      return;

    if (event.getModifierState("AltGraph")) return;

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault();
    pressed.set(event.code, event.key);
    send("key-down", { key: event.key, code: event.code, modifiers: modifiers(event) });
  }

  function keyup(event: KeyboardEvent): void {
    if (!enabled || event.isComposing) return;
    event.stopPropagation();
    event.preventDefault();

    if (!pressed.delete(event.code)) return;
    send("key-up", { key: event.key, code: event.code, modifiers: modifiers(event) });
  }

  function inputText(): void {
    if (!keyboard || composing || !enabled) return;

    if (keyboard.value) send("text", { text: keyboard.value });
    keyboard.value = "";
  }

  function pointerdown(event: PointerEvent): void {
    if (!enabled) return;
    event.preventDefault();
    focusSurface();
    const point = coordinates(event);
    canvas?.setPointerCapture(event.pointerId);
    send("pointer-down", { ...point, button: event.button, buttons: event.buttons, modifiers: modifiers(event) });
  }

  function pointermove(event: PointerEvent): void {
    if (!enabled || !focused) return;
    const point = coordinates(event);
    send("pointer-move", { ...point, buttons: event.buttons, modifiers: modifiers(event) });
  }

  function pointerup(event: PointerEvent): void {
    if (!enabled || !focused) return;
    const point = coordinates(event);
    send("pointer-up", { ...point, button: event.button, buttons: event.buttons, modifiers: modifiers(event) });
  }

  function wheel(event: WheelEvent): void {
    if (!enabled || !focused) return;
    event.preventDefault();
    const point = coordinates(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface?.clientHeight || 1 : 1;
    send("wheel", { ...point, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, modifiers: modifiers(event) });
  }
</script>

<div class={["relative min-h-0 min-w-0 flex-1", className]}>
  <div
    bind:this={surface}
    bind:contentRect={surfaceBounds}
    class="absolute inset-0 flex overflow-auto bg-panel p-4 outline-none"
  >
    <div
      bind:this={viewport}
      class={[
        "relative m-auto shrink-0 rounded-sm transition-shadow duration-(--duration-fast) motion-reduce:transition-none",
        focused && "ring-2 ring-brand-500",
      ]}
      style:width={frameWidth ? `${frameWidth * scale}px` : undefined}
      style:height={frameHeight ? `${frameHeight * scale}px` : undefined}
    >
      <PreviewFrame
        bind:canvas
        frame={event}
        {onpaint}
        {onframeerror}
        class={[
          "block size-full rounded-sm bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-zinc-900",
          !event?.data.length && "invisible",
        ]}
        aria-label="Live screen preview"
        role="button"
        tabindex={enabled ? 0 : -1}
        onkeydown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            focusSurface();
          }
        }}
        onpointerdown={pointerdown}
        onpointermove={pointermove}
        onpointerup={pointerup}
        onpointercancel={() => send("release")}
        oncontextmenu={(event) => {
          if (focused) event.preventDefault();
        }}
        onwheel={wheel}
      />
    </div>
    <textarea
      bind:this={keyboard}
      class="pointer-events-none absolute bottom-0 left-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
      aria-label="Control preview keyboard"
      tabindex="-1"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      onfocus={() => (focused = true)}
      onblur={() => {
        releaseKeys();
        focused = false;
        send("release");
      }}
      onkeydown={keydown}
      onkeyup={keyup}
      oninput={inputText}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => {
        composing = false;
        inputText();
      }}
      onpaste={(event) => event.stopPropagation()}></textarea>
    {#if !event?.data.length}<div
        class="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm/5 text-muted"
      >
        {emptyText}
      </div>{/if}
  </div>
  {#if notice}
    <div class="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4" transition:rise>
      <p
        class="max-w-full truncate rounded-md bg-zinc-900/90 px-2.5 py-1 text-xs/5 text-white shadow-sm ring-1 ring-white/10 dark:bg-zinc-800/95"
        title={notice}
      >
        {notice}
      </p>
    </div>
  {/if}
  <p class="sr-only" role="status">{notice}</p>
  <ViewportResizeHandles
    {browser}
    {enabled}
    width={viewportWidth}
    height={viewportHeight}
    {viewport}
    {surface}
    onresize={sendResize}
  />
</div>
