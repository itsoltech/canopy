<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import { deviceLoginNote } from "./device-login.svelte.ts";
  import { Provider } from "@canopy/contracts";

  /** Before a sign-in from a failed turn: which computer it changes, then start or cancel. */
  let {
    workerName,
    linked,
    busy,
    onstart,
    oncancel,
    harness = Provider.CODEX,
  }: {
    workerName: string;
    linked: boolean;
    busy: boolean;
    onstart: () => void;
    oncancel: () => void;
    harness?: Provider;
  } = $props();
</script>

<div class="grid gap-2 rounded-xl bg-zinc-950/2.5 p-4 dark:bg-white/2.5">
  <p class="min-w-0 text-base/6 break-words text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
    {linked ? deviceLoginNote(workerName, harness) : `This signs in only this instance on ${workerName}.`}
  </p>
  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" icon="user" loading={busy} onclick={onstart}>Sign in</Button>
    <Button size="sm" variant="ghost" onclick={oncancel}>Cancel</Button>
  </div>
</div>
