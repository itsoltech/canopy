import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { metadataComparison, metadataField, type MetadataKind } from "@canopy/domain/github-metadata";
import { Button, Field, Notice } from "../../ui/components";
import { MarkdownEditor } from "../../ui/MarkdownEditor";
import { useColors, useTypography } from "../../ui/theme";
import type { useMetadataEditor } from "./useMetadataEditor";
import { MetadataChoices } from "./MetadataChoices";
import { OpenMutationSource } from "./OpenMutationSource";

type Form = ReturnType<typeof useMetadataEditor>;

export function MetadataForm({
  snapshot,
  kind,
  form: { editor, state: f, blocked, online },
  onCancel,
  onApply,
}: {
  snapshot: github.PullRequestSnapshot;
  kind: MetadataKind;
  form: Form;
  onCancel: () => void;
  onApply: () => void;
}) {
  const field = metadataField(kind);

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      {!!f.current && (
        <>
          {field === "details" ? (
            kind === "title" ? (
              <Field
                label="Pull request title"
                value={f.title}
                onChangeText={(title) => editor?.patch({ title })}
                maxLength={256}
                editable={!blocked}
              />
            ) : (
              <MarkdownEditor
                label="Pull request description"
                value={f.body}
                onChange={(body) => editor?.patch({ body })}
                disabled={blocked}
              />
            )
          ) : (
            <>
              {kind === "reviewers" && (
                <>
                  <Notice>
                    Checked reviewers receive a request. Uncheck to remove a request. Apply notifies new reviewers.
                  </Notice>
                </>
              )}
              <MetadataChoices
                kind={kind}
                snapshot={snapshot}
                options={f.options}
                ids={f.ids}
                disabled={blocked}
                onToggle={(id) => editor?.toggle(id)}
              />
              {!!f.next && (
                <Button title="Load more choices" size="sm" busy={f.busy} onPress={() => void editor?.more()} />
              )}
            </>
          )}
          {!f.current.actions.includes(field) && (
            <Notice>This account cannot edit this field. Check repository access.</Notice>
          )}
        </>
      )}
      {!!f.conflict && <MetadataConflict kind={kind} form={{ editor, state: f, blocked, online }} />}
      {!!f.detail && !f.conflict && <Notice>{f.detail}</Notice>}
      {f.receipt && ["uncertain", "in_flight"].includes(f.receipt.state) && (
        <>
          <OpenMutationSource snapshot={snapshot} />
          <Button
            title="Check current state"
            size="sm"
            disabled={f.busy || !online}
            onPress={() => void editor?.load(true)}
          />
        </>
      )}
      {!f.current && !f.busy && <Button title="Retry" size="sm" onPress={() => void editor?.load()} />}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button title="Cancel" size="sm" variant="ghost" disabled={f.busy} onPress={onCancel} />
        <Button
          title="Apply"
          size="sm"
          variant="primary"
          busy={f.busy}
          disabled={blocked || !f.current?.actions.includes(field) || (kind === "title" && !f.title.trim())}
          onPress={onApply}
        />
      </View>
    </View>
  );
}

function MetadataConflict({ kind, form: { editor, state: f } }: { kind: MetadataKind; form: Form }) {
  const c = useColors(),
    type = useTypography();

  const comparison = metadataComparison(f, kind);

  return (
    <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 8 }}>
      <Notice>These fields changed on GitHub. Compare changes before editing again.</Notice>
      <Text style={[type.small, { color: c.muted }]}>Your draft</Text>
      <Text selectable style={[type.small, { color: c.text }]}>
        {comparison.draft.map((line, i) => (
          <Text key={i} style={{ backgroundColor: line.changed ? c.inset : "transparent" }}>
            {line.changed ? "− " : "  "}
            {line.text}
            {"\n"}
          </Text>
        ))}
      </Text>
      <Text style={[type.small, { color: c.muted }]}>On GitHub</Text>
      <Text selectable style={[type.small, { color: c.text }]}>
        {comparison.current.map((line, i) => (
          <Text key={i} style={{ backgroundColor: line.changed ? c.inset : "transparent" }}>
            {line.changed ? "+ " : "  "}
            {line.text}
            {"\n"}
          </Text>
        ))}
      </Text>
      <Button title="Refresh fields" size="sm" disabled={f.busy} onPress={() => void editor?.load(true)} />
    </View>
  );
}
