<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { useRemembered } from "#lib/shared/ui/memory.ts";
  import { duration } from "#lib/shared/ui/motion.ts";
  import { firstLine } from "@canopy/domain/first-line";

  /**
   * The violet bubble of a message one agent sent another (a steer, a task, a message, a report). Long messages
   * fold to their first line as plain text with a chevron; the row or the chevron opens the whole message
   * (`children`, rendered markdown) and folds it again. A message that fits on one line shows in full, without a
   * chevron. `rich`: the message carries more than its text (quotes, details), so it always folds. Folded content
   * stays in the page as `hidden="until-found"`: the browser's find opens the message at a match.
   */
  let {
    text,
    rich = false,
    label = "Show the whole message",
    class: className,
    children,
  }: { text: string; rich?: boolean; label?: string; class?: ClassValue; children: Snippet } = $props();

  const line = $derived(firstLine(text));
  const id = $props.id();

  // Truncated: the first line is wider than the bubble. Measured on the line itself, which renders in both states.
  let truncated = $state(false);
  const fits = $derived(!rich && !line.more && !truncated);

  // Remembered while the row is scrolled out of a virtual list.
  const memory = useRemembered<boolean>("agent-message");
  let expanded = $state(memory?.get() ?? false);

  // Folded content leaves the find-in-page tree only after its fold animation.
  let findable = $state(untrack(() => expanded));

  $effect(() => memory?.set(expanded));

  $effect(() => {
    if (expanded) {
      findable = true;

      return;
    }

    const timer = setTimeout(() => (findable = false), duration("fast"));

    return () => clearTimeout(timer);
  });

  const measure: Attachment<HTMLElement> = (node) => {
    const observer = new ResizeObserver(() => (truncated = node.scrollWidth > node.clientWidth));
    observer.observe(node);

    return () => observer.disconnect();
  };
</script>

<div
  class={[
    "grid max-w-[min(85%,42rem)] rounded-2xl rounded-br-md bg-violet-50 px-4 py-2.5 text-base/6 break-words text-violet-950 ring-1 ring-violet-600/10 ring-inset sm:text-sm/6 dark:bg-violet-400/10 dark:text-violet-50 dark:ring-violet-400/20",
    // The chevron's column stays reserved in both states, so the folded line ends before it.
    fits ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_--spacing(6)]",
    className,
  ]}
>
  {#if fits}
    <!-- The line stays as an invisible ruler under the full message, so a narrower window folds it again. -->
    <div class="col-start-1 row-start-1 grid grid-cols-1">
      <span class="invisible col-start-1 row-start-1 truncate" aria-hidden="true" {@attach measure}>{line.text}</span>
      <div class="col-start-1 row-start-1 min-w-0">{@render children()}</div>
    </div>
  {:else}
    <div class="col-start-1 row-start-1 grid min-w-0 grid-cols-1">
      <div class="t-acc-panel grid-cols-1" data-open={expanded ? undefined : ""} aria-hidden="true">
        <span class="block truncate" {@attach measure}>{line.text}</span>
      </div>
      <div class="t-acc-panel grid-cols-1" data-open={expanded ? "" : undefined}>
        <!-- Long paths and code lines wrap or scroll inside the bubble instead of widening the clipped panel. -->
        <div
          {id}
          class="wrap-anywhere *:grid-cols-1"
          hidden={findable ? undefined : "until-found"}
          onbeforematch={() => (expanded = true)}
        >
          {@render children()}
        </div>
      </div>
    </div>
    <!-- Folded, the button covers the whole bubble; open, only the chevron's corner, so the text stays selectable.
         The chevron keeps its place in both. -->
    <button
      type="button"
      class={[
        "relative row-start-1 -my-2.5 -mr-4 box-content flex h-lh items-center justify-end py-2.5 pr-4 focus-ring",
        expanded
          ? "col-start-2 rounded-tr-2xl"
          : "col-span-2 col-start-1 -ml-4 rounded-2xl rounded-br-md pl-4 hover:bg-violet-600/5 dark:hover:bg-violet-400/5",
      ]}
      aria-expanded={expanded}
      aria-controls={id}
      aria-label={expanded ? "Show less" : label}
      onclick={() => (expanded = !expanded)}
    >
      <Icon
        name="chevron-down"
        class={["t-acc-chevron size-4 fill-violet-600/60 dark:fill-violet-300/60", expanded && "rotate-180"]}
      />
    </button>
  {/if}
</div>
