<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { buttonClasses } from "#lib/shared/ui/button.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  /**
   * The small raised "Cite" button over a selection (CiteLayer places it). It never takes the selection away:
   * pressing it keeps the text selected until the click inserts its inline token. Other attributes and
   * attachments (positioning, tooltip) go on the button.
   */
  let {
    element = $bindable(),
    class: className,
    ...rest
  }: Omit<HTMLButtonAttributes, "class" | "type"> & {
    element?: HTMLButtonElement | undefined;
    class?: ClassValue;
  } = $props();
</script>

<button
  bind:this={element}
  type="button"
  class={[
    buttonClasses("secondary", "sm", true),
    "overflow-visible shadow-lg dark:bg-zinc-800 dark:not-disabled:hover:bg-zinc-700",
    className,
  ]}
  onpointerdown={(event) => event.preventDefault()}
  {...rest}
>
  <Icon name="chat-bubble-bottom-center-text" class="fill-zinc-500 dark:fill-zinc-400" />
  Cite
  <TouchTarget />
</button>
