import { Fragment, useMemo } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { marked, type Token, type Tokens } from "marked";
import { font, styles, useColors, useTypography } from "./theme";
import { useDevicePreferences } from "../features/settings/device-preferences";
import { Diff } from "./Diff";

// Native text only: no HTML/WebView, embedded remote images, or executable URL schemes.
function openLink(url: string) {
  if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => undefined);
}

function Inline({ tokens }: { tokens: Token[] }) {
  const c = useColors();

  return (
    <>
      {tokens.map((token, i) => {
        const nested =
          "tokens" in token && token.tokens ? (
            <Inline tokens={token.tokens} />
          ) : "text" in token ? (
            String(token.text)
          ) : (
            token.raw
          );

        if (token.type === "strong")
          return (
            <Text key={i} style={{ fontFamily: font.semibold }}>
              {nested}
            </Text>
          );

        if (token.type === "em")
          return (
            <Text key={i} style={{ fontStyle: "italic" }}>
              {nested}
            </Text>
          );

        if (token.type === "codespan")
          return (
            <Text key={i} style={{ fontFamily: "monospace", backgroundColor: c.inset }}>
              {token.text}
            </Text>
          );

        if (token.type === "link")
          return (
            <Text
              key={i}
              accessibilityRole="link"
              style={{ color: c.accent, textDecorationLine: "underline" }}
              onPress={() => openLink(token.href)}
            >
              {nested}
            </Text>
          );

        if (token.type === "image") return <Text key={i}>[Image: {token.text || "attachment"}]</Text>;

        if (token.type === "br") return <Text key={i}>{"\n"}</Text>;

        return <Fragment key={i}>{nested}</Fragment>;
      })}
    </>
  );
}

function Block({ token }: { token: Token }) {
  const c = useColors();
  const type = useTypography();
  const { values } = useDevicePreferences();

  if (token.type === "space") return null;

  if (token.type === "code" && token.lang === "diff") return <Diff diff={token.text} />;

  if (token.type === "code")
    return (
      <ScrollView
        horizontal={values.wrapCode !== "on"}
        style={{ padding: 14, borderRadius: 10, backgroundColor: c.inset }}
      >
        <Text
          selectable
          style={{
            ...type.mono,
            color: c.text,
          }}
        >
          {token.text}
        </Text>
      </ScrollView>
    );

  if (token.type === "list")
    return (
      <View style={{ gap: 6 }}>
        {token.items.map((item: Tokens.ListItem, i: number) => (
          <View key={i} style={{ flexDirection: "row", gap: 10 }}>
            <Text style={[styles.body, { color: c.muted }]}>
              {token.ordered ? `${Number(token.start || 1) + i}.` : "•"}
            </Text>
            <View style={{ flex: 1, gap: 6 }}>
              {item.tokens.map((t, n) => (
                <Block key={n} token={t} />
              ))}
            </View>
          </View>
        ))}
      </View>
    );

  if (token.type === "blockquote")
    return (
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: c.accent,
          paddingLeft: 14,
          gap: 8,
        }}
      >
        {token.tokens?.map((t: Token, i: number) => (
          <Block key={i} token={t} />
        ))}
      </View>
    );

  if (token.type === "hr") return <View style={{ height: 1, backgroundColor: c.line }} />;

  if (token.type === "table")
    return (
      <ScrollView horizontal>
        <View style={{ gap: 8 }}>
          <Text selectable style={[styles.body, { color: c.text, fontWeight: "600" }]}>
            {token.header.map((h: Tokens.TableCell) => h.text).join("   |   ")}
          </Text>
          {token.rows.map((row: Tokens.TableCell[], i: number) => (
            <Text selectable key={i} style={[styles.body, { color: c.text }]}>
              {row.map((cell) => cell.text).join("   |   ")}
            </Text>
          ))}
        </View>
      </ScrollView>
    );
  const tokens = "tokens" in token ? token.tokens : undefined;

  return (
    <Text
      selectable
      accessibilityRole={token.type === "heading" ? "header" : undefined}
      style={[
        type.body,
        { color: c.body },
        token.type === "heading"
          ? {
              fontSize: token.depth === 1 ? 18 : 16,
              fontFamily: font.semibold,
              lineHeight: token.depth <= 2 ? 28 : 24,
            }
          : null,
      ]}
    >
      {tokens ? <Inline tokens={tokens} /> : "text" in token ? String(token.text) : token.raw}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);

  return (
    <View style={{ gap: 12 }}>
      {tokens.map((token, i) => (
        <Block key={i} token={token} />
      ))}
    </View>
  );
}
