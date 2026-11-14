import { Text, View } from "react-native";
import { SensitiveUrl } from "../../ui/Sensitive";
import { font, styles, useColors } from "../../ui/theme";

/** How each harness uses a proxy (web: ProxyMappings); the proxy host stays masked until tapped. */
export function ProxyMappings({ kind, baseUrl }: { kind: string; baseUrl: string }) {
  const c = useColors();
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "") || "<proxy>";
  const text = [styles.chrome, { color: c.muted }];

  const rows = [
    {
      name: "Claude",
      off: kind === "openai" ? "Not applicable: Claude requires the Anthropic Messages API." : "",
      before: "ANTHROPIC_BASE_URL=",
      url: root,
      after: "; secret in ANTHROPIC_AUTH_TOKEN; ANTHROPIC_API_KEY empty.",
    },
    {
      name: "Codex",
      off: kind === "anthropic" ? "Not applicable: Codex requires the OpenAI Responses API." : "",
      before: "",
      url: `${root}/v1`,
      after: " · Responses · isolated CODEX_HOME · key through env_key.",
    },
    {
      name: "Grok",
      off: kind === "anthropic" ? "Not applicable: this preset maps Grok to OpenAI Chat Completions." : "",
      before: "",
      url: `${root}/v1`,
      after: " · custom model · Chat Completions · isolated GROK_HOME.",
    },
  ];

  return (
    <View style={{ gap: 10 }}>
      {rows.map((row) => (
        <View key={row.name} style={{ gap: 2 }}>
          <Text style={[styles.chrome, { fontFamily: font.medium, color: c.text }]}>{row.name}</Text>
          {row.off ? (
            <Text style={text}>{row.off}</Text>
          ) : (
            <Text style={text}>
              {row.before}
              <SensitiveUrl value={row.url} />
              {row.after}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}
