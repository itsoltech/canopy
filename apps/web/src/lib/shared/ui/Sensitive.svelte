<script lang="ts">
  import { onMount } from "svelte";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import type { ClassValue } from "svelte/elements";

  /** Screen-sharing privacy for a known personal field; no scanning or transformation of arbitrary text. */
  let {
    value,
    label = "Private value",
    class: className,
  }: { value: string; label?: string; class?: ClassValue } = $props();

  let revealed = $state(false);
  let element: HTMLButtonElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let previousValue = "";

  function hide() {
    revealed = false;
    clearTimeout(timer);
    const selection = element?.ownerDocument.getSelection();

    if (selection && (element?.contains(selection.anchorNode) || element?.contains(selection.focusNode)))
      selection.removeAllRanges();
  }

  function toggle() {
    const next = !revealed;
    hide();
    revealed = next;

    if (revealed) timer = setTimeout(hide, 30_000);
  }

  function protect(event: ClipboardEvent | MouseEvent) {
    if (!revealed) event.preventDefault();
  }

  afterNavigate(hide);

  beforeNavigate(hide);

  $effect(() => {
    if (value !== previousValue) {
      previousValue = value;
      hide();
    }
  });

  onMount(() => {
    const visibility = () => {
      if (document.hidden) hide();
    };

    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);

    return () => {
      hide();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
    };
  });
</script>

<button
  bind:this={element}
  type="button"
  class={[
    "private-value rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500",
    className,
  ]}
  aria-label={revealed ? `${label}: ${value}, activate to hide` : `${label} hidden, activate to reveal`}
  aria-pressed={revealed}
  onclick={toggle}
  oncopy={protect}
  oncut={protect}
  oncontextmenu={protect}
>
  <span aria-hidden="true" class:hidden-value={!revealed}>{value}</span>
</button>

<style>
  .hidden-value {
    filter: blur(5px);
    user-select: none;
    -webkit-user-select: none;
    pointer-events: none;
  }
  .private-value {
    overflow-wrap: anywhere;
  }
</style>
