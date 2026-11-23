import type { ui } from "@canopy/contracts";
import { Notice } from "../../ui/components";
import { SettingToggle } from "./SettingsGroup";
import { confirmAction } from "./resource";

const syncStatus = new Map(
  Object.entries({
    up_to_date: "Configuration up to date",
    syncing: "Syncing configuration…",
    unreachable: "Configuration sync resumes when this computer reconnects.",
  }),
);

export function ComputerConfigSharing({
  computer,
  busy,
  onChange,
}: {
  computer: ui.LinkedComputer;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const name = computer.displayName || computer.name;
  const waiting = computer.configSyncStatus === "needs_update";
  const stopped = !waiting && !computer.peerShareConfig;

  const status = waiting
    ? computer.shareConfig
      ? "Sharing starts after the update."
      : "Sharing stays off after the update."
    : syncStatus.get(computer.configSyncStatus);

  const updatedBy = computer.configUpdateNodeId === computer.nodeId ? name : "This computer";

  const description = stopped
    ? `${name} stopped sharing configuration. This computer keeps its copy.`
    : waiting
      ? computer.configUpdateNodeId
        ? `${updatedBy} needs an update to share configuration.`
        : "An update is needed to share configuration."
      : "Settings, providers and proxies follow changes on computers in the same group.";

  return (
    <>
      <SettingToggle
        title="Share configuration"
        description={[description, status].filter(Boolean).join(" ")}
        value={computer.shareConfig && !stopped}
        disabled={busy || (stopped && computer.shareConfig)}
        onChange={(enabled) => {
          if (enabled || waiting) onChange(enabled);
          else
            confirmAction(
              "Stop sharing",
              [
                `Both computers keep their current configuration. Later changes stay on each computer.`,
                computer.configAlternativeName &&
                  `${name} still gets changes through ${computer.configAlternativeName}.`,
              ]
                .filter(Boolean)
                .join(" "),
              () => onChange(false),
            );
        }}
      />
      {computer.configClockAheadMinutes > 5 && (
        <Notice>Clock is {computer.configClockAheadMinutes} minutes ahead.</Notice>
      )}
    </>
  );
}
