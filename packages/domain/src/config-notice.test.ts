import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { configNotice } from "./config-notice.ts";

const notice = (fields: MessageInitShape<typeof ui.ConfigNoticeSchema>) =>
  create(ui.ConfigNoticeSchema, {
    id: "notice",
    nodeName: "Laptop B",
    itemName: "Work",
    reason: "choice",
    ...fields,
  });

describe("configuration notices shared by web and mobile", () => {
  test.each([
    {
      kind: "settings",
      field: "appearance.colorScheme",
      value: '"COLOR_SCHEME_DARK"',
      title: "Color scheme",
      shown: "Dark",
    },
    {
      kind: "instance",
      field: "connection",
      value: '{"kind":"endpoint","proxy":"proxy-id","apiKey":"A different key"}',
      title: "Work: Connects with",
      shown: "Endpoint through a different proxy with a different key",
    },
    {
      kind: "proxy",
      field: "baseUrl",
      value: '"https://proxy.example.com"',
      title: "Work: Base URL",
      shown: "https://proxy.example.com",
    },
    { kind: "connector", field: "authKind", value: '"oauth"', title: "Work: Sign-in method", shown: "oauth" },
    {
      kind: "oauth_app",
      field: "credentials",
      value: "A different key",
      title: "Work: Credentials",
      shown: "A different key",
    },
    {
      kind: "project",
      field: "originAmbiguous.repo",
      value: '"https://example.com/repo.git"',
      title: "Work: Git origin",
      shown: "https://example.com/repo.git",
    },
    {
      kind: "project_settings",
      field: "threadDefaults.models",
      value: '{"codex":"model-id"}',
      title: "Work: Default models",
      shown: "Different options",
    },
    {
      kind: "worktree_policy",
      field: "keepLocalChanges",
      value: "true",
      title: "Work: Keep worktrees with local changes",
      shown: "On",
    },
    {
      kind: "instruction",
      field: "fragments",
      value: '[{"hash":"content-hash"}]',
      title: "Work: Fragments",
      shown: "Different fragments",
    },
    { kind: "skill", field: "selected", value: '"version-hash"', title: "Work: Version", shown: "A different version" },
    {
      kind: "marketplace",
      field: "catalog",
      value: '{"hash":"catalog-hash"}',
      title: "Work: Catalog",
      shown: "A different catalog",
    },
    {
      kind: "plugin",
      field: "source",
      value: '{"marketplace":"marketplace-id"}',
      title: "Work: Source",
      shown: "A different source",
    },
  ])("formats $kind without serialized values or internal references", ({ kind, field, value, title, shown }) => {
    expect(configNotice(notice({ kind, field, value }), "14:02")).toEqual({
      title,
      message: "Laptop B has a different value. Choose which to keep.",
      value: shown,
      restore: "Use the other’s",
      dismiss: "Keep this computer’s",
    });
  });

  test.each(["concurrent", "merged"])("identifies whose %s value Restore applies", (reason) => {
    const fields = { kind: "instance", field: "connection", value: '{"kind":"native"}', reason };

    expect(configNotice(notice({ ...fields, ownValue: true }), "14:02")).toEqual({
      title: "Work: Connects with",
      message:
        reason === "merged"
          ? "Replaced when this computer linked with Laptop B."
          : "Laptop B also changed this at 14:02.",
      value: "This computer’s value: Device login",
      restore: "Restore this computer’s",
      dismiss: "Keep current",
    });
    expect(configNotice(notice(fields), "14:02")).toMatchObject({
      message:
        reason === "merged"
          ? "Not used when this computer linked with Laptop B."
          : "Laptop B also changed this at 14:02.",
      value: "Other value: Device login",
      restore: "Use the other’s",
      dismiss: "Keep current",
    });
  });

  test.each([
    "instance",
    "proxy",
    "connector",
    "oauth_app",
    "project",
    "project_settings",
    "worktree_policy",
    "instruction",
    "skill",
    "marketplace",
    "plugin",
  ])("shows a single deleted %s item with context-specific actions", (kind) => {
    const removed = notice({ kind, field: "deleted", reason: "deleted", value: '"Old name"' });

    expect(configNotice(removed, "14:02")).toEqual({
      title: "Work",
      message: "Deleted on Laptop B at 14:02.",
      value: "",
      restore: "Restore",
      dismiss: "Dismiss",
    });
    expect(configNotice(removed, "14:02", { library: true })).toMatchObject({
      restore: "Keep",
      dismiss: "Accept deletion",
    });
  });

  test("distinguishes resurrection from deletion and labels unnamed fields", () => {
    expect(
      configNotice(notice({ kind: "skill", field: "deleted", reason: "resurrected", value: "false" }), "14:02"),
    ).toEqual({
      title: "Work: Deleted",
      message: "Laptop B changed it after it was deleted here.",
      value: "Off",
      restore: "Delete",
      dismiss: "Dismiss",
    });
    expect(
      configNotice(notice({ kind: "instance", field: "env.REGION", value: '{"value":"eu"}' }), "14:02", {
        named: false,
      }),
    ).toMatchObject({
      title: "Variable REGION",
      value: "eu",
    });
  });

  test.each([
    {
      field: "connection",
      value: '{"kind":"endpoint","baseUrl":"https://api.example.com"}',
      shown: "Endpoint at https://api.example.com",
    },
    { field: "proxy", value: '"internal-id"', shown: "A different proxy" },
    { field: "proxy", value: "null", shown: "No proxy" },
    { field: "accountIdentity", value: '{"id":"account-id"}', shown: "A different account" },
    { field: "apiKey", value: "A different key", shown: "A different key" },
    { field: "favorites", value: '["model-a","model-b"]', shown: "A different list" },
    { field: "codex", value: '{"sandbox":"workspace-write"}', shown: "Different options" },
    { field: "label", value: '""', shown: "Default" },
    { field: "label", value: "null", shown: "Not set" },
  ])("formats $field as readable text", ({ field, value, shown }) => {
    expect(configNotice(notice({ kind: "instance", field, value }), "14:02").value).toBe(shown);
  });
});
