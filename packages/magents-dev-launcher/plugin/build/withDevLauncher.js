"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("expo/config-plugins");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pluginConfig_1 = require("./pluginConfig");
const pkg = require('../../package.json');
/**
 * Adds an SPM dependency on ConvexMobile (from convex-swift) to the main app target.
 * This replaces the previous CocoaPods-based approach with Swift Package Manager.
 */
const withConvexSPM = (config) => {
    return (0, config_plugins_1.withXcodeProject)(config, (config) => {
        const project = config.modResults;
        const targetName = config.modRequest.projectName;
        const REPO_URL = 'https://github.com/get-convex/convex-swift';
        const REPO_NAME = 'convex-swift';
        const PRODUCT_NAME = 'ConvexMobile';
        const MIN_VERSION = '0.8.1';
        // --- Step 1: XCRemoteSwiftPackageReference ---
        if (!project.hash.project.objects['XCRemoteSwiftPackageReference']) {
            project.hash.project.objects['XCRemoteSwiftPackageReference'] = {};
        }
        const packageReferenceUUID = project.generateUuid();
        const packageRefKey = `${packageReferenceUUID} /* XCRemoteSwiftPackageReference "${REPO_NAME}" */`;
        project.hash.project.objects['XCRemoteSwiftPackageReference'][packageRefKey] = {
            isa: 'XCRemoteSwiftPackageReference',
            repositoryURL: REPO_URL,
            requirement: {
                kind: 'upToNextMajorVersion',
                minimumVersion: MIN_VERSION,
            },
        };
        // --- Step 2: XCSwiftPackageProductDependency ---
        if (!project.hash.project.objects['XCSwiftPackageProductDependency']) {
            project.hash.project.objects['XCSwiftPackageProductDependency'] = {};
        }
        const packageUUID = project.generateUuid();
        const productKey = `${packageUUID} /* ${PRODUCT_NAME} */`;
        project.hash.project.objects['XCSwiftPackageProductDependency'][productKey] = {
            isa: 'XCSwiftPackageProductDependency',
            package: packageRefKey,
            productName: PRODUCT_NAME,
        };
        // --- Step 3: Add packageReferences to PBXProject ---
        const projectId = Object.keys(project.hash.project.objects['PBXProject']).find((key) => !key.endsWith('_comment'));
        if (projectId) {
            if (!project.hash.project.objects['PBXProject'][projectId]['packageReferences']) {
                project.hash.project.objects['PBXProject'][projectId]['packageReferences'] = [];
            }
            project.hash.project.objects['PBXProject'][projectId]['packageReferences'].push(packageRefKey);
        }
        // --- Step 4: Add PBXBuildFile entry ---
        const frameworkUUID = project.generateUuid();
        const frameworkCommentKey = `${frameworkUUID}_comment`;
        project.hash.project.objects['PBXBuildFile'][frameworkCommentKey] =
            `${PRODUCT_NAME} in Frameworks`;
        project.hash.project.objects['PBXBuildFile'][frameworkUUID] = {
            isa: 'PBXBuildFile',
            productRef: packageUUID,
            productRef_comment: PRODUCT_NAME,
        };
        // --- Step 5: Add to PBXFrameworksBuildPhase for the main app target ---
        const nativeTargetId = project.findTargetKey(targetName ?? '');
        if (nativeTargetId) {
            const frameworksBuildPhase = project.pbxFrameworksBuildPhaseObj(nativeTargetId);
            if (frameworksBuildPhase) {
                frameworksBuildPhase.files.push({
                    value: frameworkUUID,
                    comment: `${PRODUCT_NAME} in Frameworks`,
                });
            }
        }
        // --- Step 6: Add packageProductDependencies to the native target ---
        if (nativeTargetId) {
            const nativeTarget = project.pbxNativeTargetSection()[nativeTargetId];
            if (nativeTarget) {
                if (!nativeTarget.packageProductDependencies) {
                    nativeTarget.packageProductDependencies = [];
                }
                nativeTarget.packageProductDependencies.push(productKey);
            }
        }
        return config;
    });
};
/**
 * Adds the generated ConvexMagentsProvider.swift to the Xcode project's compile sources.
 * Without this, the file exists on disk but is never compiled.
 */
const withConvexBridgeXcodeRef = (config) => {
    return (0, config_plugins_1.withXcodeProject)(config, (config) => {
        const project = config.modResults;
        const appName = config.modRequest.projectName ?? '';
        // Use the full relative path (from ios/) so Xcode resolves the file correctly.
        // The app group has no `path` property, so files must include the subdirectory.
        const filePath = `${appName}/ConvexMagentsProvider.swift`;
        // Check if already added (avoid duplicates on re-prebuild)
        if (project.hasFile(filePath)) {
            return config;
        }
        // Resolve the PBXGroup key for the app target group by name
        const groupKey = project.findPBXGroupKey({ name: appName });
        if (!groupKey) {
            console.warn(`[Expo Dev Launcher] Could not find PBXGroup "${appName}" to add bridge file`);
            return config;
        }
        // addFile creates PBXFileReference + adds to PBXGroup
        const file = project.addFile(filePath, groupKey);
        if (file) {
            file.uuid = project.generateUuid();
            // Add to PBXBuildFile and PBXSourcesBuildPhase so it compiles
            project.addToPbxBuildFileSection(file);
            project.addToPbxSourcesBuildPhase(file);
        }
        return config;
    });
};
/**
 * Generates the ConvexMagentsProvider.swift bridge file in the consumer app's iOS directory.
 * This file implements the MagentsDataProvider protocol and registers itself with MagentsDataStore.
 */
const withConvexBridge = (config) => {
    return (0, config_plugins_1.withDangerousMod)(config, [
        'ios',
        (config) => {
            const appName = config.modRequest.projectName ?? '';
            const bridgePath = path.join(config.modRequest.platformProjectRoot, appName, 'ConvexMagentsProvider.swift');
            // Avoid overwriting on repeated prebuild runs
            if (fs.existsSync(bridgePath)) {
                return config;
            }
            const bridgeContent = `// AUTO-GENERATED by expo-dev-launcher config plugin — do not edit
import ConvexMobile
import Combine
import Foundation
internal import EXDevLauncher

@objc(ConvexMagentsProvider)
@MainActor
final class ConvexMagentsProvider: NSObject, MagentsDataProvider {
    private let client: ConvexClient?
    private var cancellables = Set<AnyCancellable>()

    override init() {
        guard let url = Bundle.main.infoDictionary?["ConvexDeploymentUrl"] as? String,
              !url.isEmpty else {
            client = nil
            return
        }
        client = ConvexClient(deploymentUrl: url)
    }

    func startSubscription() {
        guard let client else { return }

        client.subscribe(to: "agents:list", yielding: [ConvexAgent].self)
            .replaceError(with: [])
            .receive(on: DispatchQueue.main)
            .sink { agents in
                MagentsDataStore.shared.update(agents: agents.map {
                    MagentsAgent(
                        id: $0.id,
                        name: $0.name,
                        status: $0.status,
                        parentId: $0.parentId
                    )
                })
            }
            .store(in: &cancellables)
    }

    func addItem(text: String) async throws {
        guard let client else { return }
        let workspaceName = Bundle.main.bundleIdentifier ?? "expo.dev.launcher"
        let deploymentUrl = Bundle.main.infoDictionary?["ConvexDeploymentUrl"] as? String ?? ""
        let _: String? = try await client.mutation("agents:create", with: [
            "id": UUID().uuidString,
            "name": text,
            "projectName": workspaceName,
            "workspace": workspaceName,
            "metroServerUrl": deploymentUrl,
            "status": "idle",
            "model": "unknown",
            "provider": "convex-mobile"
        ])
    }

    func toggleItem(id: String) async throws {
        guard let client else { return }
        let _: String? = try await client.mutation("agents:toggle", with: ["id": id])
    }

    func removeItem(id: String) async throws {
        guard let client else { return }
        let _: Bool? = try await client.mutation("agents:remove", with: ["id": id])
    }
}

/// Mirrors the Convex document shape for decoding.
private struct ConvexAgent: Decodable {
    let id: String
    let name: String
    let status: String
    let parentId: String?
}
`;
            fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
            fs.writeFileSync(bridgePath, bridgeContent, 'utf8');
            return config;
        },
    ]);
};
/**
 * Injects the Convex deployment URL into Info.plist as `ConvexDeploymentUrl`.
 * This allows the native Swift code to read the URL at runtime via Bundle.main.
 */
const withConvexInfoPlist = (config, convexUrl) => {
    return (0, config_plugins_1.withInfoPlist)(config, (config) => {
        config.modResults['ConvexDeploymentUrl'] = convexUrl;
        return config;
    });
};
/**
 * Adds a build phase script that strips dev-launcher-specific local network permission keys
 * from non-Debug builds. This keeps the keys in Debug builds (where dev-launcher is active)
 * but removes only the dev-launcher entries from production builds.
 *
 * IMPORTANT: This script only removes _expo._tcp Bonjour services and the dev-launcher
 * usage description. Any other Bonjour services or custom local network descriptions
 * added by the app will be preserved in production builds.
 */
const withStripLocalNetworkKeysForRelease = (config) => {
    return (0, config_plugins_1.withXcodeProject)(config, (config) => {
        const project = config.modResults;
        const targetName = config.modRequest.projectName;
        const nativeTargetId = project.findTargetKey(targetName ?? '');
        if (!nativeTargetId) {
            console.warn(`[Expo Dev Launcher] Could not find target "${targetName}" to add build phase script`);
            return config;
        }
        const buildPhaseName = '[Expo Dev Launcher] Strip Local Network Keys for Release';
        const buildPhases = project.pbxNativeTargetSection()[nativeTargetId]?.buildPhases ?? [];
        const existingPhase = buildPhases.find((phase) => {
            return phase.comment === buildPhaseName;
        });
        if (existingPhase) {
            return config;
        }
        project.addBuildPhase([], 'PBXShellScriptBuildPhase', buildPhaseName, nativeTargetId, {
            shellPath: '/bin/sh',
            shellScript: `# Strip dev-launcher-specific local network permission keys from non-Debug builds
# This only removes _expo._tcp Bonjour services and the dev-launcher usage description.
# Other Bonjour services and custom descriptions are preserved for production use.

if [ "$CONFIGURATION" != "Debug" ]; then
  PLIST_PATH="\${TARGET_BUILD_DIR}/\${INFOPLIST_PATH}"
  if [ -f "$PLIST_PATH" ]; then
    # Check if NSBonjourServices exists
    if /usr/libexec/PlistBuddy -c "Print :NSBonjourServices" "$PLIST_PATH" >/dev/null 2>&1; then
      # Get the count of services
      COUNT=$(/usr/libexec/PlistBuddy -c "Print :NSBonjourServices" "$PLIST_PATH" 2>/dev/null | grep "^    " | wc -l | tr -d ' ')

      # Remove _expo._tcp
      for ((i=COUNT-1; i>=0; i--)); do
        SERVICE=$(/usr/libexec/PlistBuddy -c "Print :NSBonjourServices:$i" "$PLIST_PATH" 2>/dev/null || echo "")
        if echo "$SERVICE" | grep -q "_expo._tcp"; then
          /usr/libexec/PlistBuddy -c "Delete :NSBonjourServices:$i" "$PLIST_PATH" 2>/dev/null || true
        fi
      done

      # If the array is now empty, remove it entirely
      REMAINING=$(/usr/libexec/PlistBuddy -c "Print :NSBonjourServices" "$PLIST_PATH" 2>/dev/null | grep "^    " | wc -l | tr -d ' ')
      if [ "$REMAINING" -eq "0" ]; then
        /usr/libexec/PlistBuddy -c "Delete :NSBonjourServices" "$PLIST_PATH" 2>/dev/null || true
      fi
    fi

    # Only delete the description if it matches the dev-launcher default text
    DESC=$(/usr/libexec/PlistBuddy -c "Print :NSLocalNetworkUsageDescription" "$PLIST_PATH" 2>/dev/null || echo "")
    if echo "$DESC" | grep -q "Expo Dev Launcher"; then
      /usr/libexec/PlistBuddy -c "Delete :NSLocalNetworkUsageDescription" "$PLIST_PATH" 2>/dev/null || true
    fi
  fi
fi
`,
        });
        return config;
    });
};
/**
 * Adds the required Info.plist keys for local network permission.
 * Only adds _expo._tcp to the Bonjour services array and sets the usage description
 * if one doesn't already exist (preserving custom descriptions).
 */
const withLocalNetworkPermission = (config) => {
    return (0, config_plugins_1.withInfoPlist)(config, (config) => {
        const bonjourServices = config.modResults.NSBonjourServices ?? [];
        const hasExpoService = bonjourServices.some((service) => service.toLowerCase().replace(/\.$/, '') === '_expo._tcp');
        if (!hasExpoService) {
            bonjourServices.push('_expo._tcp');
        }
        config.modResults.NSBonjourServices = bonjourServices;
        if (!config.modResults.NSLocalNetworkUsageDescription) {
            config.modResults.NSLocalNetworkUsageDescription =
                'Expo Dev Launcher uses the local network to discover and connect to development servers running on your computer.';
        }
        return config;
    });
};
exports.default = (0, config_plugins_1.createRunOncePlugin)((config, props = {}) => {
    (0, pluginConfig_1.validateConfig)(props);
    const iOSLaunchMode = props.ios?.launchMode ??
        props.launchMode ??
        props.ios?.launchModeExperimental ??
        props.launchModeExperimental;
    if (iOSLaunchMode === 'launcher') {
        config = (0, config_plugins_1.withInfoPlist)(config, (config) => {
            config.modResults['DEV_CLIENT_TRY_TO_LAUNCH_LAST_BUNDLE'] = false;
            return config;
        });
    }
    const androidLaunchMode = props.android?.launchMode ??
        props.launchMode ??
        props.android?.launchModeExperimental ??
        props.launchModeExperimental;
    if (androidLaunchMode === 'launcher') {
        config = (0, config_plugins_1.withAndroidManifest)(config, (config) => {
            const mainApplication = config_plugins_1.AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
            config_plugins_1.AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, 'DEV_CLIENT_TRY_TO_LAUNCH_LAST_BUNDLE', false?.toString());
            return config;
        });
    }
    config = withLocalNetworkPermission(config);
    config = withStripLocalNetworkKeysForRelease(config);
    // Convex integration (conditional on convexUrl)
    if (props.convexUrl) {
        config = withConvexSPM(config);
        config = withConvexBridgeXcodeRef(config);
        config = withConvexBridge(config);
        config = withConvexInfoPlist(config, props.convexUrl);
    }
    return config;
}, pkg.name, pkg.version);
