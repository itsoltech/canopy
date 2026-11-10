<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { Attachment } from "svelte/attachments";
  import { observeActivity } from "../activity.ts";
  import { subscribeTime } from "../ticker.ts";
  import LiveText from "./LiveText.svelte";

  /** Only this text subscribes to the clock; ticking never invalidates a work fold or its rows. */
  let {
    format,
    active,
    shimmer = false,
    label,
    class: className,
  }: {
    format: (now: number) => string;
    active: boolean;
    shimmer?: boolean;
    label?: string;
    class?: ClassValue;
  } = $props();

  let now = $state(Date.now());
  const text = $derived(format(now));

  const watch: Attachment = (element) => {
    let stop: (() => void) | undefined;

    const disconnect = observeActivity(element, (visible) => {
      stop?.();
      stop = visible ? subscribeTime((value) => (now = value)) : undefined;
    });

    return () => {
      stop?.();
      disconnect();
    };
  };
</script>

<span class={className} aria-label={label ? `${label} ${text}` : undefined} {@attach active ? watch : undefined}>
  {#if shimmer}<LiveText {text} />{:else}{text}{/if}
</span>
