import { validate, type JSONSchema } from '@expo/schema-utils';

/**
 * Type representing base dev launcher configuration.
 */
export type PluginConfigType = PluginConfigOptionsByPlatform & PluginConfigOptions;

/**
 * Type representing available configuration for each platform.
 */
export type PluginConfigOptionsByPlatform = {
  /**
   * Type representing available configuration for Android dev launcher.
   * @platform android
   */
  android?: PluginConfigOptions;
  /**
   * Type representing available configuration for iOS dev launcher.
   * @platform ios
   */
  ios?: PluginConfigOptions;
};

/**
 * Type representing available configuration for dev launcher.
 */
export type PluginConfigOptions = {
  /**
   * Determines whether to launch the most recently opened project or navigate to the launcher screen.
   *
   * - `'most-recent'` - Attempt to launch directly into a previously opened project and if unable to connect,
   * fall back to the launcher screen.
   *
   * - `'launcher'` - Opens the launcher screen.
   *
   * @default 'most-recent'
   */
  launchMode?: 'most-recent' | 'launcher';
  /**
   * @deprecated use the `launchMode` property instead
   */
  launchModeExperimental?: 'most-recent' | 'launcher';
  /**
   * The Convex deployment URL. When set, the plugin will:
   * 1. Add the `convex-swift` SPM package (product: ConvexMobile) to the Xcode project's main target
   * 2. Inject `ConvexDeploymentUrl` into Info.plist
   *
   * @example 'https://your-deployment.convex.cloud'
   */
  convexUrl?: string;
};

const schema: JSONSchema<PluginConfigType> = {
  title: 'expo-dev-launcher',
  type: 'object',
  properties: {
    launchMode: {
      type: 'string',
      enum: ['most-recent', 'launcher'],
      nullable: true,
    },
    launchModeExperimental: {
      type: 'string',
      enum: ['most-recent', 'launcher'],
      nullable: true,
    },
    convexUrl: {
      type: 'string',
      nullable: true,
    },
    android: {
      type: 'object',
      properties: {
        launchMode: {
          type: 'string',
          enum: ['most-recent', 'launcher'],
          nullable: true,
        },
        launchModeExperimental: {
          type: 'string',
          enum: ['most-recent', 'launcher'],
          nullable: true,
        },
      },
      nullable: true,
    },
    ios: {
      type: 'object',
      properties: {
        launchMode: {
          type: 'string',
          enum: ['most-recent', 'launcher'],
          nullable: true,
        },
        launchModeExperimental: {
          type: 'string',
          enum: ['most-recent', 'launcher'],
          nullable: true,
        },
      },
      nullable: true,
    },
  },
};

/**
 * @ignore
 */
export function validateConfig<T>(config: T): PluginConfigType {
  validate(schema, config);

  if (
    config.launchModeExperimental ||
    config.ios?.launchModeExperimental ||
    config.android?.launchModeExperimental
  ) {
    warnOnce(
      'The `launchModeExperimental` property of expo-dev-launcher config plugin is deprecated and will be removed in a future SDK release. Use `launchMode` instead.'
    );
  }

  return config;
}

const warnMap: Record<string, boolean> = {};
function warnOnce(message: string) {
  if (!warnMap[message]) {
    warnMap[message] = true;
    console.warn(message);
  }
}
