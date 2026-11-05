<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    invitation,
    remaining,
    copied,
    busy,
    oncopy,
    oninvite,
    onrevoke,
  }: {
    invitation: ui.ComputerPairing;
    remaining: number;
    copied: string;
    busy: boolean;
    oncopy: (value: string, label: string) => void;
    oninvite: () => void;
    onrevoke: () => void;
  } = $props();
</script>

<div class="grid gap-2">
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Pairing code</p>
  <p class="rounded-xl bg-zinc-950/3 p-3 font-mono text-base/6 break-all select-all dark:bg-white/5">
    {invitation.code}
  </p>
  <div>
    <Button size="sm" disabled={!remaining} onclick={() => oncopy(invitation.code, "code")}
      >{copied === "code" ? "Copied" : "Copy code"}</Button
    >
  </div>
</div>
<div class="grid gap-2">
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Enter one of these addresses on the other computer
  </p>
  {#each invitation.addresses as value}
    <p class="font-mono text-base/6 break-all select-all sm:text-sm/6">{value}</p>
    <div>
      <Button size="sm" onclick={() => oncopy(value, value)}>{copied === value ? "Copied" : "Copy address"}</Button>
    </div>
  {/each}
</div>
<p role="status" class="text-base/6 text-zinc-500 tabular-nums sm:text-sm/6 dark:text-zinc-400">
  {remaining
    ? `One use · expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
    : "Code expired. Generate a new code."}
</p>
<Button disabled={busy} onclick={oninvite}>Generate new code</Button>
<Button size="sm" variant="ghost" disabled={busy} onclick={onrevoke}>Revoke code</Button>
