const { getDefaultConfig } = require('expo/metro-config');

// Expo configures Bun workspaces and TS package exports, including contracts, automatically.
module.exports = getDefaultConfig(__dirname);
