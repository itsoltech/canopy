import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { copyText } from "../viewers/useCopyText";
import { Button, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;

export function WorkerInstallCommands({
  method,
  setup,
  gateway,
  name,
}: {
  method: string;
  setup: ui.GetWorkerSetupResponse;
  gateway: string;
  name: string;
}) {
  const [platform, setPlatform] = useState("linux/x64");

  const resource = useSettingsResource(`FetchWorkerInstall:${platform}`, async (api) => {
    const [os, arch] = platform.split("/");

    for await (const chunk of api.fetchWorkerInstall({ os, arch, metadataOnly: true, channelFallback: true }))
      return chunk;

    throw new Error("No release metadata");
  });

  const metadata =
    resource.data ??
    (resource.initialLoading ? create(ui.WorkerInstallChunkSchema, { version: setup.gatewayVersion }) : undefined);

  const asset = `canopy-worker-${platform.replace("/", "-")}`;
  const enroll = `enroll --gateway ${quote(gateway)}${setup.gatewayFingerprint ? ` --fingerprint ${quote(setup.gatewayFingerprint)}` : ""}`;
  const tag = metadata?.version || setup.gatewayVersion;
  const image = `ghcr.io/itsoltech/canopy-worker:${/^\d/.test(tag) ? `v${tag}` : setup.channel}`;
  const docker = `docker volume create canopy-worker &&\ndocker run --rm -it -v canopy-worker:/home/canopy ${image} ${enroll} &&\ndocker run -d --name canopy-worker --restart unless-stopped -v canopy-worker:/home/canopy ${image}`;

  const manual = metadata
    ? `(\nset -eu\numask 077\nmkdir -p "$HOME/.local/share/canopy/bin"\ncd "$(mktemp -d)"\ncurl -fL ${quote(metadata.downloadUrl)} -o ${quote(asset)}\nprintf '%s  %s\\n' ${quote(metadata.sha256)} ${quote(asset)} | ${platform.startsWith("darwin") ? "shasum -a 256" : "sha256sum"} -c -\ninstall -m 0755 ${quote(asset)} "$HOME/.local/share/canopy/bin/canopy-worker"\n"$HOME/.local/share/canopy/bin/canopy-worker" ${enroll} --config "$HOME/.config/canopy/worker.json"\n"$HOME/.local/share/canopy/bin/canopy-worker" service --config "$HOME/.config/canopy/worker.json"\n)`
    : "";

  const script =
    metadata?.downloadUrl &&
    `curl -fsSL ${quote(`https://raw.githubusercontent.com/itsoltech/canopy/v${metadata.version}/scripts/install-worker.sh`)} | sh -s -- --gateway ${quote(gateway)}${setup.gatewayFingerprint ? ` --fingerprint ${quote(setup.gatewayFingerprint)}` : ""} --name ${quote(name)} --release-url ${quote(metadata.downloadUrl)} --checksum-url ${quote(metadata.downloadUrl.replace(/\/[^/]+$/, "/checksums.txt"))}`;

  const command = method === "docker" ? docker : method === "script" ? script : manual;

  return (
    <ResourceState resource={resource}>
      {method !== "docker" && (
        <SettingChoice
          title="Operating system and architecture"
          value={platform}
          onChange={setPlatform}
          options={[
            { value: "linux/x64", label: "Linux x64" },
            { value: "linux/arm64", label: "Linux arm64" },
            { value: "darwin/arm64", label: "macOS Apple Silicon" },
          ]}
        />
      )}
      {resource.data && metadata && metadata.version !== setup.gatewayVersion && (
        <Notice>
          This gateway version is unavailable. Use compatible release {metadata.version} from the {setup.channel}{" "}
          channel.
        </Notice>
      )}
      {method === "script" && (
        <Notice>
          Run these commands on the computer that will host the worker. They download, verify and enroll it. Then follow
          the startup instructions printed by the final command.
        </Notice>
      )}
      <SettingsValue
        title={method === "docker" ? "Docker · enroll and start" : "Terminal · download, verify and enroll"}
        value={command}
      />
      {!!command && <Button size="sm" title="Copy command" onPress={() => void copyText(command)} />}
      {method === "docker" && (
        <SettingsValue
          title="compose.yaml"
          value={`# Enroll using docker run above first\nservices:\n  worker:\n    image: ${image}\n    restart: unless-stopped\n    volumes:\n      - canopy-worker:/home/canopy\nvolumes:\n  canopy-worker:\n    external: true`}
        />
      )}
      {!metadata && resource.error && <Button title="Retry release lookup" onPress={() => void resource.reload()} />}
    </ResourceState>
  );
}
