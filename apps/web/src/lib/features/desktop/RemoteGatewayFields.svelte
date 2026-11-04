<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    invitation = $bindable(""),
    gatewayUrl = $bindable(""),
    enrollmentToken = $bindable(""),
    fingerprint = $bindable(""),
    disabled = false,
    migrating = false,
    class: className,
  }: {
    invitation?: string;
    gatewayUrl?: string;
    enrollmentToken?: string;
    fingerprint?: string;
    disabled?: boolean;
    migrating?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid min-w-0 gap-5", className]}>
  {#if migrating}<Alert title="Connect this app securely">
      Automatic migration could not finish. Update Canopy on your gateway and turn on Network access, then retry. You
      can also copy a desktop invitation from Settings → Devices and paste it below. Your worker keeps its identity.
    </Alert>{/if}
  <Field
    label="Desktop invitation"
    description="On your gateway, open Settings → Devices → Pair a desktop app → Copy invitation."
  >
    <Textarea
      name="desktop-invitation"
      bind:value={invitation}
      rows={4}
      {disabled}
      autocomplete="off"
      spellcheck="false"
    />
  </Field>
  <Field
    label="Gateway address"
    description="The secure Network access address. Use your existing address when reconnecting."
  >
    <Input
      name="gateway"
      type="url"
      placeholder="https://gateway.example.com:24000"
      bind:value={gatewayUrl}
      {disabled}
    />
  </Field>
  <details class="grid gap-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    <summary class="cursor-pointer rounded-md focus-ring">Worker enrollment options</summary>
    <div class="grid gap-5 pt-4">
      <Field
        label="Enrollment token"
        description="Optional. A paired app enrolls its worker automatically; existing workers retain their link."
      >
        <Input name="token" type="password" autocomplete="off" bind:value={enrollmentToken} {disabled} />
      </Field>
      <Field
        label="Worker certificate fingerprint"
        description="Only needed for a separate worker enrollment address. Use the full SHA-256 fingerprint."
      >
        <Input name="gateway-fingerprint" bind:value={fingerprint} maxlength={64} {disabled} />
      </Field>
    </div>
  </details>
</div>
