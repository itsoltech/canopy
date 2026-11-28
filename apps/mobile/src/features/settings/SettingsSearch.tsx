import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useReducer, type ReactNode } from "react";
import { Text, type TextStyle } from "react-native";
import { palette } from "@canopy/ui";
import { settingsSearchWords } from "@canopy/ui/settings";
import { SheetContent } from "../../ui/components";
import { useColors } from "../../ui/theme";

const Search = createContext<{ query: string; pattern: RegExp; style: TextStyle } | null>(null);

type MatchChange = { topic: string; words: string[]; delta: number };

const Report = createContext<((words: string[], delta: number) => void) | null>(null);

/** The visible sidebar query also marks matching words in the open panel, as on desktop. */
export function SettingsSearch({ query, children }: { query: string; children: ReactNode }) {
  const { dark } = useColors();

  const pattern = useMemo(() => {
    // Shared tokenization returns only letters and digits; longer alternatives win on a shared prefix.
    const words = settingsSearchWords(query).sort((a, b) => b.length - a.length);

    return words.length ? new RegExp(`(${words.join("|")})`, "giu") : null;
  }, [query]);

  const highlight = useMemo(
    () =>
      pattern && {
        query: query.trim().toLowerCase(),
        pattern,
        style: { backgroundColor: palette.amber[dark ? 800 : 200], color: palette.amber[dark ? 50 : 950] },
      },
    [query, pattern, dark],
  );

  return <Search.Provider value={highlight}>{children}</Search.Provider>;
}

function useSearch() {
  const search = useContext(Search);
  const inSheet = useContext(SheetContent);

  return inSheet ? null : search;
}

function useReportMatches(text: string, pattern: RegExp | undefined, report: React.ContextType<typeof Report>) {
  useLayoutEffect(() => {
    if (!report || !pattern) return;
    const matches = text.match(pattern);

    if (!matches) return;
    const words = [...new Set(matches.map((match) => match.toLowerCase()))];
    report(words, 1);

    return () => report(words, -1);
  }, [text, pattern, report]);
}

export function SettingsMatch({ text }: { text: string }) {
  const search = useSearch();
  useReportMatches(text, search?.pattern, useContext(Report));

  if (!search) return text;

  return text.split(search.pattern).map((part, index) =>
    index % 2 ? (
      <Text key={index} style={search.style}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

/** Count distinct matched words per topic. Rows can arrive or disappear as section data loads. */
export function useTopicMatches() {
  const search = useSearch();

  const [counts, report] = useReducer(
    (previous: Map<string, Map<string, number>>, { topic, words, delta }: MatchChange) => {
      const counts = new Map(previous.get(topic));

      for (const word of words) {
        const count = (counts.get(word) ?? 0) + delta;

        if (count) counts.set(word, count);
        else counts.delete(word);
      }

      return new Map(previous).set(topic, counts);
    },
    new Map<string, Map<string, number>>(),
  );

  return { query: search?.query, pattern: search?.pattern, counts, report };
}

export function SettingsTopicMatches({
  id,
  label,
  report,
  children,
}: {
  id: string;
  label: string;
  report: (change: MatchChange) => void;
  children: ReactNode;
}) {
  const parent = useContext(Report);

  const update = useCallback(
    (words: string[], delta: number) => {
      report({ topic: id, words, delta });
      parent?.(words, delta);
    },
    [id, report, parent],
  );

  useReportMatches(label, useSearch()?.pattern, update);

  return <Report.Provider value={update}>{children}</Report.Provider>;
}
