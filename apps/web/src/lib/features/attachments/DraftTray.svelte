<script lang="ts">
  import { formatSize } from "@open-agents/domain";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { pop, reorder } from "#lib/shared/ui/motion.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import type { AttachmentDraft } from "./draft.svelte.ts";

  /**
   * The files a message will carry, inside the composer above the text: images as thumbnails, other files as
   * chips with name and size. Each shows its upload (a bar that fills), a failure in red with the reason, and a
   * remove button. Chips pop in as they are added and the others glide aside when one goes.
   */
  let { draft }: { draft: AttachmentDraft } = $props();
</script>

{#if draft.files.length > 0 || draft.notice}
  <div class="grid gap-2 px-3 pt-3">
    {#if draft.files.length > 0}
      <ul role="list" class="flex flex-wrap gap-2" aria-label="Attachments">
        {#each draft.files as file (file.key)}
          <li
            class={[
              "group relative isolate flex min-w-0 overflow-hidden rounded-xl bg-zinc-50 ring-1 ring-inset dark:bg-white/5",
              file.status === "failed" ? "ring-rose-600/30 dark:ring-rose-400/30" : "ring-zinc-950/10 dark:ring-white/10",
              file.image ? "size-16" : "h-16 max-w-60 items-center gap-2.5 py-2 pr-9 pl-2.5",
            ]}
            in:pop
            out:pop={{}}
            animate:reorder
            title={file.error ?? `${file.name} · ${formatSize(file.size)}`}
          >
            {#if file.image && file.localUrl}
              <img src={file.localUrl} alt={file.name} class={["size-full object-cover", file.status === "uploading" && "opacity-60"]} />
            {:else}
              <Icon name={file.status === "failed" ? "exclamation-circle" : "document-text"} class={["shrink-0", file.status === "failed" ? "fill-rose-600 dark:fill-rose-400" : "fill-zinc-400 dark:fill-zinc-500"]} />
              <div class="min-w-0">
                <p class="truncate text-sm/5 font-medium text-zinc-950 sm:text-xs/5 dark:text-white">{file.name}</p>
                <p class={["truncate text-sm/5 tabular-nums sm:text-xs/5", file.status === "failed" ? "text-rose-700 dark:text-rose-400" : "text-zinc-500 dark:text-zinc-400"]}>
                  {file.status === "failed" ? (file.error ?? "Upload failed") : file.attachment ? `${formatSize(file.size)} · ${file.attachment.mimeType}` : formatSize(file.size)}
                </p>
              </div>
            {/if}
            {#if file.image && file.status === "failed"}
              <span class="absolute inset-0 grid place-items-center bg-rose-50/80 dark:bg-rose-950/70"><Icon name="exclamation-circle" class="fill-rose-600 dark:fill-rose-400" /></span>
            {/if}
            {#if file.status === "uploading"}
              {#if file.image}<span class="absolute inset-0 grid place-items-center"><Spinner class="size-4 text-white drop-shadow" /></span>{/if}
              <span class="absolute inset-x-0 bottom-0 h-1 bg-zinc-950/10 dark:bg-white/10" role="progressbar" aria-label="Uploading {file.name}" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(file.progress * 100)}>
                <span class="block h-full w-(--progress) bg-brand-600 transition-[width] duration-(--duration-fast) ease-smooth-out" style="--progress: {Math.round(file.progress * 100)}%"></span>
              </span>
            {/if}
            <button
              type="button"
              class="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-zinc-950/60 text-white focus-ring hover:bg-zinc-950/80 sm:size-5 dark:bg-black/60"
              aria-label="Remove {file.name}"
              onclick={() => draft.remove(file.key)}
            >
              <Icon name="x-mark" class="size-3.5 sm:size-3" />
              <TouchTarget />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if draft.notice}<p class="text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-400" role="alert">{draft.notice}</p>{/if}
  </div>
{/if}
