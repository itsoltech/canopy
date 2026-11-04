<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";

  let {
    current,
    version,
    disabled,
    pending,
    onsave,
    class: className,
  }: {
    current: string;
    version: string;
    disabled: boolean;
    pending: boolean;
    onsave(channel: string): Promise<void>;
    class?: ClassValue;
  } = $props();

  let selected = $state("");
  let confirming = $state(false);
  let pinning = $state(false);
  let candidate = $state("");
  let pin = $state("");
  const normalized = $derived(current === "latest" ? "stable" : current);
  const validPin = $derived(/^v(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,2}$/.test(pin));

  $effect(() => {
    selected = normalized;
  });

  const options = $derived.by(() => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    const pins = match ? [`v${match[1]}`, `v${match[1]}.${match[2]}`, `v${match[1]}.${match[2]}.${match[3]}`] : [];

    return [...new Set(["stable", "beta", "nightly", ...pins, normalized].filter(Boolean))]
      .map((value) => ({ value, label: value }))
      .concat({ value: "pin", label: "Pin a version…" });
  });

  function older(next: string): boolean {
    const channels = ["stable", "beta", "nightly"];
    const currentRank = channels.indexOf(normalized);
    const nextRank = channels.indexOf(next);

    if (currentRank >= 0 && nextRank >= 0) return nextRank < currentRank;

    // Pins can resolve behind the installed version; confirm before changing the policy.
    if (next.startsWith("v")) {
      const target = next.slice(1).split(".").map(Number);
      const installed = version.split(/[.-]/).slice(0, 3).map(Number);

      for (let i = 0; i < target.length; i++) {
        if (target[i] !== installed[i]) return (target[i] ?? 0) < (installed[i] ?? 0);
      }
    }

    return false;
  }

  async function save(next: string) {
    await onsave(next);
    selected = normalized;
  }

  function choose(next: string) {
    selected = normalized;

    if (disabled || pending || next === normalized) return;

    if (next === "pin") {
      pin = normalized.startsWith("v") ? normalized : `v${version.split("-")[0]}`;
      pinning = true;

      return;
    }

    if (older(next)) {
      candidate = next;
      confirming = true;
    } else void save(next);
  }
</script>

<div class={["flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2", className]}>
  <div class="flex items-center gap-1 text-sm/5 font-medium">
    <span>Release channel</span>
    <IconButton
      size="sm"
      icon="information-circle"
      label="Stable releases, beta previews or nightly builds. Pin releases with vX, vX.Y or vX.Y.Z. Changes save automatically."
    />
  </div>
  <div class="min-w-0 basis-40">
    <Select
      aria-label={pending ? "Release channel — saving" : "Release channel"}
      bind:value={selected}
      {options}
      disabled={disabled || pending}
      onchange={choose}
    />
  </div>
</div>
<Dialog bind:open={confirming} title="Switch to an older channel?">
  <div class="grid gap-4">
    <p class="break-anywhere text-sm/6 text-muted">
      Switch from {normalized} to {candidate}? This channel may offer an older release. The installed version stays in
      place until a newer release is available.
    </p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button size="sm" onclick={() => (confirming = false)}>Keep current channel</Button>
      <Button
        size="sm"
        variant="primary"
        disabled={disabled || pending}
        onclick={() => {
          confirming = false;
          void save(candidate);
        }}>Switch channel</Button
      >
    </div>
  </div>
</Dialog>
<Dialog bind:open={pinning} title="Pin a release channel">
  <form
    class="grid gap-4"
    onsubmit={(event) => {
      event.preventDefault();
      if (validPin) {
        pinning = false;
        choose(pin);
      }
    }}
  >
    <Field label="Version pin" description="Use vX, vX.Y or vX.Y.Z."><Input bind:value={pin} required /></Field>
    <div class="flex justify-end gap-2">
      <Button size="sm" onclick={() => (pinning = false)}>Cancel</Button><Button
        size="sm"
        type="submit"
        disabled={!validPin || disabled || pending}>Use pin</Button
      >
    </div>
  </form>
</Dialog>
