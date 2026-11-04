<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";

  /** The credential for a token method, named as the service names it; other secret headers stay under Advanced. */
  let {
    method,
    token = $bindable(""),
    headers = $bindable(""),
    disabled = false,
    class: className,
  }: {
    method: connectors.ConnectorAuthMethod;
    token?: string;
    headers?: string;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid gap-5", className]}>
  <Field
    label={method.tokenLabel || "Bearer token"}
    optional={!method.tokenRequired}
    description={method.tokenDescription || undefined}
    ><Input
      type="password"
      name="token"
      bind:value={token}
      required={method.tokenRequired}
      autocomplete="off"
      spellcheck={false}
      {disabled}
    /></Field
  >
  <Disclosure summaryClass="text-base/6 sm:text-sm/6"
    >{#snippet summary()}Advanced: custom secret headers{/snippet}
    <div class="pt-3">
      <Field
        label="Headers"
        optional
        description="One per line: Header-Name: value. For servers that expect another header, such as X-API-Key."
        ><Textarea
          name="headers"
          bind:value={headers}
          rows={3}
          autocomplete="off"
          spellcheck={false}
          {disabled}
        /></Field
      >
    </div></Disclosure
  >
</div>
