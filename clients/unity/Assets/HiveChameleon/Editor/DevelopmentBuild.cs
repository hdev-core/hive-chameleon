using System;
using System.IO;
using HiveChameleon.Realtime;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HiveChameleon.Editor
{
    public static class DevelopmentBuild
    {
        private const string ScenePath = "Assets/Scenes/Development.unity";

        [MenuItem("Hive Chameleon/Build/Development")]
        public static void BuildFromMenu()
        {
            Build(EditorUserBuildSettings.activeBuildTarget);
        }

        public static void BuildFromCommandLine()
        {
            Build(ResolveBuildTarget(Environment.GetEnvironmentVariable("UNITY_BUILD_TARGET")));
        }

        private static void Build(BuildTarget target)
        {
            try
            {
                EnsureDevelopmentScene(target);

                if (EditorUserBuildSettings.activeBuildTarget != target)
                {
                    BuildTargetGroup group = BuildPipeline.GetBuildTargetGroup(target);
                    if (!EditorUserBuildSettings.SwitchActiveBuildTarget(group, target))
                    {
                        throw new InvalidOperationException(
                            $"Could not activate build target {target}."
                        );
                    }
                }

                PlayerSettings.companyName = "hdev";
                PlayerSettings.productName = "Hive Chameleon";
                PlayerSettings.bundleVersion = "0.1.0";

                string location = GetBuildLocation(target);
                Directory.CreateDirectory(Path.GetDirectoryName(location) ?? location);

                BuildPlayerOptions options = new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath },
                    locationPathName = location,
                    target = target,
                    options = BuildOptions.Development | BuildOptions.AllowDebugging,
                };

                var report = BuildPipeline.BuildPlayer(options);
                if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
                {
                    throw new InvalidOperationException(
                        $"Unity development build failed: {report.summary.result}."
                    );
                }
            }
            finally
            {
                // WebGL cannot read process environment variables at runtime. Credentials are
                // serialized only for the build, then the source scene is regenerated without them.
                EnsureDevelopmentScene(null);
            }
        }

        private static void EnsureDevelopmentScene(BuildTarget? configuredTarget)
        {
            Directory.CreateDirectory("Assets/Scenes");
            AssetDatabase.Refresh();

            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject root = new GameObject("HiveChameleon");
            root.AddComponent<Bootstrap>();

            if (configuredTarget == BuildTarget.WebGL)
            {
                ConfigureWebGlRealtime(root);
            }

            if (!EditorSceneManager.SaveScene(scene, ScenePath))
            {
                throw new InvalidOperationException($"Could not save generated scene at {ScenePath}.");
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        private static void ConfigureWebGlRealtime(GameObject root)
        {
            string apiBaseUrl = Environment.GetEnvironmentVariable("HIVE_CHAMELEON_API_URL");
            string serverKey = Environment.GetEnvironmentVariable("NAKAMA_SERVER_KEY");
            string bearerToken = Environment.GetEnvironmentVariable("REALTIME_DEV_BEARER_TOKEN");

            bool hasApiBaseUrl = !string.IsNullOrWhiteSpace(apiBaseUrl);
            bool hasServerKey = !string.IsNullOrWhiteSpace(serverKey);
            bool hasBearerToken = !string.IsNullOrWhiteSpace(bearerToken);

            if (!hasApiBaseUrl && !hasServerKey && !hasBearerToken)
            {
                return;
            }

            if (!hasApiBaseUrl || !hasServerKey || !hasBearerToken)
            {
                throw new InvalidOperationException(
                    "WebGL realtime builds require HIVE_CHAMELEON_API_URL, "
                        + "NAKAMA_SERVER_KEY, and REALTIME_DEV_BEARER_TOKEN together."
                );
            }

            if (
                !Uri.TryCreate(apiBaseUrl, UriKind.Absolute, out Uri parsedApiBaseUrl)
                || (parsedApiBaseUrl.Scheme != Uri.UriSchemeHttp
                    && parsedApiBaseUrl.Scheme != Uri.UriSchemeHttps)
            )
            {
                throw new InvalidOperationException(
                    "HIVE_CHAMELEON_API_URL must be an absolute HTTP or HTTPS URL."
                );
            }

            if (bearerToken.Trim().Length < 32)
            {
                throw new InvalidOperationException(
                    "REALTIME_DEV_BEARER_TOKEN must contain at least 32 characters."
                );
            }

            DevelopmentRealtimeBootstrap realtime =
                root.AddComponent<DevelopmentRealtimeBootstrap>();
            realtime.ConfigureForDevelopmentBuild(
                apiBaseUrl.TrimEnd('/'),
                serverKey.Trim(),
                bearerToken.Trim()
            );
        }

        private static BuildTarget ResolveBuildTarget(string requested)
        {
            if (string.IsNullOrWhiteSpace(requested))
            {
                return EditorUserBuildSettings.activeBuildTarget;
            }

            switch (requested.Trim().ToLowerInvariant())
            {
                case "webgl":
                    return BuildTarget.WebGL;
                case "mac":
                case "macos":
                    return BuildTarget.StandaloneOSX;
                case "windows":
                case "win":
                    return BuildTarget.StandaloneWindows64;
                case "linux":
                    return BuildTarget.StandaloneLinux64;
                default:
                    throw new ArgumentException(
                        $"Unsupported UNITY_BUILD_TARGET '{requested}'. Use macOS, windows, linux, or webgl."
                    );
            }
        }

        private static string GetBuildLocation(BuildTarget target)
        {
            string root = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Builds"));

            switch (target)
            {
                case BuildTarget.WebGL:
                    return Path.Combine(root, "WebGL");
                case BuildTarget.StandaloneOSX:
                    return Path.Combine(root, "macOS", "Hive Chameleon.app");
                case BuildTarget.StandaloneWindows64:
                    return Path.Combine(root, "Windows", "HiveChameleon.exe");
                case BuildTarget.StandaloneLinux64:
                    return Path.Combine(root, "Linux", "HiveChameleon");
                default:
                    throw new ArgumentException($"Unsupported development build target {target}.");
            }
        }
    }
}
