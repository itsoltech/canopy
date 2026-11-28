import { useState } from "react";
import type { ui } from "@canopy/contracts";
import {
  eligibleSourceAccounts,
  sourceGitHubRepository,
  sourceUrl,
  type SourceKind,
} from "@canopy/domain/source-access";
import { Field, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { useSettingsResource } from "./resource";

export function useSourcePreview<T>(kind: SourceKind, existing?: ui.LibrarySkill | ui.EnvironmentMarketplace) {
  const resource = useSettingsResource("ListConnectors", (api) => api.listConnectors({}));
  const [command, setCommand] = useState(existing?.source?.url ?? "");
  const repository = sourceGitHubRepository(sourceUrl(command, kind));

  const github = useSettingsResource(
    "ListGitHubAccounts:",
    (api) => api.listGitHubAccounts({}),
    !!repository && !existing,
  );

  const [accountId, setAccountId] = useState("");
  const [review, setReview] = useState<{ command: string; credentialAccountId: string; result: T }>();

  const accounts = existing
    ? []
    : eligibleSourceAccounts(command, kind, resource.data?.accounts ?? [], github.data?.accounts ?? []);

  const credentialAccountId = accounts.find((account) => account.id === accountId)?.id ?? "";

  if (credentialAccountId !== accountId) setAccountId(credentialAccountId);

  const preview =
    review?.command === command && review.credentialAccountId === credentialAccountId ? review.result : undefined;

  const label =
    kind === "marketplace"
      ? "Repository or marketplace command"
      : existing
        ? "Source URL"
        : "URL, Git reference or install command";

  return {
    resource,
    request: { command, credentialAccountId },
    preview,
    setPreview: (result?: T) => setReview(result === undefined ? undefined : { command, credentialAccountId, result }),
    fields: (
      <>
        <Field
          label={label}
          placeholder={kind === "skill" && !existing ? "https://example.com" : undefined}
          value={command}
          onChangeText={setCommand}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!existing}
        />
        {accounts.length > 0 && (
          <SettingChoice
            title={kind === "skill" ? "Source account" : "Source access"}
            value={credentialAccountId}
            onChange={setAccountId}
            options={[
              { value: "", label: kind === "skill" ? "Public source" : "Public repository" },
              ...accounts.map((account) => ({ value: account.id, label: account.label })),
            ]}
          />
        )}
        {!existing && repository && github.error ? (
          <Notice error>Couldn’t load GitHub accounts. Check the connection and reopen this panel.</Notice>
        ) : null}
      </>
    ),
  };
}
