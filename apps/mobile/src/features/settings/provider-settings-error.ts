import { Code, ConnectError } from "@connectrpc/connect";

const validationMessages = new Set([
  "CLI settings are too long. Use up to 16 KiB.",
  "CLI settings contain invalid text. Remove invalid characters and try again.",
  "Could not read settings.json. Check the JSON syntax and try again.",
  "Could not read config.toml. Check the TOML syntax and try again.",
  "Could not use settings.json. Check the supported keys and value formats.",
  "Could not use config.toml. Check the supported keys and value formats.",
]);

export function providerSettingsError(cause: unknown): string | undefined {
  if (!(cause instanceof ConnectError)) return undefined;
  const { code, rawMessage } = cause;

  if (code === Code.InvalidArgument && validationMessages.has(rawMessage)) return rawMessage;

  if (code === Code.FailedPrecondition && rawMessage === "Update the worker's home computer to edit its CLI settings.")
    return rawMessage;

  return undefined;
}
