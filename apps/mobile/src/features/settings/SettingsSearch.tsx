import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Text, type TextStyle } from "react-native";
import { palette } from "@canopy/ui";
import { settingsSearchWords } from "@canopy/ui/settings";
import { SheetContent } from "../../ui/components";
import { useColors } from "../../ui/theme";

const Search = createContext<{ pattern: RegExp; style: TextStyle } | null>(null);

/** The visible sidebar query also marks matching words in the open panel, as on desktop. */
export function SettingsSearch({ query, children }: { query: string; children: ReactNode }) {
  const { dark } = useColors();

  const highlight = useMemo(() => {
    // Shared tokenization returns only letters and digits; longer alternatives win on a shared prefix.
    const words = settingsSearchWords(query).sort((a, b) => b.length - a.length);

    return words.length
      ? {
          pattern: new RegExp(`(${words.join("|")})`, "giu"),
          style: { backgroundColor: palette.amber[dark ? 800 : 200], color: palette.amber[dark ? 50 : 950] },
        }
      : null;
  }, [query, dark]);

  return <Search.Provider value={highlight}>{children}</Search.Provider>;
}

export function SettingsMatch({ text }: { text: string }) {
  const search = useContext(Search);
  const inSheet = useContext(SheetContent);

  if (!search || inSheet) return text;

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
