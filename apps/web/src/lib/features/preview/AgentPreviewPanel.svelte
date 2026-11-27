<script lang="ts">
  import { browser } from "$app/env";
  import { onMount, tick, untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { AgentPreviewInputSchema, AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { PreviewSession } from "./preview-session.svelte.ts";
  import { previewScope, previewScopeKey } from "./preview-client.ts";
  import { isPreviewReady } from "./preview-readiness.ts";
  import { openPreviewWindow, previewWindowPath } from "./preview-window.ts";
  import AgentPreviewCanvas from "./AgentPreviewCanvas.svelte";
  import PreviewSourceMenu from "./PreviewSourceMenu.svelte";
  import PreviewStatusBar, { type PreviewStatus } from "./PreviewStatusBar.svelte";
  import PreviewToolbar from "./PreviewToolbar.svelte";
  import PreviewUnavailable from "./PreviewUnavailable.svelte";
  import type { PreviewSelection } from "./automatic-preview.svelte.ts";

  let {
    threadId,
    worker,
    active,
    selection,
    onselectionfocus,
    tool = $bindable(AgentTool.BROWSER),
    target = $bindable<AgentPreviewTarget | undefined>(),
    offline = "",
    fit = $bindable<"fit" | "actual">("fit"),
    location = "sidebar",
    onmove,
  }: {
    threadId: string;
    worker?: ui.Worker;
    active: boolean;
    selection?: PreviewSelection;
    onselectionfocus?: () => void;
    tool?: AgentTool;
    target?: AgentPreviewTarget;
    offline?: string;
    fit?: "fit" | "actual";
    location?: "sidebar" | "tab" | "window";
    onmove?: (target?: AgentPreviewTarget) => void;
  } = $props();

  const session = new PreviewSession();
  let foreground = $state(false);
  let visible = $state(false);
  let connected = $state(false);
  let root = $state<HTMLDivElement>();
  let retry = $state(0);
  let expanded = $state(false);
  const canOpenWindow = browser && (!window.canopyDesktop || Boolean(window.canopyDesktop.openPreviewWindow));
  let openingWindow = $state(false);
  let windowError = $state("");
  let focusAddress = $state<(() => void) | undefined>();
  let focusedSelection: PreviewSelection | undefined;
  const item = $derived(worker?.agentTools.find((entry) => entry.tool?.tool === tool));

  const unavailable = $derived(
    offline ||
      (!connected
        ? "You’re offline. Reconnect to open this preview."
        : !worker?.online
          ? "Reconnect this computer to open a live preview."
          : ""),
  );

  const allowed = $derived(!unavailable && Boolean(item?.enabled && isPreviewReady(item.tool) && !item.blockedReason));
  const live = $derived(["ready", "frame"].includes(session.state));
  const failed = $derived(["error", "closed"].includes(session.state));
  const interactive = $derived(live && Boolean(session.frame));
  let focused = $state(false);

  const status = $derived.by((): PreviewStatus => {
    if (live && !session.frame) return { label: "Waiting", tone: "neutral" };

    if (live) return { label: session.mode === "screenshots" ? "Screenshots" : "Live", tone: "emerald" };

    if (failed) return { label: "Disconnected", tone: "rose" };

    return { label: allowed ? "Connecting…" : "Not ready", tone: "neutral" };
  });

  const scopeKey = $derived(previewScopeKey(threadId, worker?.id ?? "", tool, target));

  $effect(() => {
    const requested = selection;
    const element = root;

    if (!requested || !active || !element || requested === focusedSelection) return;
    focusedSelection = requested;
    void tick().then(() => {
      if (element.isConnected && untrack(() => active)) {
        element.querySelector("button")?.focus({ preventScroll: true });
        onselectionfocus?.();
      }
    });
  });

  onMount(() => {
    const sync = () => {
      foreground = document.visibilityState === "visible";
      connected = navigator.onLine;
    };

    const observer = new IntersectionObserver((entries) => (visible = Boolean(entries.at(-1)?.isIntersecting)));
    const fullscreenChanged = () => (expanded = document.fullscreenElement === root);

    if (root) observer.observe(root);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("fullscreenchange", fullscreenChanged);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("fullscreenchange", fullscreenChanged);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  });

  $effect(() => {
    void scopeKey;
    void retry;

    if (!active || !foreground || !visible || !allowed) return;

    return untrack(() => session.connect(threadId, previewScope(tool, target)));
  });

  function chooseTool(value: AgentTool): void {
    tool = value;
    target = undefined;
  }

  function chooseTarget(value: AgentPreviewTarget): void {
    if (tool === AgentTool.BROWSER) {
      session.input(create(AgentPreviewInputSchema, { kind: "tab", text: value.id }));
    } else target = value;
  }

  async function move(): Promise<void> {
    const selected = session.targets.find((entry) => entry.id === session.targetId) ?? target;

    if (document.fullscreenElement === root) await document.exitFullscreen();
    expanded = false;
    onmove?.(selected);
  }

  async function openWindow(): Promise<void> {
    if (openingWindow) return;
    openingWindow = true;
    windowError = "";
    const selected = session.targets.find((entry) => entry.id === session.targetId) ?? target;

    try {
      if (!(await openPreviewWindow(previewWindowPath(threadId, worker?.id ?? "", tool, fit, selected))))
        windowError = "The browser blocked the preview window. Allow pop-ups for Canopy and try again.";
    } catch {
      windowError = "Could not open the preview window. Try again.";
    } finally {
      openingWindow = false;
    }
  }

  async function toggleExpanded(): Promise<void> {
    if (!root) return;

    if (location === "window") expanded = !expanded;
    else if (document.fullscreenElement === root) await document.exitFullscreen();
    else if (expanded) expanded = false;
    else {
      try {
        await root.requestFullscreen();
      } catch {
        expanded = true;
      }
    }
  }
</script>

<div
  bind:this={root}
  class={[
    "density-chrome @container flex h-full min-h-0 min-w-0 flex-col bg-surface text-ink",
    expanded && "fixed inset-0 z-50 h-dvh w-screen",
  ]}
>
  <div class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-divider px-2 py-1.5">
    <PreviewSourceMenu {tool} onchange={chooseTool} />
    {#if allowed}
      <PreviewToolbar
        {tool}
        url={session.url}
        targets={session.targets}
        targetId={tool === AgentTool.BROWSER ? session.targetId : target?.id || session.targetId}
        enabled={live}
        oninput={(input) => session.input(input)}
        onselect={chooseTarget}
        bind:focusAddress
        class="order-last flex-1 basis-full @md:order-none @md:basis-0"
      />
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-0.5">
      <IconButton
        size="sm"
        icon={fit === "fit" ? "arrows-pointing-out" : "arrows-pointing-in"}
        label={fit === "fit" ? "Show actual size" : location === "window" ? "Fit to window" : "Fit to panel"}
        disabled={!live}
        onclick={() => (fit = fit === "fit" ? "actual" : "fit")}
      />
      {#if onmove}
        <DropdownMenu label="Preview placement" placement="bottom-end">
          {#snippet trigger(props)}
            <IconButton size="sm" icon="ellipsis-horizontal" label="More preview actions" {...props} />
          {/snippet}
          <MenuItem
            icon={location === "sidebar" ? "square-2-stack" : "view-columns"}
            onselect={() => void move().catch(() => {})}
            >{location === "sidebar" ? "Open in tab" : "Open in sidebar"}</MenuItem
          >
          {#if canOpenWindow}
            <MenuItem icon="window" disabled={openingWindow} onselect={() => void openWindow()}
              >Open in new window</MenuItem
            >
          {/if}
        </DropdownMenu>
      {/if}
      <IconButton
        size="sm"
        icon={expanded ? "arrows-pointing-in" : "arrow-top-right-on-square"}
        label={expanded ? (location === "window" ? "Restore preview" : "Exit fullscreen") : "Expand preview"}
        onclick={() => void toggleExpanded().catch(() => {})}
      />
    </div>
  </div>
  {#if windowError}
    <p class="border-b border-divider px-3 py-2 text-xs text-rose-700 dark:text-rose-400" role="alert">{windowError}</p>
  {/if}
  {#if allowed}
    {#if failed}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p class="text-sm/5 font-medium">Preview unavailable</p>
        <p class="max-w-72 text-sm/5 text-muted">Check the connection and tool status, then retry.</p>
        <Button size="sm" icon="arrow-path" onclick={() => retry++}>Retry preview</Button>
        {#if session.detail}<div class="max-w-72 text-sm/5 text-muted">
            <Disclosure>
              {#snippet summary()}Show details{/snippet}
              <p class="pt-2 break-words">{session.detail}</p>
            </Disclosure>
          </div>{/if}
      </div>
    {:else}
      <AgentPreviewCanvas
        event={session.frame}
        previewId={session.previewId}
        enabled={interactive}
        emptyText={session.detail || "Waiting for the first live frame…"}
        notice={session.frame ? session.notice : ""}
        bind:fit
        bind:focused
        browser={tool === AgentTool.BROWSER}
        onaddress={tool === AgentTool.BROWSER ? focusAddress : undefined}
        oninput={(input) => session.input(input)}
        onpaint={(frame) => session.painted(frame)}
        onframeerror={(frame) => session.frameError(frame)}
      />
    {/if}
  {:else}
    <PreviewUnavailable {worker} {tool} {item} offline={unavailable} standalone={location === "window"} />
  {/if}
  <PreviewStatusBar
    status={unavailable ? undefined : status}
    context={`${worker?.name || "Computer"} · ${session.title || target?.label || "This thread"}`}
    focused={focused && interactive}
    {interactive}
    viewport={allowed && !failed && tool === AgentTool.BROWSER && session.frame
      ? {
          width: session.frame.viewportWidth || session.frame.width,
          height: session.frame.viewportHeight || session.frame.height,
          enabled: interactive,
        }
      : undefined}
    size={session.frame}
    onresize={(width, height) => {
      if (interactive) session.input(create(AgentPreviewInputSchema, { kind: "resize", width, height }));
    }}
  />
</div>
