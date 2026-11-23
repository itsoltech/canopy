import { ConfigNoticesFor } from "./ConfigNoticesFor";

export function AccountConfigNotices({ sections }: { sections: string[] }) {
  return (
    <ConfigNoticesFor
      match={(notice) =>
        notice.kind === "settings" &&
        sections.some((section) => notice.field === section || notice.field.startsWith(`${section}.`))
      }
    />
  );
}
