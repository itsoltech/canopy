<script lang="ts">
  import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";

  let { expiresAt }: { expiresAt?: Timestamp } = $props();
  let now = $state(Date.now());
  const remaining = $derived(expiresAt ? Math.max(0, Math.ceil((timestampDate(expiresAt).getTime() - now) / 1000)) : 0);

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);

    return () => clearInterval(timer);
  });
</script>

<p class="flex h-5 items-center gap-2 text-sm text-zinc-500">
  {#if remaining}<span>Confirm within</span><span class="w-10 shrink-0 tabular-nums">{remaining} s</span>{:else}<span
      >Confirmation expired</span
    >{/if}
</p>
