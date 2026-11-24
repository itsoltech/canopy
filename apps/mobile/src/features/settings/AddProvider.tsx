import { useState } from "react";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { providerName } from "../models/catalog";
import { ProviderConfiguration, ProviderIdentity } from "./ProviderForm";
import { SettingOptions, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { ResourceState } from "./resource";
import { useProviderForm } from "./useProviderForm";

const agents = [Provider.CODEX, Provider.CLAUDE, Provider.GROK, Provider.ANTIGRAVITY].map((value) => ({
  value,
  label: providerName(value),
}));

export function AddProvider({
  initialWorkerId,
  instances,
  onSaved,
}: {
  initialWorkerId: string;
  instances: ui.ProviderInstance[];
  onSaved: (instance?: ui.ProviderInstance) => void;
}) {
  const [harness, setHarness] = useState(Provider.CODEX);
  const [step, setStep] = useState(0);
  const draft = useProviderForm({ harness, initialWorkerId, onSaved });
  const conflict = instances.some((instance) => instance.harness === harness && instance.id === draft.id);

  const idProblem = !draft.id
    ? ""
    : draft.id === "native"
      ? "This ID is reserved for the built-in device login."
      : !draft.validId
        ? "Start with a letter or number. Use up to 63 lowercase letters, numbers, dashes or underscores."
        : conflict
          ? "This agent already has an instance with this ID."
          : "";

  const canAdvance = step === 0 || (!!draft.label.trim() && !!draft.id && !idProblem);

  return (
    <ResourceState resource={draft.resource}>
      {step === 0 ? (
        <SettingsGroup title="Provider">
          <SettingOptions
            title="Agent"
            value={harness}
            options={agents}
            onChange={(value) => {
              if (value === harness) return;
              setHarness(value);
              draft.setRuntime({
                ...draft.runtime,
                userConfiguration: undefined,
                ownLogin: false,
                ...(value === Provider.ANTIGRAVITY && { homePath: "", launchArgs: "" }),
              });

              if (value === Provider.ANTIGRAVITY) draft.setKind(ProviderProfileKind.NATIVE);
              draft.setProxy("");
              draft.settings.change(undefined);
            }}
          />
        </SettingsGroup>
      ) : step === 1 ? (
        <>
          <ProviderIdentity draft={draft} />
          {!!idProblem && <Notice error>{idProblem}</Notice>}
        </>
      ) : (
        <ProviderConfiguration draft={draft} harness={harness} onSaved={onSaved} />
      )}
      <SettingsActions>
        {step > 0 && <Button title="Back" disabled={draft.resource.busy} onPress={() => setStep(step - 1)} />}
        {step < 2 ? (
          <Button title="Continue" variant="primary" disabled={!canAdvance} onPress={() => setStep(step + 1)} />
        ) : (
          <Button
            title="Add instance"
            variant="primary"
            disabled={!draft.ready || !!idProblem}
            busy={draft.resource.busy}
            onPress={() => void draft.save()}
          />
        )}
      </SettingsActions>
    </ResourceState>
  );
}
