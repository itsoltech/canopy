<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { splitId } from "@canopy/domain/computers";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import * as api from "./api.ts";

  let { account, class: className }: { account: github.GitHubAccount; class?: ClassValue } = $props();
  let busy = $state(false);
  let error = $state("");

  const read = $derived(
    new SharedRead(queries, `GitHubUpdateAccount:${splitId(account.id).node ?? "local"}`, () =>
      api.updateAccount(account.id),
    ),
  );

  const checked = $derived(read.data?.enabled && read.data.accountId === account.id);

  async function change(value: boolean) {
    busy = true;
    error = "";

    try {
      read.set(await api.setUpdateAccount(account.id, account.id, value));
    } catch {
      error = "Could not change update preferences. Reopen Settings to retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid gap-2 px-3 py-2", className]}>
  <Checkbox
    name={`updates-${account.id}`}
    label="Use this account for update checks"
    description="Used when the public release index is unavailable. Updates work without an account."
    disabled={busy || account.status !== "connected"}
    bind:checked={() => !!checked, (value) => void change(value)}
  />
  {#if error || read.snapshot.error}<p role="alert" class="text-sm text-rose-700 dark:text-rose-400">
      {error || "Could not load update preferences. Reopen Settings to retry."}
    </p>{/if}
</div>
