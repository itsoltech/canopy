<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import ThreadSyncDiagnostics from "#lib/features/settings/ThreadSyncDiagnostics.svelte";
</script>

<svelte:head><title>Diagnostics · Settings · {applicationName}</title></svelte:head>
<div class="px-1">
  <h1 class="text-base font-semibold text-zinc-950 dark:text-white">Diagnostics</h1>
</div>
<ThreadSyncDiagnostics />
