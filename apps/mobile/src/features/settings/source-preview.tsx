import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { eligibleSourceAccounts, type SourceKind } from "@canopy/domain/source-access";
import { Field } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { useSettingsResource } from "./resource";

export function useSourcePreview<T>(kind: SourceKind, existing?: ui.LibrarySkill | ui.EnvironmentMarketplace) {
  const resource = useSettingsResource("ListConnectors", (api) => api.listConnectors({}));
  const [command, setCommand] = useState(existing?.source?.url ?? "");
  const [accountId, setAccountId] = useState("");
  const [review, setReview] = useState<{ command: string; credentialAccountId: string; result: T }>();
  const accounts = existing ? [] : eligibleSourceAccounts(command, kind, resource.data?.accounts ?? []);
  const credentialAccountId = accounts.find((account) => account.id === accountId)?.id ?? "";

  if (credentialAccountId !== accountId) setAccountId(credentialAccountId);

  const preview =
    review?.command === command && review.credentialAccountId === credentialAccountId ? review.result : undefined;

  return {
    resource,
    request: { command, credentialAccountId },
    preview,
    setPreview: (result?: T) => setReview(result === undefined ? undefined : { command, credentialAccountId, result }),
    fields: (
      <>
        <Field
          label={kind === "skill" ? "Git reference or install command" : "Repository or marketplace command"}
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
              { value: "", label: "Public repository" },
              ...accounts.map((account) => ({ value: account.id, label: account.name })),
            ]}
          />
        )}
      </>
    ),
  };
}
