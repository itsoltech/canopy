/** The local gateway uses loopback and the desktop role; its BFF session stays private to main/controller. */
export function localGatewayEnvironment(
  base: NodeJS.ProcessEnv,
  secrets: { secretsKey: string; serviceToken: string },
  options: { databaseUrl: string; port: number; webOrigin: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    CANOPY_DATABASE_URL: options.databaseUrl,
    CANOPY_SECRETS_KEY: secrets.secretsKey,
    CANOPY_UI_SERVICE_TOKEN: secrets.serviceToken,
    CANOPY_GATEWAY_ROLE: "desktop",
    CANOPY_WEB_ORIGIN: options.webOrigin,
    CANOPY_HOST: "127.0.0.1",
    CANOPY_PORT: String(options.port),
  };
}
