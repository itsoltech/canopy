<script lang="ts">
  import { QUOTE_LIMITS } from "@canopy/domain";
  import type { EditorControls } from "#lib/features/mentions/editor.ts";
  import { quoteOf } from "#lib/features/mentions/editor.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { useCitationSource } from "./citation-source.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { QuoteDraft } from "./quote.ts";
  import EditorCitationPreview from "./EditorCitationPreview.svelte";

  let { editor, quotes }: { editor: EditorControls | undefined; quotes: readonly QuoteDraft[] } = $props();
  const revealSource = useCitationSource();
  let selected = $state<{ quote: QuoteDraft; anchor: HTMLElement }>();
  let open = $state(false);
  let excerpt = $state("");
  let comment = $state("");

  $effect(() => {
    void quotes;
    const root = editor?.root;

    if (!root) return;

    const activate = (event: Event) => {
      const chip =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-element="citation"]') : null;

      const quote = chip && quoteOf(chip);

      if (!chip || !quote) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selected = { quote, anchor: chip };
      excerpt = quote.text;
      comment = quote.comment;
      open = true;
    };

    const keydown = (event: KeyboardEvent) => {
      if (event.target === root) return;

      const chip =
        event.target instanceof HTMLElement && event.target.closest<HTMLElement>('[data-element="citation"]');

      if (!chip) return;

      if (event.key === "Enter" || event.key === " ") activate(event);
      else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        event.stopImmediatePropagation();
        editor?.replaceQuote(chip);
      }
    };

    root.addEventListener("click", activate);
    root.addEventListener("keydown", keydown, true);

    return () => {
      root.removeEventListener("click", activate);
      root.removeEventListener("keydown", keydown, true);
    };
  });

  function save() {
    if (!selected || !excerpt.trim()) return;
    open = false;
    editor?.replaceQuote(selected.anchor, { ...selected.quote, text: excerpt, comment });
  }

  async function reveal() {
    if (!selected) return;
    open = false;

    if (!(await revealSource(create(ui.QuoteSchema, selected.quote))))
      toast("Could not find the source. Try loading earlier messages.", { tone: "error" });
  }
</script>

<EditorCitationPreview {editor} disabled={open} />

<Popover
  bind:open
  label="Edit citation"
  anchor={selected?.anchor}
  placement="top-start"
  class="w-80 max-w-[calc(100vw-1rem)]"
>
  <form
    class="grid gap-3 p-3"
    onsubmit={(event) => {
      event.preventDefault();
      save();
    }}
  >
    <Textarea
      name="excerpt"
      aria-label="Quoted passage"
      bind:value={excerpt}
      rows={3}
      maxlength={QUOTE_LIMITS.maxTextChars}
      data-autofocus
      resize={false}
      class="max-h-60"
    />
    <Textarea
      name="comment"
      aria-label="Comment (optional)"
      bind:value={comment}
      rows={2}
      maxlength={QUOTE_LIMITS.maxCommentChars}
      resize={false}
    />
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" onclick={reveal}>Jump to source</Button>
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" disabled={!excerpt.trim()}>Save</Button>
    </div>
  </form>
</Popover>
