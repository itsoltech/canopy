<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import { backdropDismiss } from "#lib/shared/ui/backdrop.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { exitDuration } from "#lib/shared/ui/motion.ts";

  /**
   * An image at full size over the page (modal 06: `t-modal` scales in on --duration-fast, out on
   * --duration-quick). Escape, the backdrop or the close button closes it; the download link saves the file.
   */
  let {
    open = $bindable(false),
    src,
    name,
    detail = "",
    download,
  }: { open?: boolean; src: string; name: string; detail?: string; download?: string | undefined } = $props();

  let dialog = $state<HTMLDialogElement>();
  let closing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(timer));

  $effect(() => {
    if (!dialog) return;

    if (open && !dialog.open) {
      clearTimeout(timer);
      closing = false;
      dialog.showModal();
    }

    if (!open && dialog.open) {
      dialog.close();
      closing = true;
      timer = setTimeout(() => (closing = false), exitDuration(dialog));
    }
  });
</script>

<dialog
  use:windowModal
  bind:this={dialog}
  aria-label={name}
  class="t-modal top-(--window-safe-top) m-auto max-h-(--window-safe-height) max-w-[min(96vw,100rem)] overflow-visible bg-transparent p-0 backdrop:bg-zinc-950/80 dark:backdrop:bg-black/85 macos:overflow-y-auto"
  onclose={() => (open = false)}
  {...backdropDismiss(() => (open = false))}
>
  {#if open || closing}
    <figure class="grid gap-3">
      <img
        {src}
        alt={name}
        class="max-h-[calc(var(--window-safe-height)-8rem)] w-auto max-w-full rounded-lg object-contain outline-1 -outline-offset-1 outline-white/10"
      />
      <!-- Its own dark surface: readable over any page, also while the backdrop fades in. -->
      <figcaption
        class="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-zinc-950/90 py-2 pr-2 pl-3 text-base/6 text-white sm:text-sm/6"
      >
        <span class="min-w-0">
          <span class="block truncate font-medium">{name}</span>
          {#if detail}<span class="block truncate text-white/60 tabular-nums">{detail}</span>{/if}
        </span>
        <span class="flex shrink-0 items-center gap-1">
          {#if download}
            <a
              href={download}
              download={name}
              class="relative inline-flex items-center gap-1 rounded-md py-1.5 pr-2.5 pl-2 font-medium text-white focus-ring hover:bg-white/10"
            >
              <Icon name="arrow-down" class="shrink-0 text-white" />Download
            </a>
          {/if}
          <button
            type="button"
            class="relative grid size-9 place-items-center rounded-md focus-ring hover:bg-white/10 sm:size-8"
            aria-label="Close"
            onclick={() => (open = false)}
          >
            <Icon name="x-mark" class="text-white" />
            <TouchTarget />
          </button>
        </span>
      </figcaption>
    </figure>
  {/if}
</dialog>
