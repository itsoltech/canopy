<script lang="ts">
  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";

  let { retry, retrying = false }: { retry: () => void; retrying?: boolean } = $props();
</script>

<div class="grid h-full place-items-center overflow-y-auto p-6">
  <div class="flex max-w-md flex-col items-center text-center">
    <Icon name="signal-slash" class="fill-zinc-400 dark:fill-zinc-500" />
    <h1 class="mt-3 text-2xl font-semibold tracking-tight text-balance">Can't reach the gateway</h1>
    <p class="mt-2 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">The gateway may be restarting. Retrying automatically every few seconds.</p>
    <div class="mt-6"><Button variant="primary" icon="arrow-path" loading={retrying} onclick={retry}>Try again</Button></div>
  </div>
</div>
