import { Text, View } from "react-native";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { useCreateForm, type CreateForm, type CreateProps } from "./useCreateForm";

export function CreatePullRequest(props: CreateProps) {
  const f = useCreateForm(props),
    c = useColors(),
    type = useTypography();

  return (
    <Sheet
      title="Create pull request"
      visible={props.visible}
      onClose={() => {
        if (!f.busy) props.onClose();
      }}
    >
      <View style={{ gap: 12 }}>
        <CreateTarget form={f} />
        <Button
          title="Refresh branch"
          variant="ghost"
          disabled={f.busy || f.uncertain || !f.online}
          onPress={() => void f.load()}
        />
        <Button title="Draft with agent" disabled={f.blocked} onPress={() => void f.agentDraft()} />
        <Field
          label="Pull request title"
          value={f.title}
          onChangeText={f.setTitle}
          editable={!f.busy && !f.uncertain}
        />
        <Button
          title={f.preview ? "Write" : "Preview"}
          size="sm"
          variant="ghost"
          onPress={() => f.setPreview(!f.preview)}
        />
        {f.preview ? (
          <Markdown text={f.body || "Nothing to preview"} />
        ) : (
          <Field
            label="Pull request description"
            value={f.body}
            multiline
            style={{ minHeight: 140 }}
            onChangeText={f.setBody}
            editable={!f.busy && !f.uncertain}
          />
        )}
        <Field
          label="Agent draft JSON"
          value={f.imported}
          multiline
          onChangeText={f.setImported}
          editable={!f.busy && !f.uncertain}
        />
        <Button title="Use draft" disabled={!f.imported || f.busy || f.uncertain} onPress={f.useDraft} />
        <Text style={[type.meta, { color: c.muted }]}>
          Only the title and description are imported. Review them before creating.
        </Text>
        <Checkbox label="Create as draft" checked={f.draft} onChange={f.setDraft} disabled={f.busy || f.uncertain} />
        {f.context && f.context.headRepositoryName !== f.context.repositoryName && (
          <Checkbox
            label="Allow maintainers to modify this branch"
            checked={f.consent}
            onChange={f.setConsent}
            disabled={f.busy || f.uncertain}
          />
        )}
        {f.prepared && (
          <Notice>
            Create as {f.context?.viewerLogin} · {f.context?.repositoryName} · {f.context?.baseRef} ←{" "}
            {f.context?.headRef} · {f.prepared.headSha.slice(0, 7)}. Confirm within 60 seconds.
          </Notice>
        )}
        {!!(f.error || f.receipt?.detail) && <Notice error>{f.error || f.receipt?.detail}</Notice>}
        {f.uncertain && (
          <Button
            title="Check created pull request"
            disabled={f.busy || !f.online}
            onPress={() => void f.reconcile()}
          />
        )}
        {!!f.receipt?.existingPullRequest && (
          <Button
            title={`Link existing pull request #${f.receipt.existingPullRequest.number}`}
            disabled={f.busy || !f.online}
            onPress={() => void f.linkExisting()}
          />
        )}
        <Button
          title={f.prepared ? "Create pull request" : "Review pull request"}
          variant="primary"
          disabled={f.blocked || !f.title.trim()}
          onPress={() => void f.submit()}
        />
      </View>
    </Sheet>
  );
}

function CreateTarget({ form: f }: { form: CreateForm }) {
  const context = f.context,
    c = useColors(),
    type = useTypography();

  const options =
    f.picker === "account"
      ? (f.selection?.candidates.map((a) => ({ value: a.id, label: a.login })) ?? [])
      : (f.picker === "base"
          ? [...new Set([context?.baseRef ?? "", ...(context?.branches ?? [])])].filter(Boolean)
          : (context?.repositories ?? [])
        ).map((value) => ({ value, label: value }));

  if (!context) return null;

  return (
    <>
      <Text style={[type.meta, { color: c.muted }]}>
        {context.viewerLogin} · {context.headRepositoryName}:{context.headRef} · {context.headSha.slice(0, 7)}
      </Text>
      <SelectField
        label="Base repository"
        value={context.repositoryName}
        disabled={f.busy || f.uncertain}
        onPress={() => f.setPicker("repository")}
      />
      <SelectField
        label="GitHub account"
        value={context.viewerLogin || "Choose account"}
        disabled={f.busy || f.uncertain}
        onPress={() => f.setPicker("account")}
      />
      {!!context.accountId && (
        <SelectField
          label="Base branch"
          value={context.baseRef}
          disabled={f.busy || f.uncertain}
          onPress={() => f.setPicker("base")}
        />
      )}
      {!!context.nextCursor && (
        <Button title="Load more branches" disabled={f.busy || f.uncertain} onPress={() => void f.more()} />
      )}
      {!!context.detail && <Notice>{context.detail}</Notice>}
      <PickerSheet
        title={f.picker === "account" ? "GitHub account" : f.picker === "base" ? "Base branch" : "Base repository"}
        visible={!!f.picker}
        onClose={() => f.setPicker("")}
        search="Find…"
        sections={[{ options }]}
        onSelect={(value) => void f.choose(value)}
      />
    </>
  );
}
