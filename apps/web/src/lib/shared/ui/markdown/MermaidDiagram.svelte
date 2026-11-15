<script lang="ts">
  import { currentVisualTheme, onVisualThemeChange } from "#lib/features/visuals/visual-theme.ts";
  import CopyButton from "../CopyButton.svelte";
  import IconButton from "../IconButton.svelte";
  import CodeFrame from "../code/CodeFrame.svelte";
  import CodeLines from "../code/CodeLines.svelte";
  import { renderMermaid } from "./mermaid.ts";

  /**
   * A ` ```mermaid ` fence drawn as a diagram in Canopy's colours, redrawn when the appearance changes. The source
   * stays one click away; a diagram Mermaid cannot parse shows its source with a short note.
   */
  let { code, lang }: { code: string; lang: string } = $props();

  let source = $state(false);
  let svg = $state<string>();
  let failed = $state(false);
  let theme = $state(currentVisualTheme());
  let canvas = $state<HTMLDivElement>();

  // Fit the width, but shrink to 90% at most: past that a wide diagram scrolls sideways (phones).
  $effect(() => {
    void svg;
    const drawing = canvas?.querySelector("svg");
    const width = drawing?.viewBox.baseVal?.width;

    if (drawing && width) drawing.style.minWidth = `${Math.round(width * 0.9)}px`;
  });

  $effect(() =>
    onVisualThemeChange(() => {
      const next = currentVisualTheme();

      if (JSON.stringify(next) !== JSON.stringify(theme)) theme = next;
    }),
  );

  $effect(() => {
    let active = true;

    renderMermaid(code, theme).then(
      (value) => {
        if (!active) return;
        svg = value;
        failed = false;
      },
      () => {
        if (!active) return;
        svg = undefined;
        failed = true;
      },
    );

    return () => {
      active = false;
    };
  });
</script>

<CodeFrame class="code-fence">
  {#snippet header()}
    <p class="min-w-0 truncate pl-3 font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">{lang}</p>
    <div class="flex shrink-0 items-center">
      {#if !failed}
        <IconButton
          icon={source ? "eye" : "code-bracket"}
          label={source ? "Show diagram" : "Show source"}
          size="sm"
          onclick={() => (source = !source)}
        />
      {/if}
      <CopyButton text={code} label="Copy code" />
    </div>
  {/snippet}
  {#if source || failed}
    {#if failed}<p class="px-3 pt-2 text-xs/5 text-muted">Mermaid cannot draw this diagram. Check its syntax.</p>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre
      data-quote-kind="code"
      data-quote-lang={lang}
      class="max-h-[32rem] code-surface p-3 text-zinc-800 focus-ring dark:text-zinc-200"
      tabindex="0"><CodeLines text={code} /></pre>
  {:else if svg}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={canvas}
      class="max-h-[40rem] overflow-auto p-4 focus-ring *:mx-auto *:block"
      tabindex="0"
      role="region"
      aria-label="Diagram"
    >
      <!-- Mermaid's SVG: `securityLevel: "strict"` sanitises it (DOMPurify), so labels carry no markup or scripts. -->
      {@html svg}
    </div>
  {:else}
    <p role="status" class="p-3 text-sm text-muted">Drawing the diagram…</p>
  {/if}
</CodeFrame>
