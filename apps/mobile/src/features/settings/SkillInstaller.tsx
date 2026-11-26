import { useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { SkillArtifact, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { SkillInstallerConsole } from "./SkillInstallerConsole";
import { SkillInstallerSession, type SkillInstallerState } from "./skill-installer-session";

type InstallerView = { session: SkillInstallerSession; name: string; state: SkillInstallerState };

export function SkillInstaller({
  workers,
  onCollect,
  onImport,
  onRefresh,
}: {
  workers: ui.EnvironmentWorker[];
  onCollect: (artifact: SkillArtifact, workerId: string) => void;
  onImport: () => void;
  onRefresh: () => void;
}) {
  const { client } = useSession();
  const api = client?.api;
  const type = useTypography();
  const { width, fontScale } = useWindowDimensions();
  const [command, setCommand] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [view, setView] = useState<InstallerView>();
  const current = useRef<SkillInstallerSession | undefined>(undefined);

  useLayoutEffect(
    () => () => {
      current.current?.dispose();
      current.current = undefined;
    },
    [api],
  );

  const available = workers.filter((worker) => worker.online && worker.skillInstallerSupported);
  const selected = workerId ? available.find((worker) => worker.workerId === workerId) : available[0];

  function run() {
    if (!api || current.current || !selected || !command.trim() || command.includes("\0")) return;

    const name = selected.name || selected.workerId;
    const cols = Math.max(20, Math.floor((Math.min(600, width) - 64) / (type.mono.fontSize * fontScale * 0.6)));

    const session = new SkillInstallerSession(api, selected.workerId, cols, (state) => {
      if (current.current === session) setView({ session, name, state });
    });

    current.current = session;
    void session.start(command);
  }

  function reset() {
    current.current?.dispose();
    current.current = undefined;
    setView(undefined);
  }

  async function collect(path: string) {
    const session = current.current;
    const artifact = await session?.collect(path);

    if (artifact && session && current.current === session) onCollect(artifact, session.workerId);
  }

  function importFiles() {
    reset();
    onImport();
  }

  if (view && view.session.api === api) {
    return <InstallerRun view={view} onCollect={(path) => void collect(path)} onReset={reset} onImport={importFiles} />;
  }

  return (
    <View style={layout.stack}>
      <Field
        label="Installer command"
        placeholder="Paste the publisher’s command"
        value={command}
        onChangeText={setCommand}
        maxLength={4096}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        multiline
        style={{ fontFamily: type.mono.fontFamily }}
      />
      <Notice>Use a command from a publisher you trust. It runs with your access on the selected computer.</Notice>
      {available.length ? (
        <InstallerChoice
          label="Run on"
          placeholder="Choose a computer"
          value={selected?.workerId}
          options={available.map((worker) => ({
            value: worker.workerId,
            label: worker.name || worker.workerId,
            wrapLabel: true,
          }))}
          onChange={setWorkerId}
        />
      ) : (
        <Notice>
          No online computer can run the installer. Connect a supported computer or import the skill folder.
        </Notice>
      )}
      <View style={layout.actions}>
        {available.length ? (
          <Button
            title="Run installer"
            variant="primary"
            disabled={!selected || !command.trim() || command.includes("\0") || !api}
            onPress={run}
          />
        ) : (
          <Button title="Refresh computers" onPress={onRefresh} />
        )}
        <Button title="Import from folder or ZIP" variant="text" onPress={importFiles} />
      </View>
    </View>
  );
}

function InstallerRun({
  view: { state, session, name },
  onCollect,
  onReset,
  onImport,
}: {
  view: InstallerView;
  onCollect: (path: string) => void;
  onReset: () => void;
  onImport: () => void;
}) {
  const active = state.phase === "starting" || state.phase === "running" || state.phase === "stopping";

  return (
    <View style={layout.stack}>
      <SkillInstallerConsole
        state={state}
        computer={name}
        active={active}
        onSend={(value) => session.send(value)}
        onStop={() => void session.stop()}
      />
      {state.error ? <Notice error>{state.error}</Notice> : null}
      {state.paths.length > 0 && (
        <InstallerResult paths={state.paths} collecting={state.collecting} onCollect={onCollect} />
      )}
      {state.phase === "finished" && !state.paths.length && (
        <Notice>No skill found. Import its folder if you have it.</Notice>
      )}
      {!active && (
        <View style={layout.actions}>
          <Button title="Edit command" disabled={state.collecting} onPress={onReset} />
          <Button title="Import from folder or ZIP" variant="text" disabled={state.collecting} onPress={onImport} />
        </View>
      )}
    </View>
  );
}

function InstallerResult({
  paths,
  collecting,
  onCollect,
}: {
  paths: string[];
  collecting: boolean;
  onCollect: (path: string) => void;
}) {
  const c = useColors();
  const type = useTypography();
  const [chosen, setChosen] = useState("");
  const path = paths.length === 1 ? paths[0] : chosen;

  return (
    <View style={layout.stack}>
      {paths.length === 1 ? (
        <View style={layout.label}>
          <Text style={[type.chrome, { color: c.text }]}>Skill folder</Text>
          <Text selectable style={[type.mono, { color: c.muted }]}>
            {path}
          </Text>
        </View>
      ) : (
        <InstallerChoice
          label="Skill folder"
          placeholder="Choose a folder"
          value={path}
          options={paths.map((item) => ({ value: item, label: item, wrapLabel: true }))}
          disabled={collecting}
          onChange={setChosen}
        />
      )}
      <Button
        title="Review skill"
        variant="primary"
        disabled={!path}
        busy={collecting}
        onPress={() => path && onCollect(path)}
      />
    </View>
  );
}

function InstallerChoice({
  label,
  placeholder,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  value?: string;
  options: PickerOption<string>[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SelectField
        label={label}
        value={options.find((item) => item.value === value)?.label ?? placeholder}
        expanded={open}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      {open && (
        <PickerSheet
          title={label}
          visible={open}
          onClose={() => setOpen(false)}
          value={value ?? ""}
          sections={[{ options }]}
          onSelect={onChange}
        />
      )}
    </>
  );
}

const layout = StyleSheet.create({
  stack: { gap: 12 },
  label: { gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
});
