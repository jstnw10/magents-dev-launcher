import withDevLauncherModule from './plugin/build/withDevLauncher.js';

// Keep the plugin boundary explicit: package entry is ESM, plugin build output is CJS.
const withDevLauncher = withDevLauncherModule?.default ?? withDevLauncherModule;

export default withDevLauncher;
