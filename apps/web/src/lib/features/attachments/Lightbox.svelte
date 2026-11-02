<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
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
  bind:this={dialog}
  aria-label={name}
  class="t-modal m-auto max-h-dvh max-w-[min(96vw,100rem)] overflow-visible bg-transparent p-0 backdrop:bg-zinc-950/80 dark:backdrop:bg-black/85"
  onclose={() => (open = false)}
  onclick={(event) => {
    if (event.target === dialog) open = false;
  }}
>
  {#if open || closing}
    <figure class="grid gap-3">
      <img {src} alt={name} class="max-h-[calc(100dvh-8rem)] w-auto max-w-full rounded-lg object-contain outline-1 -outline-offset-1 outline-white/10" />
      <figcaption class="flex min-w-0 items-center justify-between gap-3 text-base/6 text-white sm:text-sm/6">
        <span class="min-w-0">
          <span class="block truncate font-medium">{name}</span>
          {#if detail}<span class="block truncate text-white/60 tabular-nums">{detail}</span>{/if}
        </span>
        <span class="flex shrink-0 items-center gap-1">
          {#if download}
            <a href={download} download={name} class="relative inline-flex items-center gap-1 rounded-md py-1.5 pr-2.5 pl-2 font-medium text-white focus-ring hover:bg-white/10">
              <Icon name="arrow-down" class="shrink-0 fill-white" />Download
            </a>
          {/if}
          <IconButton icon="x-mark" label="Close" size="sm" class="text-white hover:bg-white/10" onclick={() => (open = false)} />
        </span>
      </figcaption>
    </figure>
  {/if}
</dialog>
