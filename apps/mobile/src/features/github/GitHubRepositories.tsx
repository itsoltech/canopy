import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Badge } from "../../ui/Badge";
import { Button, Notice } from "../../ui/components";
import { SearchField } from "../../ui/SearchField";
import { useColors, useTypography } from "../../ui/theme";
import { useGitHubRepositories } from "./useGitHubRepositories";

export function GitHubRepositories({ accountId, installationId }: { accountId: string; installationId: string }) {
  const c = useColors();
  const type = useTypography();
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const { repos, next, total, busy, error, load } = useGitHubRepositories(accountId, installationId);
  const matches = repos.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  const shown = all || query ? matches : matches.slice(0, 5);

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      {total > 10 && (
        <SearchField
          label="Search repositories"
          placeholder="Search repositories…"
          value={query}
          onChange={(value) => {
            setQuery(value);

            if (next) load(true);
          }}
        />
      )}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 288 }}>
        {shown.map((repo) => (
          <View
            key={repo.repositoryId}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}
          >
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              accessibilityLabel={repo.fullName}
              style={[type.chrome, { color: c.text, minWidth: 0, flex: 1 }]}
            >
              {repo.fullName}
            </Text>
            <Badge>{repo.private ? "Private" : "Public"}</Badge>
          </View>
        ))}
      </ScrollView>
      {!shown.length && !busy && !error && (
        <Text style={[type.meta, { color: c.muted }]}>
          {query
            ? "No repositories match your search."
            : "No accessible repositories. Choose repositories on GitHub or ask an administrator for access."}
        </Text>
      )}
      {total > 5 && !query && (
        <Button
          title={all ? "Show fewer" : `Show all ${total}`}
          size="sm"
          variant="text"
          disabled={busy}
          onPress={() => {
            setAll(!all);

            if (!all && next) load(true);
          }}
        />
      )}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          Loading repositories…
        </Text>
      )}
      {!!error && (
        <>
          <Notice error>{error}</Notice>
          <Button title="Retry" size="sm" onPress={() => load(Boolean(next))} />
        </>
      )}
    </View>
  );
}
