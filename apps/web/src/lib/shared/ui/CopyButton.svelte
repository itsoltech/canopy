<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "./IconButton.svelte";
  import { toast } from "./toast.svelte.ts";

  /** Copies `text` to the clipboard; for a moment the icon turns into a check and the label says so. */
  let { text, label = "Copy", class: className }: { text: string; label?: string; class?: ClassValue } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast("Copying is not allowed here", { tone: "error" });
      return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }
  $effect(() => () => clearTimeout(timer));
</script>

<IconButton icon={copied ? "check" : "document-duplicate"} label={copied ? "Copied" : label} size="sm" class={className} onclick={copy} />
<span class="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
