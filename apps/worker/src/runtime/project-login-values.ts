import type { ProjectLoginValue } from "@canopy/domain/project-logins";
import { z } from "zod";

const LoginValue = z.object({
  name: z.string(),
  username: z.string(),
  password: z.string().min(1),
  one_time_code_setup: z.string().optional(),
  websites: z.array(z.string()).min(1),
  hide_username: z.boolean(),
});

export function parseLoginValue(value: string): ProjectLoginValue | undefined {
  try {
    const parsed = LoginValue.safeParse(JSON.parse(value));

    if (!parsed.success) return;
    const { one_time_code_setup: setup, ...login } = parsed.data;

    return { ...login, ...(setup && { one_time_code_setup: setup }) };
  } catch {
    return undefined;
  }
}

/** The value inside a JSON string, as JSON encoders write it: plain, with `\/`, or with only ASCII. */
function jsonVariants(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);

  const ascii = escaped.replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  return [escaped, escaped.replaceAll("/", "\\/"), ascii, ascii.replaceAll("/", "\\/")];
}

/** Common encodings a page script or a request may use for an entered value. */
export function encodedVariants(value: string): string[] {
  const variants = [
    value,
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    ...jsonVariants(value),
  ];

  try {
    variants.push(new URLSearchParams({ v: value }).toString().slice(2));
  } catch {
    // Every string encodes; the guard keeps the list total.
  }

  return [...new Set(variants.filter(Boolean))];
}

/** Values masked in tool output and journals while a login is in use: never the visible username. */
export function loginSecretValues(login: ProjectLoginValue): string[] {
  const values = [login.password, ...encodedVariants(login.password)];

  if (login.hide_username && login.username) values.push(...encodedVariants(login.username));

  if (login.username) values.push(Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64"));

  if (login.one_time_code_setup) {
    values.push(login.one_time_code_setup);
    const secret = URL.parse(login.one_time_code_setup)?.searchParams.get("secret");

    if (secret) values.push(secret);
  }

  return [...new Set(values)];
}

export function loginRedactionValues(value: string): string[] {
  const login = parseLoginValue(value);

  return login ? loginSecretValues(login) : [];
}
