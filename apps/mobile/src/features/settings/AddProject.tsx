import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Field, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkerPresence } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { useAddProject } from "./use-add-project";
import { CloneProgress } from "./CloneProgress";

export function AddProject({ onSaved, onBusy }: { onSaved: () => void; onBusy: (busy: boolean) => void }) {
  const { workers } = useOverview();
  const presence = useWorkerPresence();
  const workerOptions = useWorkerOptions();
  const [workerId, setWorker] = useState(workers[0]?.id ?? "");
  const [kind, setKind] = useState("directory");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const worker = workers.find((w) => w.id === workerId);
  const action = useAddProject(onSaved, onBusy);
  const { busy, error } = action;
  const cloning = kind === "clone" || kind === "github";

  const repository = url
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");

  const cloneUrl =
    kind === "github" && /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}.git` : url.trim();

  return (
    <>
      <SettingChoice
        title="Worker"
        value={workerId}
        onChange={(value) => {
          setWorker(value);
          action.reset();
        }}
        options={workerOptions(workers).map((option) => ({
          ...option,
          disabled: busy || option.disabled,
        }))}
      />
      <SettingChoice
        title="Source"
        value={kind}
        onChange={(value) => {
          setKind(value);
          action.reset();
        }}
        options={[
          { value: "directory", label: "Existing directory", disabled: busy },
          { value: "init", label: "New project", disabled: busy || !worker?.projectSources },
          { value: "clone", label: "Git URL", disabled: busy || !worker?.projectSources },
          { value: "github", label: "GitHub repository", disabled: busy || !worker?.projectSources },
        ]}
      />
      {cloning && (
        <>
          <Field
            label={kind === "github" ? "GitHub repository" : "Git URL"}
            value={url}
            onChangeText={setUrl}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Notice>
            {worker?.name || "This computer"} clones with its own Git sign-in. Private repositories need access there.
          </Notice>
        </>
      )}
      {kind !== "directory" && <Field label="Directory name" value={name} onChangeText={setName} editable={!busy} />}
      {!busy && workerId && presence(worker).online && (
        <DirectoryBrowser workerId={workerId} value={path} onChange={setPath} />
      )}
      {cloning && action.attempted && (
        <CloneProgress
          capable={worker?.cloneProgress ?? false}
          progress={action.progress}
          busy={busy}
          failed={!!error}
          onCancel={worker?.cloneProgress ? action.cancel : undefined}
        />
      )}
      {!!error && <Notice error>{error}</Notice>}
      <Button
        variant="primary"
        title={
          error ? "Retry" : kind === "directory" ? "Add project" : kind === "init" ? "Create project" : "Clone project"
        }
        busy={busy}
        disabled={
          !workerId ||
          !presence(worker).online ||
          !path ||
          (kind !== "directory" && (!name.trim() || !worker?.projectSources)) ||
          (kind === "github" && !/^[\w.-]+\/[\w.-]+$/.test(repository)) ||
          (kind === "clone" && !/^(?:[\w.-]+@[\w.-]+:\S+|(?:https?|ssh|git|file):\/\/\S+)$/i.test(cloneUrl))
        }
        onPress={() =>
          void action.add(
            create(ui.AddProjectRequestSchema, {
              workerId,
              source:
                kind === "directory"
                  ? { case: "directoryPath", value: path }
                  : kind === "init"
                    ? { case: "init", value: { parentPath: path, name } }
                    : { case: "clone", value: { parentPath: path, name, url: cloneUrl } },
            }),
            worker?.cloneProgress ?? false,
          )
        }
      />
    </>
  );
}
