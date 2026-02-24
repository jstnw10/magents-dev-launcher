const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const packageRoot = path.resolve(__dirname, '../../packages/magents-dev-launcher');
const withDevLauncherPath = path.join(packageRoot, 'plugin/build/withDevLauncher.js');
const pluginConfigPath = path.join(packageRoot, 'plugin/build/pluginConfig.js');
const moduleCache = new Map();

function evaluateCommonJs(filePath) {
  if (moduleCache.has(filePath)) {
    return moduleCache.get(filePath);
  }

  const fileCode = fs.readFileSync(filePath, 'utf8');
  const localModule = { exports: {} };
  const baseRequire = Module.createRequire(filePath);

  const localRequire = (request) => {
    if (request === './pluginConfig') {
      return evaluateCommonJs(pluginConfigPath);
    }
    if (request === '../../package.json') {
      return baseRequire(path.join(packageRoot, 'package.json'));
    }
    return baseRequire(request);
  };

  const wrappedCode = `(function (exports, require, module, __filename, __dirname) {
${fileCode}
})`;

  vm.runInThisContext(wrappedCode, { filename: filePath })(
    localModule.exports,
    localRequire,
    localModule,
    filePath,
    path.dirname(filePath)
  );

  moduleCache.set(filePath, localModule.exports);
  return localModule.exports;
}

const loadedPlugin = evaluateCommonJs(withDevLauncherPath);
module.exports = loadedPlugin.default ?? loadedPlugin;
