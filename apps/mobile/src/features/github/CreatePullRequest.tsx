import { Text, View } from "react-native";
import { Button, Field, Notice, Sheet, IconButton } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { PickerSheet } from "../../ui/Picker";
import { MarkdownEditor } from "../../ui/MarkdownEditor";
import { useColors, useTypography } from "../../ui/theme";
import { useCreateForm, type CreateForm, type CreateProps } from "./useCreateForm";
import { RepositoryAccessActions } from "./RepositoryAccessActions";

export function CreatePullRequest(props: CreateProps) {
  const f = useCreateForm(props);

  return (
    <Sheet
      title="Create pull request"
      visible={props.visible}
      onClose={() => {
        if (!f.busy) props.onClose();
      }}
      footer={
        <>
          <Checkbox label="Create as draft" checked={f.draft} onChange={f.setDraft} disabled={f.busy || f.uncertain} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button title="Cancel" variant="ghost" disabled={f.busy} onPress={props.onClose} />
            <Button
              title={f.prepared ? "Create pull request" : "Review pull request"}
              variant="primary"
              busy={f.busy && !f.drafting}
              disabled={f.blocked || !f.title.trim()}
              onPress={() => void f.submit()}
            />
          </View>
        </>
      }
    >
      <View style={{ gap: 12 }}>
        <CreateTarget form={f} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Button
            title={f.drafting ? "Drafting…" : "Draft with agent"}
            busy={f.drafting}
            disabled={f.blocked}
            onPress={() => void f.agentDraft()}
          />
          <IconButton
            icon="arrow-path"
            label="Refresh branch"
            disabled={f.busy || f.uncertain || !f.online}
            onPress={() => void f.load()}
          />
        </View>
        <Field
          label="Pull request title"
          value={f.title}
          onChangeText={f.setTitle}
          editable={!f.busy && !f.uncertain}
        />
        <MarkdownEditor
          label="Pull request description"
          value={f.body}
          onChange={f.setBody}
          placeholder="Describe the changes in Markdown…"
          disabled={f.busy || f.uncertain}
        />
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
        {context.repositories.length > 1 ? (
          <Button
            title={context.repositoryName}
            size="sm"
            variant="ghost"
            disabled={f.busy || f.uncertain}
            onPress={() => f.setPicker("repository")}
          />
        ) : (
          <Text numberOfLines={1} style={[type.meta, { color: c.muted, flexShrink: 1 }]}>
            {context.repositoryName}
          </Text>
        )}
        <Text
          numberOfLines={1}
          accessibilityLabel={`${context.headRepositoryName}:${context.headRef}`}
          style={[type.meta, { color: c.muted, flexShrink: 1 }]}
        >
          {context.headRef} →
        </Text>
        {context.accountId && context.baseRef ? (
          <Button
            title={`${context.baseRef} ⌄`}
            label="Base branch"
            size="sm"
            variant="ghost"
            disabled={f.busy || f.uncertain}
            onPress={() => f.setPicker("base")}
          />
        ) : (
          <Text style={[type.meta, { color: c.muted }]}>Base unavailable</Text>
        )}
        {(f.selection?.candidates.length ?? 0) > 1 && (
          <Button
            title={context.viewerLogin}
            label="GitHub account"
            size="sm"
            variant="ghost"
            disabled={f.busy || f.uncertain}
            onPress={() => f.setPicker("account")}
          />
        )}
      </View>
      {!!context.nextCursor && (
        <Button title="Load more branches" disabled={f.busy || f.uncertain} onPress={() => void f.more()} />
      )}
      {!!context.detail && <Notice>{context.detail}</Notice>}
      {!context.accountId && <RepositoryAccessActions homeId={f.homeId} onconnected={() => void f.load()} />}
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
