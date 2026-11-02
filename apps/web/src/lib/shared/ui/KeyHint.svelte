<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Kbd from "./Kbd.svelte";

  /** A key legend entry: the keys, then what they do (`<KeyHint hotkeys={["Enter"]} label="Select" />`). */
  let { hotkeys, label, class: className }: { hotkeys: readonly string[]; label: string; class?: ClassValue } = $props();
</script>

<span class={["flex items-center gap-1.5", className]}>
  {#each hotkeys as hotkey (hotkey)}<Kbd {hotkey} />{/each}{label}
</span>
