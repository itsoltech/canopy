import { useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { github } from "@canopy/contracts";
import { agentBotOptions, agentProjectOptions } from "@canopy/domain/github-agent-access";
import { sameAccess } from "@canopy/domain/access-picker";
import { useAppearance } from "../../state/appearance";
import { useBotList } from "../../state/bot-list";
import { useOverview } from "../../state/overview";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingAccess } from "../settings/SettingAccess";
import { SettingToggle, SettingsGroup } from "../settings/SettingsGroup";
import { SettingsSkeletonGroups } from "../settings/SettingsSkeleton";
import { ResourceState, useSettingsResource } from "../settings/resource";

export type AgentAccessTarget = Pick<
  github.GetGitHubAgentAccessRequest,
  "accountId" | "repositoryId" | "repositoryName"
>;

type Grants = Pick<github.GitHubAgentAccessResponse, "projectIds" | "botIds" | "allowWrites">;

function accessFailure(cause: unknown) {
  switch (ConnectError.from(cause).code) {
    case Code.Aborted:
      return "Access changed while you were editing. Review the current selection and save again.";
    case Code.PermissionDenied:
      return "Could not grant access. Check the GitHub installation and the account selected for this repository.";
    case Code.InvalidArgument:
      return "Could not save these recipients. Choose up to 256 projects and 256 bots from the account’s computer.";
    default:
      return undefined;
  }
}

export function GitHubAgentAccess({
  target,
  removeOnly,
  onClose,
  onSaved,
}: {
  target: AgentAccessTarget;
  removeOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useSettingsResource(
    `GetGitHubAgentAccess:${target.accountId}:${target.repositoryId}`,
    (api) => api.getGitHubAgentAccess(target),
    true,
    accessFailure,
  );

  const access = resource.data;

  return (
    <Sheet title="Agent access" visible onClose={onClose}>
      <ResourceState resource={resource}>
        {!!resource.inlineError && <Notice error>{resource.inlineError}</Notice>}
        {resource.initialLoading && <SettingsSkeletonGroups titles={[target.repositoryName]} />}
        {access && (
          <AgentAccessForm
            key={String(access.revision)}
            target={target}
            access={access}
            removeOnly={removeOnly}
            busy={resource.busy || resource.loading}
            onSave={async (grants) => {
              const result = await resource.run((api) =>
                api.setGitHubAgentAccess({ ...target, ...grants, expectedRevision: access.revision }),
              );

              if (result) onSaved();
            }}
          />
        )}
      </ResourceState>
    </Sheet>
  );
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return sameAccess({ all: false, ids: left }, { all: false, ids: right });
}

function AgentAccessForm({
  target,
  access,
  removeOnly,
  busy,
  onSave,
}: {
  target: AgentAccessTarget;
  access: github.GitHubAgentAccessResponse;
  removeOnly: boolean;
  busy: boolean;
  onSave: (grants: Grants) => void;
}) {
  const { projects } = useOverview();
  const bots = useBotList();
  const { threadsEnabled, botsEnabled } = useAppearance();
  const [projectIds, setProjects] = useState(access.projectIds);
  const [botIds, setBots] = useState(access.botIds);
  const [writes, setWrites] = useState(access.allowWrites);

  const projectOptions = agentProjectOptions(
    target.accountId,
    projects,
    access.projectIds,
    removeOnly || !threadsEnabled,
  );

  const botOptions = agentBotOptions(
    target.accountId,
    bots.data?.bots ?? [],
    access.botIds,
    removeOnly || !botsEnabled,
  );

  const recipients = projectIds.length + botIds.length;
  const allowWrites = recipients > 0 && writes;

  const changed =
    !sameIds(projectIds, access.projectIds) || !sameIds(botIds, access.botIds) || allowWrites !== access.allowWrites;

  return (
    <>
      <SettingsGroup
        title={target.repositoryName}
        description={
          removeOnly
            ? "Remove projects or bots that no longer need this repository."
            : "Selected projects and bots can read files, issues and pull requests in this repository."
        }
      >
        {(threadsEnabled || access.projectIds.length > 0) && (
          <SettingAccess
            title="Projects"
            options={projectOptions}
            ids={projectIds}
            allowAll={false}
            disabled={busy || !projectOptions.length}
            onChange={({ ids }) => setProjects([...ids])}
          />
        )}
        {(botsEnabled || access.botIds.length > 0) && (
          <SettingAccess
            title="Bots"
            options={botOptions}
            ids={botIds}
            allowAll={false}
            disabled={busy || !botOptions.length}
            onChange={({ ids }) => setBots([...ids])}
          />
        )}
        {botsEnabled && !!bots.error && (
          <>
            <Notice error>Could not load bots. Check the connection and retry.</Notice>
            <Button title="Retry" onPress={() => void bots.reload().catch(() => {})} />
          </>
        )}
        <SettingToggle
          title="Allow changes on GitHub"
          description="Selected agents and bots can change issues and pull requests, subject to their approval settings."
          value={allowWrites}
          disabled={busy || !recipients || (removeOnly && !access.allowWrites)}
          onChange={setWrites}
        />
      </SettingsGroup>
      <Button
        title="Save access"
        variant="primary"
        busy={busy}
        disabled={!changed}
        onPress={() => onSave({ projectIds, botIds, allowWrites })}
      />
    </>
  );
}
