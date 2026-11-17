<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { create, type MessageInitShape } from "@bufbuild/protobuf";
  import { AgentPreviewInputSchema, type AgentPreviewEvent, type AgentPreviewInput } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { ClassValue } from "svelte/elements";
  import ViewportControls from "./ViewportControls.svelte";
  import ViewportResizeHandles from "./ViewportResizeHandles.svelte";
  import { paintPreviewFrame } from "./preview-frame.ts";

  let {
    event,
    previewId,
    enabled = true,
    emptyText = "Waiting for the first live frame…",
    notice = "",
    browser = false,
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
  let focused = $state(false);
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

  $effect(() => {
    const frame = event;
    const target = canvas;

    if (!frame?.data.length || !target) return;

    return paintPreviewFrame(target, frame, onpaint, onframeerror);
  });

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

<div class={["relative flex min-h-0 min-w-0 flex-1 flex-col", className]}>
  <div class="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
    {#if focused}
      <span class="inline-flex shrink-0 items-center gap-1.5 text-brand-700 dark:text-brand-300">
        <StatusDot tone="sky" pulse />
        Keyboard active · Esc to release
      </span>
    {:else}
      <span class="inline-flex shrink-0 items-center gap-1.5"
        ><Icon name="hand-raised" class="size-3.5" />{enabled ? "Click the screen to control it" : "Preview only"}</span
      >
    {/if}
    {#if browser}
      <ViewportControls {enabled} width={viewportWidth} height={viewportHeight} onresize={sendResize} />
    {/if}
    <span class="min-w-0 flex-1 truncate text-right" title={notice} role="status">{notice}</span>
  </div>
  <div class="relative mt-2 min-h-0 min-w-0 flex-1">
    <div
      bind:this={surface}
      bind:contentRect={surfaceBounds}
      class={[
        "absolute inset-0 flex overflow-auto rounded-lg border bg-panel p-3 outline-none",
        focused ? "border-brand-500/70 ring-2 ring-brand-500/20" : "border-divider",
      ]}
    >
      <div
        bind:this={viewport}
        class="relative m-auto shrink-0"
        style:width={frameWidth ? `${frameWidth * scale}px` : undefined}
        style:height={frameHeight ? `${frameHeight * scale}px` : undefined}
      >
        <canvas
          bind:this={canvas}
          class="block size-full rounded-sm bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:bg-zinc-900"
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
        ></canvas>
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
</div>
