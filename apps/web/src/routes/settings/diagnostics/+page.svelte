<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import ThreadSyncDiagnostics from "#lib/features/settings/ThreadSyncDiagnostics.svelte";
</script>

<svelte:head><title>Diagnostics · Settings · {applicationName}</title></svelte:head>
<div class="px-1">
  <h1 class="text-base font-semibold text-zinc-950 dark:text-white">Diagnostics</h1>
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Check sync progress without opening thread content.
  </p>
</div>
<ThreadSyncDiagnostics />
