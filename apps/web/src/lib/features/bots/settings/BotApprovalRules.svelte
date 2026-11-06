<script lang="ts">
  import { bots } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    botId,
    selectedRule = "",
    disabled = false,
    showHeading = true,
    class: className,
  }: {
    botId: string;
    selectedRule?: string;
    disabled?: boolean;
    showHeading?: boolean;
    class?: ClassValue;
  } = $props();

  let rules = $state.raw<bots.BotApprovalRule[]>([]);
  let loading = $state(true);
  let busy = $state("");
  let error = $state("");

  $effect(() => {
    const id = botId;
    let active = true;
    loading = true;
    void requestJson("GET", `/api/bots/${id}/rules`)
      .then((body) => {
        if (active) rules = decode(bots.ListBotApprovalRulesResponseSchema, body).rules;
      })
      .catch(() => {
        if (active) error = "Could not load allowed actions. Reopen bot settings to retry.";
      })
      .finally(() => {
        if (active) loading = false;
      });

    return () => {
      active = false;
    };
  });

  async function remove(rule: bots.BotApprovalRule) {
    busy = rule.id;
    error = "";

    try {
      await requestJson("DELETE", `/api/bots/${botId}/rules/${rule.id}`);
      rules = rules.filter((r) => r.id !== rule.id);
    } catch {
      error = "Could not remove this rule. Try again.";
    } finally {
      busy = "";
    }
  }
</script>

<div class={["grid min-w-0 gap-3", className]}>
  {#if showHeading}<h3 class="text-base font-medium sm:text-sm">Allowed actions</h3>{/if}
  {#if loading}<p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">Loading allowed actions…</p>
  {:else if rules.length}
    <ul role="list" class="divide-y divide-zinc-950/10 dark:divide-white/10">
      {#each rules as rule (rule.id)}
        <li
          id="approval-rule-{rule.id}"
          class={[
            "flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0",
            selectedRule === rule.id && "rounded-lg bg-emerald-500/5 p-3 ring-1 ring-emerald-500/20",
          ]}
        >
          <div class="grid min-w-0 flex-1 gap-1">
            <p class="text-base wrap-anywhere sm:text-sm">{rule.label}</p>
            <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
              Added from an approval card{rule.createdAt ? ` · ${timestampDate(rule.createdAt).toLocaleString()}` : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !!busy}
            loading={busy === rule.id}
            onclick={() => remove(rule)}>Remove rule</Button
          >
        </li>
      {/each}
    </ul>
  {:else}<p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
      No allowed actions yet. Choose “Always allow” on an approval card to add a rule.
    </p>
  {/if}
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if !loading && selectedRule && !rules.some((rule) => rule.id === selectedRule)}
    <p role="status" class="text-sm text-zinc-500 dark:text-zinc-400">This rule is no longer active.</p>
  {/if}
</div>
