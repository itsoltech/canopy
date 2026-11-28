<script lang="ts">
  import type { EditorControls } from "#lib/features/mentions/editor.ts";
  import { quoteOf } from "#lib/features/mentions/editor.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import type { QuoteDraft } from "./quote.ts";
  import CitationPreview from "./CitationPreview.svelte";

  let { editor }: { editor: EditorControls | undefined } = $props();
  let preview = $state<{ quote: QuoteDraft; anchor: HTMLElement }>();
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = $props.id();

  $effect(() => {
    if (!open || !preview) return;
    const chip = preview.anchor;
    chip.setAttribute("aria-describedby", id);

    return () => chip.removeAttribute("aria-describedby");
  });

  function close() {
    clearTimeout(timer);
    timer = setTimeout(() => (open = false), 150);
  }

  $effect(() => {
    const root = editor?.root;

    if (!root) return;

    const show = (event: Event) => {
      if (event instanceof PointerEvent && (event.pointerType === "touch" || event.buttons !== 0)) return;

      const chip =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-element="citation"]') : null;

      if (!chip || (event.type === "focusin" && !chip.matches(":focus-visible"))) return;
      const quote = quoteOf(chip);

      if (!quote) return;
      chip.removeAttribute("title");
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          preview = { quote, anchor: chip };
          open = true;
        },
        event.type === "focusin" ? 0 : 400,
      );
    };

    const cancelPending = () => clearTimeout(timer);

    root.addEventListener("pointerover", show);
    root.addEventListener("pointerout", close);
    root.addEventListener("focusin", show);
    root.addEventListener("focusout", close);
    root.addEventListener("pointerdown", cancelPending);

    return () => {
      clearTimeout(timer);
      root.removeEventListener("pointerover", show);
      root.removeEventListener("pointerout", close);
      root.removeEventListener("focusin", show);
      root.removeEventListener("focusout", close);
      root.removeEventListener("pointerdown", cancelPending);
    };
  });
</script>

<Popover
  bind:open
  label="Citation"
  anchor={preview?.anchor}
  placement="top-start"
  focusOnOpen={false}
  morph={false}
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
