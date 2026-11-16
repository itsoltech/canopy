import { useState } from "react";
import { Text, View } from "react-native";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, type AgentPreviewInput } from "@canopy/contracts";
import { Button, IconButton } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";

type Send = (kind: string, values?: MessageInitShape<typeof AgentPreviewInputSchema>) => void;

export function PreviewControls({
  tool,
  url,
  enabled,
  input,
}: {
  tool: AgentTool;
  url: string;
  enabled: boolean;
  input: (value: AgentPreviewInput) => void;
}) {
  const send: Send = (kind, values = {}) => input(create(AgentPreviewInputSchema, { kind, ...values }));

  const key = (value: string) => {
    send("key-down", { key: value, code: value });
    send("key-up", { key: value, code: value });
  };

  return (
    <View style={{ gap: 8 }}>
      {tool === AgentTool.BROWSER && <BrowserControls url={url} enabled={enabled} send={send} />}
      <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
        <IconButton
          icon="arrow-up"
          label="Scroll up"
          disabled={!enabled}
          onPress={() => send("wheel", { x: 0.5, y: 0.5, deltaY: -400 })}
        />
        <IconButton
          icon="arrow-down"
          label="Scroll down"
          disabled={!enabled}
          onPress={() => send("wheel", { x: 0.5, y: 0.5, deltaY: 400 })}
        />
        <Button title="Enter" size="sm" disabled={!enabled} onPress={() => key("Enter")} />
        <Button
          title={tool === AgentTool.DEVICE ? "Back" : "Escape"}
          size="sm"
          disabled={!enabled}
          onPress={() => {
            if (tool === AgentTool.DEVICE) send("back");
            else key("Escape");
          }}
        />
        {tool === AgentTool.DEVICE && (
          <Button title="Home" size="sm" disabled={!enabled} onPress={() => send("home")} />
        )}
      </View>
      <PreviewText enabled={enabled} send={send} />
    </View>
  );
}

function BrowserControls({ url, enabled, send }: { url: string; enabled: boolean; send: Send }) {
  const [draft, setDraft] = useState<{ url: string; value: string }>();
  const address = draft?.url === url ? draft.value : url;
  const [error, setError] = useState("");
  const c = useColors();

  const navigate = () => {
    if (!address.trim()) return;

    try {
      const value = address.trim();
      const relative = /^[/.?#]/.test(value);
      const local = /^(localhost|127\.|0\.|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/.test(value);
      const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value === "about:blank";

      const destination = new URL(
        relative ? value : explicit ? value : `${local ? "http" : "https"}://${value}`,
        relative ? url : undefined,
      );

      if (!["http:", "https:"].includes(destination.protocol) && destination.href !== "about:blank") throw new Error();
      setError("");
      send("navigate", { text: destination.href });
    } catch {
      setError("Enter a valid page address, then choose Go.");
    }
  };

  return (
    <>
      <View style={[styles.row, { gap: 8 }]}>
        <IconButton icon="arrow-left" label="Back" disabled={!enabled} onPress={() => send("back")} />
        <IconButton icon="chevron-right" label="Forward" disabled={!enabled} onPress={() => send("forward")} />
        <IconButton icon="arrow-path" label="Reload page" disabled={!enabled} onPress={() => send("reload")} />
      </View>
      <View style={[styles.row, { gap: 8 }]}>
        <TextInput
          accessibilityLabel="Page address"
          value={address}
          onChangeText={(value) => {
            setDraft({ url, value });
            setError("");
          }}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={navigate}
          editable={enabled}
          placeholder="https://example.com"
          placeholderTextColor={c.muted}
          style={[styles.input, { flex: 1, minWidth: 0, color: c.text, borderColor: c.line }]}
        />
        <Button title="Go" disabled={!enabled || !address.trim()} onPress={navigate} />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
          {error}
        </Text>
      ) : null}
    </>
  );
}

function PreviewText({ enabled, send }: { enabled: boolean; send: Send }) {
  const [text, setText] = useState("");
  const c = useColors();

  function type() {
    if (!text) return;
    send("text", { text });
    setText("");
  }

  return (
    <View style={[styles.row, { gap: 8 }]}>
      <TextInput
        accessibilityLabel="Text to type"
        value={text}
        onChangeText={setText}
        editable={enabled}
        placeholder="Text to type"
        placeholderTextColor={c.muted}
        returnKeyType="send"
        onSubmitEditing={type}
        style={[styles.input, { flex: 1, minWidth: 0, color: c.text, borderColor: c.line }]}
      />
      <Button title="Type text" disabled={!enabled || !text} onPress={type} />
    </View>
  );
}
