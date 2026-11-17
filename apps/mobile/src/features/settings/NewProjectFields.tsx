import { useState } from "react";
import { ScrollView, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Field, Notice } from "../../ui/components";
import { useColors } from "../../ui/theme";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { CloneProgress } from "./CloneProgress";
import type { useAddProject } from "./use-add-project";
import type { ProjectSource } from "./ProjectSourceChoices";

export function NewProjectFields({
  worker,
  kind,
  action,
  online,
}: {
  worker: ui.Worker;
  kind: Exclude<ProjectSource, "directory">;
  action: ReturnType<typeof useAddProject>;
  online: boolean;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const c = useColors();
  const { busy, error } = action;
  const cloning = kind !== "init";

  const repository = url
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");

  const cloneUrl =
    kind === "github" && /^[\w.-]+\/[\w.-]+$/.test(repository) ? `https://github.com/${repository}.git` : url.trim();

  const validUrl =
    kind === "github"
      ? /^[\w.-]+\/[\w.-]+$/.test(repository)
      : /^(?:[\w.-]+@[\w.-]+:\S+|(?:https?|ssh|git|file):\/\/\S+)$/i.test(cloneUrl);

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16 }}>
        {cloning && (
          <>
            <Field
              label={kind === "github" ? "GitHub repository" : "Git URL"}
              value={url}
              onChangeText={setUrl}
              placeholder={kind === "github" ? "owner/repository" : "https://…"}
              editable={!busy && online}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Notice>{worker.name} clones with its own Git sign-in. Private repositories need access there.</Notice>
          </>
        )}
        <Field
          label="Directory name"
          value={name}
          onChangeText={setName}
          editable={!busy && online}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Notice>Choose the parent directory for your new project.</Notice>
        <View pointerEvents={busy || !online ? "none" : "auto"}>
          <DirectoryBrowser workerId={worker.id} value={path} onChange={setPath} />
        </View>
        {cloning && action.attempted && (
          <CloneProgress
            capable={worker.cloneProgress}
            progress={action.progress}
            busy={busy}
            failed={!!error}
            onCancel={worker.cloneProgress ? action.cancel : undefined}
          />
        )}
        {!!error && <Notice error>{error}</Notice>}
      </ScrollView>
      <View style={{ padding: 16, borderTopWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
        <Button
          variant="primary"
          title={error ? "Retry" : cloning ? "Clone project" : "Create project"}
          busy={busy}
          disabled={!online || !path || !name.trim() || !worker.projectSources || (cloning && !validUrl)}
          onPress={() =>
            void action.add(
              create(ui.AddProjectRequestSchema, {
                workerId: worker.id,
                source:
                  kind === "init"
                    ? { case: "init", value: { parentPath: path, name: name.trim() } }
                    : { case: "clone", value: { parentPath: path, name: name.trim(), url: cloneUrl } },
              }),
              worker.cloneProgress,
            )
          }
        />
      </View>
    </View>
  );
}
