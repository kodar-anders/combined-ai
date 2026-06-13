#!/usr/bin/env node

const {existsSync} = require(`fs`);
const {createRequire, register} = require(`module`);
const {resolve} = require(`path`);
const {pathToFileURL} = require(`url`);

const relPnpApiPath = "../../../../.pnp.cjs";

const absPnpApiPath = resolve(__dirname, relPnpApiPath);
const absUserWrapperPath = resolve(__dirname, `./sdk.user.cjs`);
const absRequire = createRequire(absPnpApiPath);

const absPnpLoaderPath = resolve(absPnpApiPath, `../.pnp.loader.mjs`);
const isPnpLoaderEnabled = existsSync(absPnpLoaderPath);

if (existsSync(absPnpApiPath)) {
  if (!process.versions.pnp) {
    // Setup the environment to be able to require eslint/bin/eslint.js
    require(absPnpApiPath).setup();
    if (isPnpLoaderEnabled && register) {
      register(pathToFileURL(absPnpLoaderPath));
    }
  }
}

const wrapWithUserWrapper = existsSync(absUserWrapperPath)
  ? exports => absRequire(absUserWrapperPath)(exports)
  : exports => exports;

// Defer to the real eslint/bin/eslint.js your application uses.
// ESLint 10 dropped `./bin/eslint.js` from its package `exports`, so we resolve
// it via the (exported) package.json location instead of through the exports map.
// NOTE: regenerating SDKs (`yarn dlx @yarnpkg/sdks`) will overwrite this patch
// until @yarnpkg/sdks ships ESLint 10 support.
const eslintBinPath = resolve(absRequire.resolve(`eslint/package.json`), `../bin/eslint.js`);
module.exports = wrapWithUserWrapper(absRequire(eslintBinPath));
