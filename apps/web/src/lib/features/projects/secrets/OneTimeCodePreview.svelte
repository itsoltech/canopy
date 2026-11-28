<script lang="ts">
  import { oneTimeCode, parseOneTimeCodeSetup } from "@canopy/domain/one-time-codes";

  /** The code a setup key gives right now, computed in this page only, so the owner can compare it. */
  let { setup }: { setup: string } = $props();

  const parsed = $derived(parseOneTimeCodeSetup(setup));
  let code = $state("");

  $effect(() => {
    const current = parsed;
    let stopped = false;
    code = "";

    if (!current) return;

    const refresh = async () => {
      const next = await oneTimeCode(current);

      if (!stopped) code = next.code;
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 1000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const grouped = $derived(code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
</script>

{#if parsed && code}
  <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
    Current code <span class="font-mono font-medium text-zinc-950 tabular-nums dark:text-white">{grouped}</span>. Check
    that it matches your authenticator app.
  </p>
{:else if setup.trim() && !parsed}
  <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Paste a base32 setup key or an otpauth:// link.</p>
{/if}
