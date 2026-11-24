import type { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { IconButton, Notice } from "../../ui/components";
import { useComputerHome } from "../computers/presence";
import { useWorkerRecordOptions } from "../computers/worker-options";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { EnvironmentComputer } from "./EnvironmentComputer";
import { LinkedEnvironmentComputer } from "./LinkedEnvironmentComputer";

export function EnvironmentComputers({
  snapshot,
  records,
  busy,
  workerId,
  setWorker,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  records: ui.WorkerRecord[];
  busy: boolean;
  workerId: string;
  setWorker: (id: string) => void;
  onChanged: () => void;
}) {
  const liveOptions = useWorkerRecordOptions(records.filter((record) => !record.revoked));

  const options = [
    ...liveOptions.filter(
      (option) => !!splitId(option.value).node || snapshot.workers.some((worker) => worker.workerId === option.value),
    ),
    ...snapshot.workers
      .filter((worker) => !liveOptions.some((option) => option.value === worker.workerId))
      .map((worker) => ({
        value: worker.workerId,
        label: worker.name,
        description: worker.online ? "Online" : "Offline",
      })),
  ];

  const selected = workerId || snapshot.workers[0]?.workerId || options[0]?.value || "";
  const unavailable = !!selected && !options.some((option) => option.value === selected);

  const local = snapshot.workers.find((worker) => worker.workerId === selected);
  const node = splitId(selected).node;
  const record = records.find((item) => item.workerId === selected);
  const home = useComputerHome(node);

  const reason =
    record?.readOnlyReason ??
    (node ? home.reason || "Manage this worker on its own computer. Configuration is not shared." : "");

  return (
    <>
      <SettingsGroup
        title="Computer status"
        actions={
          !!local && <IconButton icon="arrow-path" size="sm" label="Refresh status" busy={busy} onPress={onChanged} />
        }
      >
        {options.length ? (
          <SettingChoice
            title="Computer"
            compact
            value={selected}
            onChange={setWorker}
            options={
              unavailable ? [{ value: selected, label: "Unavailable computer", disabled: true }, ...options] : options
            }
          />
        ) : (
          <SettingsRow title="No computers yet" description="Add a worker to sync its agent environment." />
        )}
      </SettingsGroup>
      {unavailable ? (
        options.length > 0 && (
          <Notice>This computer is unavailable. Choose another computer to manage its environment.</Notice>
        )
      ) : node ? (
        <LinkedEnvironmentComputer key={selected} workerId={selected} reason={reason} />
      ) : (
        local && (
          <EnvironmentComputer key={local.workerId} worker={local} revision={snapshot.revision} onChanged={onChanged} />
        )
      )}
    </>
  );
}
