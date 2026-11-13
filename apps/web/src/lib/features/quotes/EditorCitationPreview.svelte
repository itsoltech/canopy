<script lang="ts">
  import type { EditorControls } from "#lib/features/mentions/editor.ts";
  import { quoteOf } from "#lib/features/mentions/editor.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import type { QuoteDraft } from "./quote.ts";
  import CitationPreview from "./CitationPreview.svelte";

  let { editor, disabled = false }: { editor: EditorControls | undefined; disabled?: boolean } = $props();
  let preview = $state<{ quote: QuoteDraft; anchor: HTMLElement }>();
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = $props.id();

  $effect(() => {
    if (disabled) open = false;
  });

  function close() {
    clearTimeout(timer);
    timer = setTimeout(() => (open = false), 150);
  }

  $effect(() => {
    const root = editor?.root;

    if (!root) return;

    const show = (event: Event) => {
      if (disabled) return;

      const chip =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-element="citation"]') : null;

      const quote = chip && quoteOf(chip);

      if (!chip || !quote) return;
      chip.removeAttribute("title");
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          preview?.anchor.removeAttribute("aria-describedby");
          preview = { quote, anchor: chip };
          chip.setAttribute("aria-describedby", id);
          open = true;
        },
        event.type === "focusin" ? 0 : 400,
      );
    };

    const hide = () => {
      clearTimeout(timer);
      open = false;
    };

    root.addEventListener("pointerover", show);
    root.addEventListener("pointerout", close);
    root.addEventListener("focusin", show);
    root.addEventListener("focusout", close);
    root.addEventListener("click", hide);

    return () => {
      clearTimeout(timer);
      preview?.anchor.removeAttribute("aria-describedby");
      root.removeEventListener("pointerover", show);
      root.removeEventListener("pointerout", close);
      root.removeEventListener("focusin", show);
      root.removeEventListener("focusout", close);
      root.removeEventListener("click", hide);
    };
  });
</script>

<Popover
  bind:open
  label="Citation"
  anchor={preview?.anchor}
  placement="top-start"
  focusOnOpen={false}
  class="w-max max-w-[min(20rem,calc(100vw-1rem))]"
>
  <div
    {id}
    role="presentation"
    onpointerenter={() => clearTimeout(timer)}
    onpointerleave={close}
    onfocusin={() => clearTimeout(timer)}
    class="p-3"
  >
    {#if preview}<CitationPreview quote={preview.quote} />{/if}
  </div>
</Popover>
