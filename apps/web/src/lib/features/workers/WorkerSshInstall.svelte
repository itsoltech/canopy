<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import WorkerSshKey from "./WorkerSshKey.svelte";
  import { workerSsh } from "./ssh.ts";

  let {
    name,
    tags,
    busy = $bindable(false),
    onenrollment,
    oninstalled,
    class: className,
  }: {
    name: string;
    tags: string[];
    busy?: boolean;
    onenrollment: (value: ui.WorkerEnrollment) => void;
    oninstalled: () => void;
    class?: ClassValue;
  } = $props();

  let target = $state("");
  let checkedTarget = $state("");
  let fingerprint = $state("");
  let trusted = $state(false);
  let output = $state("");
  let error = $state("");
  let controller: AbortController | undefined;

  onDestroy(() => {
    controller?.abort();
    busy = false;
  });

  async function run(action: "probe" | "install") {
    controller?.abort();
    controller = new AbortController();
    busy = true;
    error = "";

    if (action === "probe") {
      fingerprint = "";
      checkedTarget = "";
    } else output = "";

    try {
      await workerSsh({ action, target, fingerprint, name, tags }, controller.signal, (event) => {
        if (event.fingerprint) {
          fingerprint = event.fingerprint;
          trusted = event.trusted;
          checkedTarget = target;
        }

        if (event.output) output = (output + event.output).slice(-128_000);

        if (event.enrollment) onenrollment(event.enrollment);
      });

      if (action === "install") oninstalled();
    } catch (e) {
      error = controller.signal.aborted
        ? "SSH installation cancelled."
        : e instanceof Error
          ? e.message
          : "SSH operation failed";
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <WorkerSshKey />
  <Field
    label="SSH address"
    description="The gateway must reach this SSH host. The target must reach Canopy’s web origin and worker gateway address, for example over Tailscale."
  >
    <Input name="ssh-target" bind:value={target} placeholder="you@100.64.0.10:22" disabled={busy} />
  </Field>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="flex flex-wrap gap-2">
    <Button size="sm" loading={busy} disabled={!target.trim()} onclick={() => void run("probe")}>Check host key</Button>
    {#if busy}<Button size="sm" onclick={() => controller?.abort()}>Cancel installation</Button>{/if}
  </div>
  {#if fingerprint && checkedTarget === target}
    <div class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10">
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        {trusted
          ? "This host key matches your saved fingerprint."
          : "Verify this fingerprint with the host administrator before trusting it. No SSH authentication has happened yet."}
      </p>
      <CommandBlock text={fingerprint} label="SSH host key · SHA-256" />
      <div>
        <Button size="sm" disabled={busy} onclick={() => void run("install")}
          >{trusted ? "Install on this host" : "Trust fingerprint and install"}</Button
        >
      </div>
    </div>
  {/if}
  {#if output}<div aria-live="polite">
      <CommandBlock text={output} label="Installation output" copyable={false} />
    </div>{/if}
</div>
