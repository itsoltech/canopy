import { Linking, Text, View } from "react-native";
import type { ItemStatus, WebSearch } from "@canopy/contracts";
import { prettyJson } from "@canopy/domain/format";
import { objectsOf, parseJson, str } from "@canopy/domain/json";
import { styles } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { CodeBlock } from "../CodeBlock";
import { ItemFrame } from "../ItemFrame";
import { EmptyNote, RowTitle } from "./parts";

/** Web search: the query, and the results as links when they have a recognisable shape (web: WebSearchView). */
export function WebSearchView({ search, status }: { search: WebSearch; status: ItemStatus }) {
  const sky = useTone("sky").text;

  const results = objectsOf(parseJson(search.resultsJson)).flatMap((r) => {
    const href = str(r["url"]);

    return /^https?:\/\//i.test(href) ? [{ href, title: str(r["title"]) || href }] : [];
  });

  return (
    <ItemFrame
      icon="globe-alt"
      status={status}
      label={`Searched the web ${search.query}`}
      title={<RowTitle lead="Searched the web" subject={search.query} />}
    >
      {results.length > 0 ? (
        <View style={{ gap: 4 }}>
          {results.map((result) => (
            <Text
              key={result.href}
              numberOfLines={1}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(result.href).catch(() => undefined)}
              style={[styles.work, { color: sky, textDecorationLine: "underline", textDecorationColor: `${sky}4d` }]}
            >
              {result.title}
            </Text>
          ))}
        </View>
      ) : search.resultsJson ? (
        <CodeBlock text={prettyJson(search.resultsJson)} label="Search results" />
      ) : (
        <EmptyNote>No results recorded.</EmptyNote>
      )}
    </ItemFrame>
  );
}
