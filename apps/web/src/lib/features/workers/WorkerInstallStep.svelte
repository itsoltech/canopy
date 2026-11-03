<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { onMount } from "svelte";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { pageIn } from "#lib/shared/ui/motion.ts";
  import CommandBlock from "./CommandBlock.svelte";
  import SetupTabs from "./SetupTabs.svelte";
  import WorkerSshInstall from "./WorkerSshInstall.svelte";
  import { enrollmentCommand, shellQuote } from "./actions.ts";
  let { name, gatewayUrl, token, version, channel, copyable, busy = $bindable(false), onenrollment, oninstalled, class: className }:
    { name: string; gatewayUrl: string; token: string; version: string; channel: string; copyable: boolean; busy?: boolean;
      onenrollment: (value: ui.WorkerEnrollment) => void; oninstalled: () => void; class?: ClassValue } = $props();
  let method = $state("script");
  let os = $state("linux");
  let arch = $state("x64");
  let dockerMode = $state("run");
  let origin = $state("");
  let metadata = $state<{ version: string; downloadUrl: string; fallback: boolean }>();
  let metadataError = $state("");
  let retry = $state(0);
  onMount(() => { origin = window.location.origin; });
  const targetArch = $derived(os === "darwin" ? "arm64" : arch);
  const asset = $derived(`canopy-worker-${os}-${targetArch}`);
  const tag = $derived(/^\d+\.\d+\.\d+(?:-(?:beta|nightly)\.\d+)?$/.test(version) ? `v${version}` : channel || "nightly");
  const image = $derived(`ghcr.io/itsoltech/canopy-worker:${tag}`);
  const releaseUrl = $derived(metadata?.downloadUrl ?? `https://github.com/itsoltech/canopy/releases/download/v${version}/${asset}`);
  const command = $derived(enrollmentCommand({ origin, gatewayUrl, token, name, ...(metadata?.fallback && { releaseUrl }) }));
  const manual = $derived(`set -eu\nmkdir -p "$HOME/.local/share/canopy/bin"\ncd "$(mktemp -d)"\ncurl -fLO ${shellQuote(releaseUrl)}\ncurl -fLO ${shellQuote(releaseUrl.replace(/\/[^/]+$/, "/checksums.txt"))}\ngrep '  ${asset}$' checksums.txt | ${os === "darwin" ? "shasum -a 256" : "sha256sum"} -c -\ninstall -m 0755 ${asset} "$HOME/.local/share/canopy/bin/canopy-worker"\n"$HOME/.local/share/canopy/bin/canopy-worker" enroll --gateway ${shellQuote(gatewayUrl)} --token ${shellQuote(token)} --config "$HOME/.config/canopy/worker.json"\n"$HOME/.local/share/canopy/bin/canopy-worker" service --config "$HOME/.config/canopy/worker.json"`);
  const docker = $derived(`docker volume create canopy-worker\ndocker run --rm -v canopy-worker:/home/canopy ${image} enroll --gateway ${shellQuote(gatewayUrl)} --token ${shellQuote(token)}\ndocker run -d --name canopy-worker --restart unless-stopped -v canopy-worker:/home/canopy ${image}`);
  const compose = $derived(`# First enroll using the docker run command above, then: docker compose up -d\nservices:\n  worker:\n    image: ${image}\n    restart: unless-stopped\n    volumes:\n      - canopy-worker:/home/canopy\nvolumes:\n  canopy-worker:\n    external: true`);
  $effect(() => {
    const platform = `${os}/${targetArch}`; void retry;
    const abort = new AbortController(); metadata = undefined; metadataError = "";
    fetch(`/api/workers/install?os=${os}&arch=${targetArch}`, { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Release metadata is unavailable. Retry when the gateway can reach GitHub Releases.");
      const value = await response.json();
      if (!abort.signal.aborted && platform === `${os}/${targetArch}`) metadata = value;
    }).catch((e) => { if (!abort.signal.aborted) metadataError = e instanceof Error ? e.message : "Release lookup failed"; });
    return () => abort.abort();
  });
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Install on <strong class="font-medium text-zinc-700 dark:text-zinc-200">{name}</strong>. The worker connects to your gateway and keeps itself up to date.</p>
  <div class="min-w-0 overflow-x-auto"><SetupTabs label="Installation method" bind:value={method} disabled={busy} options={[{ value: "script", label: "Install script" }, { value: "docker", label: "Docker" }, { value: "manual", label: "Manual" }, { value: "ssh", label: "Over SSH" }]} /></div>
  {#key method}
    <div class="grid min-w-0 gap-4" in:pageIn>
      {#if method === "ssh"}
        <WorkerSshInstall {name} bind:busy {onenrollment} {oninstalled} />
      {:else if method === "docker"}
        <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Enroll once, then run with a persistent home volume. Agent CLIs are not included: extend the image with Claude, Codex or Grok and sign in inside the container.</p>
        <SetupTabs label="Docker instructions" bind:value={dockerMode} options={[{ value: "run", label: "docker run" }, { value: "compose", label: "Compose" }]} />
        <CommandBlock text={docker} {copyable} label="Docker · enroll and start" />
        {#if dockerMode === "compose"}<CommandBlock text={compose} label="compose.yaml" />{/if}
      {:else}
        <div class="flex flex-wrap gap-3">
          <SetupTabs label="Operating system" bind:value={os} options={[{ value: "linux", label: "Linux" }, { value: "darwin", label: "macOS" }]} />
          {#if os === "linux"}<SetupTabs label="Architecture" bind:value={arch} options={[{ value: "x64", label: "x64" }, { value: "arm64", label: "arm64" }]} />{/if}
        </div>
        {#if os === "darwin"}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">macOS requires Apple Silicon (arm64) and a logged-in user session for the LaunchAgent.</p>{/if}
        {#if metadataError}<Alert tone="warning">{metadataError}{#snippet actions()}<Button size="sm" onclick={() => retry++}>Retry release lookup</Button>{/snippet}</Alert>
        {:else if metadata?.fallback}<Alert tone="warning">This gateway version has no published mirror. Downloading GitHub release {metadata.version} from the {channel} channel instead. It may require a gateway update for compatibility.</Alert>{/if}
        {#if method === "script"}
          <CommandBlock text={command} copyable={copyable && !!metadata} label="Terminal · run as your regular user" />
          <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Downloads a verified binary, enrolls and starts a user service. No administrator access is needed. Linux users may need an administrator to enable linger for startup after logout.</p>
        {:else}
          <CommandBlock text={manual} copyable={copyable && !!metadata} label="Terminal · download, verify and enroll" />
          <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Save the unit or plist printed by <code>service</code> at the path it shows, then run its startup commands. Add your agent CLI directories to the service’s PATH.</p>
        {/if}
      {/if}
    </div>
  {/key}
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Keep enrollment commands private. The token works once. Install and sign in to your agent CLIs on this machine.</p>
</div>
