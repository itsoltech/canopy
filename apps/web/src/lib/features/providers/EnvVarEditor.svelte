<script lang="ts">
  import { deniedEnvNames, deniedEnvPrefixes } from "@canopy/domain";
  import { flip } from "svelte/animate";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { duration, expand } from "#lib/shared/ui/motion.ts";
  import { envRow, ruleKind, type EnvVarDraft } from "./instances.ts";
  import SecretValue from "./SecretValue.svelte";
  import type { ProviderProfileKind } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";

  /**
   * The profile's environment variables: name, value, secret. A secret's stored value never reaches the browser:
   * an existing one stays as it is until replaced. Rows stack on phones, line up from `sm`.
   */
  let {
    rows = $bindable(),
    kind,
    problems,
    class: className,
  }: { rows: EnvVarDraft[]; kind: ProviderProfileKind; problems: Record<string, string>; class?: ClassValue } = $props();

  const reserved = $derived([...deniedEnvNames(ruleKind(kind)), ...deniedEnvPrefixes.map((p) => `${p}*`)].join(", "));

  function add() {
    rows = [...rows, envRow()];
    // Focus the new name field once it is in the DOM.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-env-name="${rows.at(-1)?.key}"]`)?.focus());
  }

  function setSecret(row: EnvVarDraft, secret: boolean) {
    // Turning a stored secret into a plain value needs the value: it is not in the browser.
    if (!secret && row.keep) row.keep = false;
    row.secret = secret;
  }
</script>

<div class={["grid gap-3", className]}>
  {#if rows.length > 0}
    <ul role="list" class="grid gap-3">
      {#each rows as row, index (row.key)}
        {@const problem = problems[row.key]}
        <li class="grid gap-2 rounded-xl bg-zinc-950/2.5 p-3 dark:bg-white/2.5" transition:expand animate:flip={{ duration: duration("fast") }}>
          <div class="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
            <Input
              name="env-name-{index}"
              bind:value={row.name}
              aria-label="Variable {index + 1} name"
              aria-invalid={Boolean(problem) || undefined}
              placeholder="NAME"
              autocomplete="off"
              spellcheck="false"
              autocapitalize="characters"
              data-env-name={row.key}
              class="font-mono"
            />
            {#if row.secret}
              <SecretValue
                set={Boolean(row.storedName)}
                bind:action={() => (row.keep ? "keep" : "replace"), (next) => (row.keep = next === "keep")}
                bind:value={row.value}
                name="env-value-{index}"
                label="Variable {index + 1} value"
                placeholder="Secret value"
              />
            {:else}
              <Input name="env-value-{index}" bind:value={row.value} aria-label="Variable {index + 1} value" placeholder="value" autocomplete="off" spellcheck="false" class="font-mono" />
            {/if}
            <IconButton icon="trash" label="Remove {row.name || 'variable'}" class="max-sm:hidden" onclick={() => (rows = rows.filter((r) => r !== row))} />
          </div>
          <div class="flex items-center justify-between gap-3">
            <Checkbox
              name="env-secret-{index}"
              label="Secret"
              bind:checked={() => row.secret, (secret) => setSecret(row, secret)}
            />
            <Button size="sm" variant="ghost" icon="trash" class="sm:hidden" onclick={() => (rows = rows.filter((r) => r !== row))}>Remove</Button>
          </div>
          <FieldError message={problem} />
        </li>
      {/each}
    </ul>
  {/if}
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <Button size="sm" icon="plus" onclick={add}>Add variable</Button>
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">Reserved: <span class="font-mono">{reserved}</span></p>
  </div>
</div>
