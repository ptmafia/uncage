// Metro in the pnpm monorepo (https://docs.expo.dev/guides/monorepos/). Expo's default config
// already watches the workspace root and follows pnpm's symlinks; this adds two things:
// - the app's and the root's node_modules as lookup paths (packages linked from ../../packages);
// - one copy of React: @uncage/react resolves `react` from its own devDependencies, which may be
//   a different version than the app's (React Native needs exactly its renderer's version), so
//   `react`, `react-dom` and `react-native` always resolve from this app.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')];

const SINGLETONS = ['react', 'react-dom', 'react-native'];
const appOrigin = path.join(projectRoot, 'package.json');
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  const single = SINGLETONS.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
  return resolve(single ? { ...context, originModulePath: appOrigin } : context, moduleName, platform);
};

module.exports = config;
