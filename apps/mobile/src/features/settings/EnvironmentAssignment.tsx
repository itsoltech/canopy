import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Field } from "../../ui/components";
import { SettingsGroup, SettingChoice, SettingToggle } from "./SettingsGroup";

export function EnvironmentAssignment({
  value,
  workers,
  onChange,
}: {
  value?: ui.EnvironmentSelector;
  workers: ui.EnvironmentWorker[];
  onChange: (v: ui.EnvironmentSelector) => void;
}) {
  const selector = value ?? create(ui.EnvironmentSelectorSchema, { everyone: true });

  const change = (patch: Partial<ui.EnvironmentSelector>) =>
    onChange(create(ui.EnvironmentSelectorSchema, { ...selector, ...patch }));

  const tags = (text: string) =>
    text
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);

  return (
    <SettingsGroup title="Assign computers">
      <SettingToggle
        title="Every computer"
        description="Includes computers added later."
        value={selector.everyone}
        onChange={(everyone) => change({ everyone })}
      />
      {!selector.everyone && (
        <>
          <Field
            label="Include tags"
            value={selector.tags.join(", ")}
            onChangeText={(text) => change({ tags: tags(text) })}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <SettingChoice
            title="Tag matching"
            value={selector.matchAllTags ? "all" : "any"}
            options={[
              { value: "any", label: "Match any tag" },
              { value: "all", label: "Match every tag" },
            ]}
            onChange={(value) => change({ matchAllTags: value === "all" })}
          />
          {workers.map((worker) => (
            <SettingToggle
              key={worker.workerId}
              title={worker.name}
              value={selector.workerIds.includes(worker.workerId)}
              onChange={(on) =>
                change({
                  workerIds: on
                    ? [...selector.workerIds, worker.workerId]
                    : selector.workerIds.filter((id) => id !== worker.workerId),
                })
              }
            />
          ))}
        </>
      )}
      <Field
        label="Exclude tags"
        value={selector.excludeTags.join(", ")}
        onChangeText={(text) => change({ excludeTags: tags(text) })}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </SettingsGroup>
  );
}

export function EnvironmentDestinations({
  value,
  workers,
  onChange,
}: {
  value: ui.LibrarySkill;
  workers: ui.EnvironmentWorker[];
  onChange: (v: ui.LibrarySkill) => void;
}) {
  const change = (patch: Partial<ui.LibrarySkill>) => onChange(create(ui.LibrarySkillSchema, { ...value, ...patch }));

  return (
    <>
      <SettingsGroup title="Destinations">
        {["claude", "codex", "grok"].map((harness) => (
          <SettingToggle
            key={harness}
            title={harness === "claude" ? "Claude Code" : harness === "codex" ? "Codex" : "Grok"}
            value={value.harnesses.includes(harness)}
            onChange={(on) =>
              change({ harnesses: on ? [...value.harnesses, harness] : value.harnesses.filter((h) => h !== harness) })
            }
          />
        ))}
        <SettingToggle
          title="Canopy sessions"
          value={value.platformHome}
          onChange={(platformHome) => change({ platformHome })}
        />
        <SettingToggle
          title="Device CLI too"
          value={value.deviceHome}
          onChange={(deviceHome) => change({ deviceHome })}
        />
      </SettingsGroup>
      <EnvironmentAssignment value={value.selector} workers={workers} onChange={(selector) => change({ selector })} />
      <SettingsGroup title="Computer overrides">
        {workers.map((worker) => {
          const override = value.overrides.find((o) => o.workerId === worker.workerId);

          const update = (patch: Partial<ui.SkillMachineOverride>) =>
            change({
              overrides: [
                ...value.overrides.filter((o) => o.workerId !== worker.workerId),
                create(ui.SkillMachineOverrideSchema, {
                  ...create(ui.SkillMachineOverrideSchema, override),
                  workerId: worker.workerId,
                  ...patch,
                }),
              ],
            });

          return (
            <SettingsGroup key={worker.workerId} title={worker.name}>
              <SettingToggle
                title="Disabled on this computer"
                value={override?.disabled ?? false}
                onChange={(disabled) => update({ disabled })}
              />
              <SettingChoice
                title="Library version"
                value={String(override?.version ?? 0n)}
                options={[
                  { value: "0", label: "Use library version" },
                  ...value.versions.map((v) => ({ value: String(v), label: `Version ${v}` })),
                ]}
                onChange={(v) => update({ version: BigInt(v) })}
              />
            </SettingsGroup>
          );
        })}
      </SettingsGroup>
    </>
  );
}
