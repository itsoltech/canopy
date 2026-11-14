<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** The ChatGPT device code of a sign-in the worker waits for (LoginPanel, a failed turn). */
  let { url, userCode, workerName }: { url: string; userCode: string; workerName: string } = $props();
</script>

<div class="grid gap-2 rounded-xl bg-zinc-950/2.5 p-4 dark:bg-white/2.5">
  <p class="text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
    Open the link, sign in with ChatGPT and enter this code. It expires in 15 minutes.
  </p>
  <p class="font-mono text-2xl font-semibold tracking-widest text-zinc-950 select-all dark:text-white">
    {userCode}
  </p>
  <a
    href={url}
    target="_blank"
    rel="noreferrer noopener"
    class="inline-flex min-w-0 items-center gap-1.5 text-base/6 font-medium break-all text-brand-700 focus-ring hover:underline sm:text-sm/6 dark:text-brand-400"
  >
    {url}<Icon name="arrow-top-right-on-square" class="size-4 shrink-0 fill-current" />
  </a>
  <p class="min-w-0 text-sm/5 break-words text-zinc-500 dark:text-zinc-400">Waiting for the sign-in on {workerName}…</p>
</div>
