<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import type { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import type { SkillInstallerSession } from "./skill-installer-session.svelte.ts";

  let { session, command, header }: { session: SkillInstallerSession; command: string; header: Snippet<[string]> } =
    $props();

  let region: HTMLDivElement;
  let container: HTMLDivElement;
  let focusExit: HTMLDivElement;
  let terminal = $state.raw<Terminal>();
  let selection = $state("");
  const helpId = $props.id();

  $effect(() => {
    if (terminal) terminal.options.disableStdin = session.phase !== "running";
  });

  function openSignInLink(_event: MouseEvent, value: string) {
    const url = URL.parse(value);

    if (!url || url.protocol !== "https:" || url.username || url.password || url.origin === location.origin) return;

    window.open(url.href, "_blank", "noopener,noreferrer");
  }

  onMount(() => {
    let mounted = true;
    let resize: ResizeObserver | undefined;
    let finishWrite: (() => void) | undefined;
    let instance: Terminal | undefined;

    async function open() {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);

      if (!mounted) return;

      const view = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
        fontSize: 13,
        lineHeight: 1.2,
        screenReaderMode: true,
        scrollback: 2000,
        linkHandler: { activate: openSignInLink },
      });

      const fit = new FitAddon();
      instance = view;
      view.loadAddon(fit);
      view.loadAddon(new WebLinksAddon(openSignInLink));
      view.open(container);
      fit.fit();
      resize = new ResizeObserver(() => fit.fit());
      resize.observe(container);
      view.textarea?.setAttribute("aria-label", "Installer terminal");
      view.textarea?.setAttribute("aria-describedby", helpId);
      view.textarea?.setAttribute("autocomplete", "off");

      view.onData((data) => session.send(data));
      view.onBinary((data) => session.send(data, true));
      view.onSelectionChange(() => (selection = view.getSelection()));
      view.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;

        if (event.code === "Space" && event.ctrlKey && event.shiftKey) {
          event.preventDefault();
          focusExit?.focus();

          return false;
        }

        if (session.phase !== "running") return false;

        if (event.key === "Escape" || event.key === "Tab" || event.key === "Enter") event.preventDefault();

        return true;
      });
      terminal = view;

      if (session.phase !== "starting") return;
      view.focus();
      region.scrollIntoView({ block: "nearest", behavior: "instant" });
      void session.start(command, {
        size: () => ({ cols: view.cols, rows: view.rows }),
        clear: () => {
          view.reset();
          view.clearSelection();
          selection = "";
        },
        write: (output) =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
            view.write(output, resolve);
          }),
      });
    }

    void open().catch(() => {
      if (mounted) session.terminalUnavailable();
    });

    return () => {
      mounted = false;
      finishWrite?.();
      resize?.disconnect();
      instance?.dispose();
    };
  });
</script>

<div bind:this={region} class="grid min-w-0 scroll-mt-20 scroll-mb-20 gap-2">
  {@render header(selection)}
  <div
    class="min-w-0 rounded-lg border border-divider bg-black p-2 focus-within:ring-2 focus-within:ring-accent focus-within:ring-inset"
  >
    <div bind:this={container} class="h-[min(34dvh,17rem)] min-h-36 w-full"></div>
  </div>
  <div
    bind:this={focusExit}
    tabindex="-1"
    role="group"
    aria-label="Terminal keyboard help"
    class={session.active || session.outputTruncated ? "text-sm/5 text-muted" : "sr-only"}
  >
    <p id={helpId} class={session.active ? "max-sm:sr-only" : "sr-only"}>
      Press Ctrl+Shift+Space to leave the terminal.
    </p>
    {#if session.outputTruncated}<p>Showing recent output.</p>{/if}
  </div>
</div>
