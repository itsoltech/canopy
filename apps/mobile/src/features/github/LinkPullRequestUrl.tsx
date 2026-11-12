import { useState } from "react";
import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { RepositoryAccessActions } from "./RepositoryAccessActions";

interface LinkPullRequestProps {
  threadId: string;
  revision: bigint;
  onlinked: (value: github.ThreadPullRequestsResponse) => void;
  initialUrl?: string;
}

export function LinkPullRequestUrl({ threadId, revision, onlinked, initialUrl = "" }: LinkPullRequestProps) {
  const { client } = useSession();
  const [url, setUrl] = useState(initialUrl);
  const [selection, setSelection] = useState<github.GitHubRepositoryAccountResponse>();
  const [accountId, setAccountId] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const node = splitId(threadId).node;
  const homeId = node ? `${GITHUB_HOME}~${node}` : "";

  async function check() {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    setSelection(undefined);

    try {
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9][0-9]*$/.exec(url.trim());

      if (!match) {
        setError("Enter a GitHub pull request URL.");

        return;
      }

      const value = await client.api.getGitHubRepositoryAccount({ homeId, repositoryName: match[1]! });
      setSelection(value);
      setAccountId(
        value.candidates.some((a) => a.id === value.accountId)
          ? value.accountId
          : value.candidates.length === 1
            ? value.candidates[0]!.id
            : "",
      );
    } catch {
      setError("Could not check repository access. Check the connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (!client || !selection || !accountId || busy) return;
    setBusy(true);
    setError("");

    try {
      if (selection.accountId !== accountId)
        setSelection(
          await client.api.setGitHubRepositoryAccount({
            homeId,
            repositoryName: selection.repositoryName,
            accountId,
            expectedRevision: selection.revision,
          }),
        );
      onlinked(await client.api.linkThreadPullRequest({ threadId, url: url.trim(), expectedRevision: revision }));
    } catch {
      setError("Could not link this pull request. Check repository access and refresh before retrying.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <Field
        label="Pull request URL"
        value={url}
        placeholder="https://github.com/owner/repo/pull/123"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(value) => {
          setUrl(value);
          setSelection(undefined);
        }}
      />
      {selection &&
        (selection.candidates.length > 1 ? (
          <>
            <SelectField
              label="GitHub account"
              value={selection.candidates.find((a) => a.id === accountId)?.login ?? "Choose an account"}
              onPress={() => setChoosing(true)}
            />
          </>
        ) : !selection.candidates.length ? (
          <>
            <Notice>No connected GitHub account can access {selection.repositoryName}.</Notice>
            <RepositoryAccessActions homeId={homeId} onconnected={() => void check()} />
          </>
        ) : null)}
      {!!error && <Notice error>{error}</Notice>}
      <Button
        title={busy ? "Checking…" : selection ? "Link pull request" : "Check access"}
        disabled={busy || (!!selection && !accountId)}
        onPress={() => void (selection ? link() : check())}
      />
      <PickerSheet
        title="Choose an account"
        visible={choosing}
        value={accountId}
        sections={[{ options: selection?.candidates.map((a) => ({ value: a.id, label: a.login })) ?? [] }]}
        onClose={() => setChoosing(false)}
        onSelect={(value) => {
          setAccountId(value);
          setChoosing(false);
        }}
      />
    </View>
  );
}
