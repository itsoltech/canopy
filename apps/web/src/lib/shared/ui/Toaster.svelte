<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import { provideDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import { dismiss, toasts } from "./toast.svelte.ts";

  /**
   * A polite live region in the bottom-right, clear of the desktop's drag strips. Only the cards take
   * pointer events. A toast rises in (`t-toast`) and leaves a little faster.
   */
  provideDensity("overlay");

  let { children, inDialog = false }: { children?: Snippet; inDialog?: boolean } = $props();
</script>

<div
  class={[
    "density-overlay pointer-events-none right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-50 sm:left-auto sm:w-96",
    inDialog ? "absolute" : "fixed",
  ]}
>
  <div
    class="grid"
    data-dialog-toasts={inDialog || undefined}
    class:window-toasts={!inDialog}
    role="status"
    aria-live="polite"
  >
    {#each toasts as entry (entry.id)}
      <div
        class={[
          "t-toast pointer-events-auto col-start-1 row-start-1 min-w-0 items-center self-end bg-white text-base/6 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 data-closing:pointer-events-none sm:text-sm/5 dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-none dark:ring-white/10",
          entry.description
            ? "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-xl p-3"
            : "flex w-fit max-w-full gap-x-2 gap-y-1 justify-self-end rounded-lg py-1.5 pr-1.5 pl-3 pointer-coarse:pr-3",
          !entry.description && entry.action && "flex-wrap",
        ]}
        data-closing={entry.closing || undefined}
      >
        <div class={entry.description ? "contents" : "flex min-w-0 items-center gap-2"}>
          <div class={entry.description ? "size-5 self-start py-1 [&>svg]:size-5" : "flex"}>
            <Icon
              size="md"
              name={entry.tone === "success"
                ? "check-circle"
                : entry.tone === "error"
                  ? "exclamation-circle"
                  : "information-circle"}
              tone="inherit"
              class={entry.tone === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : entry.tone === "error"
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-sky-600 dark:text-sky-400"}
            />
          </div>
          <p class="min-w-0 wrap-anywhere" class:font-medium={Boolean(entry.description)}>{entry.text}</p>
        </div>
        {#if entry.description}
          <p class="col-span-2 col-start-2 row-start-2 min-w-0 wrap-anywhere text-zinc-600 dark:text-zinc-400">
            {entry.description}
          </p>
        {/if}
        <div class={entry.description ? "contents" : "ml-auto flex items-center gap-2 pointer-coarse:gap-4"}>
          {#if entry.action}
            {@const action = entry.action}
            <div class={entry.description ? "col-span-2 col-start-2 row-start-3 justify-self-end" : undefined}>
              <Button
                variant={entry.description ? "primary" : "text"}
                onclick={() => {
                  dismiss(entry.id);
                  action.run();
                }}
              >
                <span class={entry.description ? undefined : "text-accent underline underline-offset-2"}
                  >{action.label}</span
                >
              </Button>
            </div>
          {/if}
          <div class={entry.description ? "col-start-3 row-start-1 self-start" : undefined}>
            <IconButton icon="x-mark" label="Dismiss notification" onclick={() => dismiss(entry.id)} />
          </div>
        </div>
      </div>
    {/each}
  </div>
  {@render children?.()}
</div>

<style>
  /* The main document is inert behind a native modal. Keep one copy of these messages visible. */
  :global(body:has(dialog:modal [data-dialog-toasts])) .window-toasts {
    display: none;
  }
</style>
