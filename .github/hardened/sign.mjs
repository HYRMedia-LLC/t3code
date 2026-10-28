// Usage: node sign.mjs <osx-sign module dir> <app path>
const [moduleDir, app] = process.argv.slice(2);
const { sign } = await import(`${moduleDir}/dist/index.js`);
await sign({
  app,
  identity: "Developer ID Application: HYRMedia, LLC (LHNAU624T4)",
  platform: "darwin",
  optionsForFile: () => ({
    hardenedRuntime: true,
    entitlements: new URL("./entitlements.plist", import.meta.url).pathname,
  }),
  batchCodesignCalls: true,
});
