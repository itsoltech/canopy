// SDK 58's balanced preset ignores marketing/build numbers, while retaining native app identity.
// Hash the certificate contents too: rotating a key must require a new native runtime.
module.exports = {
  preset: "balanced",
  extraSources: [{ type: "file", filePath: "certs/updates-certificate.pem" }],
};
