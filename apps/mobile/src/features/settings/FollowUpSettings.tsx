import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { ResetSetting } from "./ResetSetting";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";

export function FollowUpSettings({ settings }: { settings: ReturnType<typeof useAppearance> }) {
  const composer = settings.user?.composer;

  const delivery =
    composer?.runningDelivery === ui.MessageDelivery.QUEUE ? ui.MessageDelivery.QUEUE : ui.MessageDelivery.STEER;

  const disabled = !settings.user || settings.saving;

  const change = (runningDelivery: ui.MessageDelivery) =>
    void settings.update({ composer: create(ui.ComposerSettingsSchema, { ...composer, runningDelivery }) });

  return (
    <SettingsGroup title="Messages">
      <SettingChoice
        title="When the agent is working, send messages as"
        description="Steer joins the current turn, while Queue waits for the next turn."
        value={delivery}
        options={[
          { value: ui.MessageDelivery.STEER, label: "Steer", description: "Joins the current turn." },
          { value: ui.MessageDelivery.QUEUE, label: "Queue", description: "Waits for the next turn." },
        ]}
        disabled={disabled}
        onChange={change}
        accessory={
          <ResetSetting
            label="Reset message delivery"
            changed={delivery === ui.MessageDelivery.QUEUE}
            disabled={disabled}
            onReset={() => change(ui.MessageDelivery.STEER)}
          />
        }
      />
    </SettingsGroup>
  );
}
