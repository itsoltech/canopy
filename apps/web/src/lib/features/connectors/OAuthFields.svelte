<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import OAuthAppForm from "./OAuthAppForm.svelte";
  import SlackAppSetup from "./SlackAppSetup.svelte";

  /**
   * OAuth sign-in. A service without automatic registration shows its app form until an app is saved; elsewhere
   * scopes and a registered app are Advanced options. Registered apps use the gateway's fixed redirect URL;
   * `callback` is this installation's own callback, for automatic registration.
   */
  let {
    type,
    method,
    callback,
    scope = $bindable(""),
    appSaved = $bindable(false),
    disabled = false,
    class: className,
  }: {
    type: string;
    method: connectors.ConnectorAuthMethod;
    callback: string;
    scope?: string;
    appSaved?: boolean;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();
</script>

{#snippet scopes()}
  <Field label="OAuth scopes" optional description={method.scopeDescription || undefined}
    ><Input
      name="scope"
      bind:value={scope}
      autocomplete="off"
      spellcheck={false}
      {disabled}
      placeholder={method.scopePlaceholder}
    /></Field
  >
{/snippet}

{#snippet app()}
  <div class="grid gap-4">
    {#if method.appManifest}<SlackAppSetup {method} />{/if}
    <OAuthAppForm
      {type}
      callback={method.appManifest ? "" : method.redirectUrl || callback}
      saved={appSaved}
      ondone={() => (appSaved = true)}
    />
  </div>
{/snippet}

<div class={["grid", className]}>
  {#if method.oauthAppRequired}
    {#if appSaved}
      <Disclosure summaryClass="text-base/6 sm:text-sm/6"
        >{#snippet summary()}OAuth app saved · Replace{/snippet}
        <div class="pt-4">{@render app()}</div></Disclosure
      >
    {:else}
      <GrowIn class="grid gap-3 rounded-lg p-3 ring-1 ring-zinc-950/10 dark:ring-white/10">
        <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
          {method.appManifest ? "Your Slack app" : "Your OAuth app"}
        </p>
        {@render app()}
      </GrowIn>
    {/if}
    <div class="pt-5">{@render scopes()}</div>
  {:else}
    <Disclosure summaryClass="text-base/6 sm:text-sm/6"
      >{#snippet summary()}Advanced: scopes and a registered OAuth app{/snippet}
      <div class="grid gap-5 pt-4">
        {@render scopes()}
        <div class="grid gap-3 border-t border-zinc-950/5 pt-4 dark:border-white/5">
          <div class="text-base/6 sm:text-sm/6">
            <p class="font-medium text-zinc-950 dark:text-white">Registered OAuth app</p>
            <p class="text-pretty text-zinc-500 dark:text-zinc-400">
              Only needed when the server does not accept automatic registration.
            </p>
          </div>
          {@render app()}
        </div>
      </div></Disclosure
    >
  {/if}
</div>
