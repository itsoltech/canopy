<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { shake, swap } from "#lib/shared/ui/motion.ts";
  import Textarea from "#lib/shared/ui/Textarea.svelte";

  /**
   * Inline edit of a queued message (it keeps its place, overrides and files): the text grows with its
   * content, Enter saves, Shift+Enter adds a line, Escape cancels. `onsave` answers with an error to show, if any
   * (e.g. the message started meanwhile).
   */
  let {
    text,
    onsave,
    oncancel,
    class: className,
  }: { text: string; onsave: (text: string) => Promise<string | undefined>; oncancel: () => void; class?: ClassValue } = $props();

  // svelte-ignore state_referenced_locally
  let value = $state(text);
  let saving = $state(false);
  let error = $state<string | undefined>(undefined);
  const id = $props.id();

  async function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (saving) return;
    if (value === text) return oncancel();
    saving = true;
    error = await onsave(value);
    saving = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  }
  const focus = (node: HTMLTextAreaElement) => {
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  };
</script>

<form class={["grid gap-2 p-1", className]} onsubmit={save} in:swap>
  <Textarea
    {@attach focus}
    {@attach shake(error)}
    bind:value
    name="message"
    aria-label="Edit queued message"
    aria-invalid={error ? true : undefined}
    aria-describedby={error ? `${id}-error` : undefined}
    rows={1}
    class="max-h-40 resize-none! [field-sizing:content]"
    {onkeydown}
  />
  <div class="flex items-center justify-end gap-2">
    {#if error}<p id="{id}-error" class="min-w-0 flex-1 text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400" role="alert">{error}</p>{/if}
    <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
    <Button type="submit" size="sm" loading={saving} disabled={!value.trim()}>Save</Button>
  </div>
</form>
