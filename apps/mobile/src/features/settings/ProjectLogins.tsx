import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ProjectLoginForm } from "./ProjectLoginForm";
import { confirmAction } from "./resource";

type Open = { mode: "add" } | { mode: "edit"; login: ui.ProjectSecret };

/** Project details → Logins: test accounts agents sign in with in Agent Browser (docs/secrets.md). */
export function ProjectLogins({
  projectId,
  logins,
  names,
  busy,
  loaded,
  onDelete,
  reload,
}: {
  projectId: string;
  logins: readonly ui.ProjectSecret[];
  names: readonly string[];
  busy: boolean;
  loaded: boolean;
  /** Deletes the login; true once the gateway confirmed it. */
  onDelete: (name: string) => Promise<boolean>;
  reload: () => Promise<void>;
}) {
  const { active } = useSession();
  const [open, setOpen] = useState<Open>();
  const [saving, setSaving] = useState(false);
  const close = () => !saving && setOpen(undefined);

  const remove = (name: string) =>
    confirmAction(
      "Delete login",
      `This deletes “${name}” from this project. Canopy revokes it in threads that use it. Pages where an agent already signed in stay signed in.`,
      () =>
        void onDelete(name).then((deleted) => {
          if (deleted) setOpen(undefined);
        }),
    );

  return (
    <>
      <SettingsGroup
        title="Logins"
        description="Agents sign in with these in Agent Browser without seeing the password."
        actions={
          <Button
            title="Add login"
            size="sm"
            icon="plus"
            disabled={!loaded || busy}
            onPress={() => setOpen({ mode: "add" })}
          />
        }
      >
        {logins.map((login) => (
          <SettingsRow
            key={login.name}
            title={login.name}
            description={summary(login)}
            onPress={() => setOpen({ mode: "edit", login })}
          />
        ))}
        {loaded && !logins.length && (
          <SettingsRow title="No logins yet" description="Add a test account so agents can sign in to your app." />
        )}
      </SettingsGroup>
      <Sheet title={open?.mode === "edit" ? open.login.name : "Add login"} visible={!!open && active} onClose={close}>
        {open && active && (
          <View style={{ gap: 16 }}>
            <ProjectLoginForm
              key={open.mode === "edit" ? open.login.name : "add"}
              projectId={projectId}
              {...(open.mode === "edit" && { login: open.login })}
              taken={names}
              onBusy={setSaving}
              onSaved={() => {
                setOpen(undefined);
                void reload();
              }}
            />
            {open.mode === "edit" && (
              <Button
                title="Delete login…"
                variant="danger"
                disabled={saving || busy}
                onPress={() => remove(open.login.name)}
              />
            )}
          </View>
        )}
      </Sheet>
    </>
  );
}

function summary(secret: ui.ProjectSecret): string {
  const login = secret.login;

  return [
    login?.username && `${login.username}${login.showUsername ? "" : " (hidden from agents)"}`,
    (login?.websites ?? []).map((website) => website.replace(/^https:\/\//, "")).join(", "),
    login?.askEachTime ? "Ask each time" : "Automatic",
    login?.oneTimeCode && "One-time code",
  ]
    .filter(Boolean)
    .join(" · ");
}
