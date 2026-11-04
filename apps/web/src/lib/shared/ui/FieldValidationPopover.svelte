<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import type { Attachment } from "svelte/attachments";
  import Popover, { anchorOnly } from "./Popover.svelte";

  /** Spread on the field: anchoring, description, focus and pointer handling, without button semantics. */
  interface FieldProps extends Pick<
    HTMLAttributes<HTMLElement>,
    "aria-describedby" | "onfocus" | "onblur" | "onpointerenter" | "onpointerleave" | "onpointerdown"
  > {
    readonly [key: symbol]: Attachment<HTMLElement>;
  }

  /**
   * Validation beside a field, without moving focus or layout. Opens on a new problem, focus, hover or
   * touch; Escape and outside presses dismiss it. Spread `props` on the input in the `field` snippet.
   * The persistent alert also describes the input while the visual popover is closed.
   */
  let { message, field }: { message: string | undefined; field: Snippet<[FieldProps]> } = $props();

  const id = $props.id();
  let open = $state(false);
  let focused = false;
  let hovered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show() {
    clearTimeout(timer);
    open = Boolean(message);
  }

  function leave() {
    clearTimeout(timer);

    if (!focused && !hovered) timer = setTimeout(() => (open = false), 150);
  }

  $effect(() => {
    show();
    // A change elsewhere can invalidate an unfocused field (for example, a duplicate name).

    if (message && !focused && !hovered) timer = setTimeout(() => (open = false), 2500);

    return () => clearTimeout(timer);
  });
</script>

<span {id} class="sr-only" role="alert">{message ?? ""}</span>
<Popover
  bind:open
  label="Field validation"
  role="none"
  placement="bottom-start"
  focusOnOpen={false}
  class="w-80 max-w-[calc(100vw-1rem)]"
>
  {#snippet trigger(props)}
    {@render field({
      ...anchorOnly(props),
      "aria-describedby": message ? id : undefined,
      onfocus: () => {
        focused = true;
        show();
      },
      onblur: () => {
        focused = false;
        leave();
      },
      onpointerenter: () => {
        hovered = true;
        show();
      },
      onpointerleave: () => {
        hovered = false;
        leave();
      },
      onpointerdown: show,
    })}
  {/snippet}
  <div
    role="presentation"
    onpointerenter={() => {
      hovered = true;
      show();
    }}
    onpointerleave={() => {
      hovered = false;
      leave();
    }}
    class="p-3 text-sm/5 text-pretty wrap-anywhere text-rose-700 dark:text-rose-400"
    aria-hidden="true"
  >
    {message}
  </div>
</Popover>
