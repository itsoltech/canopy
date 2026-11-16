<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { AgentPreviewInputSchema, AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
  import Select from "#lib/shared/ui/Select.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { PreviewSession } from "./preview-session.svelte.ts";
  import { previewScope } from "./preview-client.ts";
  import { isPreviewReady } from "./preview-readiness.ts";
  import AgentPreviewCanvas from "./AgentPreviewCanvas.svelte";
  import PreviewToolbar from "./PreviewToolbar.svelte";
  import PreviewUnavailable from "./PreviewUnavailable.svelte";
  import type { PreviewSelection } from "./automatic-preview.svelte.ts";

  let {
    threadId,
    worker,
    active,
    selection,
    offline = "",
  }: {
    threadId: string;
    worker?: ui.Worker;
    active: boolean;
    selection?: PreviewSelection;
    offline?: string;
  } = $props();

  const session = new PreviewSession();
  let tool = $state(AgentTool.BROWSER);
  let target = $state<AgentPreviewTarget>();
  let foreground = $state(false);
  let visible = $state(false);
  let connected = $state(false);
  let root = $state<HTMLDivElement>();
  let fit = $state<"fit" | "actual">("fit");
  let retry = $state(0);
  let expanded = $state(false);
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

  // A mini preview hands its scope over once; later tool calls preserve the user's sidebar selection.
  $effect(() => {
    if (!selection) return;
    tool = selection.tool;
    target = selection.target;
  });

  $effect(() => {
    const requested = selection;
    const element = root;

    if (!requested || !active || !element || requested === focusedSelection) return;
    focusedSelection = requested;
    void tick().then(() => {
      if (element.isConnected && untrack(() => active)) element.querySelector("button")?.focus({ preventScroll: true });
    });
  });

  onMount(() => {
    const sync = () => {
      foreground = document.visibilityState === "visible";
      connected = navigator.onLine;
    };

    const observer = new IntersectionObserver(([entry]) => (visible = Boolean(entry?.isIntersecting)));
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
    const id = threadId;
    const scope = previewScope(tool, target);
    void retry;

    if (!active || !foreground || !visible || !allowed) return;

    return untrack(() => session.connect(id, scope));
  });

  function chooseTool(value: string): void {
    tool = Number(value);
    target = undefined;
  }

  function chooseTarget(value: AgentPreviewTarget): void {
    if (tool === AgentTool.BROWSER) {
      session.input(create(AgentPreviewInputSchema, { kind: "tab", text: value.id }));
    } else target = value;
  }

  async function fullscreen(): Promise<void> {
    if (!root) return;

    if (document.fullscreenElement === root) await document.exitFullscreen();
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
    "density-chrome flex h-full min-h-0 min-w-0 flex-col bg-surface text-ink",
    expanded && "fixed inset-0 z-50 h-dvh w-screen",
  ]}
>
  <div class="flex min-h-11 shrink-0 items-center gap-2 border-b border-divider px-3">
    <div class="min-w-0 flex-1">
      <Select
        inline="muted"
        aria-label="Preview target"
        value={String(tool)}
        options={[
          { value: String(AgentTool.BROWSER), label: "Browser", icon: "globe-alt" },
          { value: String(AgentTool.DEVICE), label: "Device", icon: "square" },
          { value: String(AgentTool.DESKTOP), label: "Desktop", icon: "computer-desktop" },
        ]}
        onchange={chooseTool}
      />
    </div>
    <div class="flex shrink-0 items-center gap-1.5 text-xs text-muted" role="status">
      <StatusDot tone={live && session.frame ? "emerald" : failed ? "rose" : "neutral"} />
      {unavailable
        ? "Offline"
        : live && !session.frame
          ? "Waiting"
          : live
            ? session.mode === "screenshots"
              ? "Screenshots"
              : "Live"
            : failed
              ? "Disconnected"
              : allowed
                ? "Connecting…"
                : "Not ready"}
    </div>
    <IconButton
      size="sm"
      icon="arrows-pointing-out"
      label={fit === "fit" ? "Show actual size" : "Fit to panel"}
      disabled={!live}
      onclick={() => (fit = fit === "fit" ? "actual" : "fit")}
    />
    <IconButton
      size="sm"
      icon="arrow-top-right-on-square"
      label={expanded ? "Exit fullscreen" : "Expand preview"}
      onclick={() => void fullscreen().catch(() => {})}
    />
  </div>
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
    />
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
      <div class="flex min-h-0 flex-1 flex-col p-3">
        <AgentPreviewCanvas
          event={session.frame}
          previewId={session.previewId}
          enabled={live && Boolean(session.frame)}
          emptyText={session.detail || "Waiting for the first live frame…"}
          notice={session.frame ? session.notice : ""}
          bind:fit
          browser={tool === AgentTool.BROWSER}
          onaddress={tool === AgentTool.BROWSER ? focusAddress : undefined}
          oninput={(input) => session.input(input)}
        />
      </div>
    {/if}
  {:else}
    <PreviewUnavailable {worker} {tool} {item} offline={unavailable} />
  {/if}
  <div
    class="flex h-8 shrink-0 items-center gap-2 border-t border-divider px-3 text-xs text-muted"
    title={`${worker?.name || "Computer"} · ${session.title || target?.label || "This thread"}`}
  >
    <span class="min-w-0 flex-1 truncate"
      >{worker?.name || "Computer"} · {session.title || target?.label || "This thread"}</span
    >
    {#if session.frame?.width}<span class="shrink-0 tabular-nums">{session.frame.width} × {session.frame.height}</span
      >{/if}
  </div>
</div>
