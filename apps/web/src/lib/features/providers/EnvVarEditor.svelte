<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import FieldValidationPopover from "#lib/shared/ui/FieldValidationPopover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { envProblems, envRow, type EnvVarDraft } from "./instances.ts";
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
  }: {
    rows: EnvVarDraft[];
    kind: ProviderProfileKind;
    problems: Record<string, string>;
    class?: ClassValue;
  } = $props();

  const liveProblems = $derived(envProblems(kind, rows));
  const edited = new SvelteSet<string>();

  function add() {
    rows = [...rows, envRow()];
    // Focus the new name field once it is in the DOM.
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>(`[data-env-name="${rows.at(-1)?.key}"]`)?.focus(),
    );
  }

  function setSecret(row: EnvVarDraft, secret: boolean) {
    // Turning a stored secret into a plain value needs the value: it is not in the browser.
    if (!secret && row.keep) row.keep = false;
    row.secret = secret;
  }
</script>

<div class={["@container grid gap-3", className]}>
  {#if rows.length > 0}
    <ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/8">
      {#each rows as row, index (row.key)}
        {@const problem = problems[row.key] ?? (row.name || edited.has(row.key) ? liveProblems[row.key] : undefined)}
        <li class="grid gap-1 py-2 first:pt-0 last:pb-0">
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto]"
          >
            <div class="col-span-2 min-w-0 @xl:col-span-1">
              <FieldValidationPopover message={problem}>
                {#snippet field(props)}
                  <Input
                    {...props}
                    name="env-name-{index}"
                    bind:value={row.name}
                    oninput={() => edited.add(row.key)}
                    aria-label="Variable {index + 1} name"
                    aria-invalid={Boolean(problem) || undefined}
                    placeholder="NAME"
                    autocomplete="off"
                    spellcheck="false"
                    autocapitalize="characters"
                    data-env-name={row.key}
                    class="font-mono"
                  />
                {/snippet}
              </FieldValidationPopover>
            </div>
            <div class="col-span-2 min-w-0 @xl:col-span-1">
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
                <Input
                  name="env-value-{index}"
                  bind:value={row.value}
                  aria-label="Variable {index + 1} value"
                  placeholder="value"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono"
                />
              {/if}
            </div>
            <Checkbox
              name="env-secret-{index}"
              label="Secret"
              bind:checked={() => row.secret, (secret) => setSecret(row, secret)}
            />
            <IconButton
              icon="trash"
              label="Remove {row.name || 'variable'}"
              class="justify-self-end"
              onclick={() => (rows = rows.filter((r) => r !== row))}
            />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <Button size="sm" icon="plus" onclick={add}>Add variable</Button>
  </div>
</div>
