using System;
using System.IO;
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
            Build(EditorUserBuildSettings.activeBuildTarget, false);
        }

        [MenuItem("Hive Chameleon/Build/Production WebGL")]
        public static void BuildProductionWebGLFromMenu()
        {
            Build(BuildTarget.WebGL, true);
        }

        public static void BuildFromCommandLine()
        {
            Build(
                ResolveBuildTarget(Environment.GetEnvironmentVariable("UNITY_BUILD_TARGET")),
                string.Equals(
                    Environment.GetEnvironmentVariable("HIVE_CHAMELEON_BUILD_CONFIGURATION"),
                    "production",
                    StringComparison.OrdinalIgnoreCase
                )
            );
        }

        private static void Build(BuildTarget target, bool production)
        {
            try
            {
                if (production && target != BuildTarget.WebGL)
                {
                    throw new InvalidOperationException(
                        "The production browser build target must be WebGL."
                    );
                }
                EnsureDevelopmentScene();

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
                    // Browsers do not support Unity's managed script debugger. Keep the
                    // development player and only request debugger attachment on platforms
                    // where Unity implements it.
                    options = production
                        ? BuildOptions.None
                        : target == BuildTarget.WebGL
                            ? BuildOptions.Development
                            : BuildOptions.Development | BuildOptions.AllowDebugging,
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
                EnsureDevelopmentScene();
            }
        }

        private static void EnsureDevelopmentScene()
        {
            Directory.CreateDirectory("Assets/Scenes");
            AssetDatabase.Refresh();

            // The scene is deterministic runtime scaffolding. Recreating it after every build
            // churns Unity file IDs and dirties the worktree without changing the player.
            if (File.Exists(ScenePath))
            {
                EditorBuildSettings.scenes = new[]
                {
                    new EditorBuildSettingsScene(ScenePath, true),
                };
                return;
            }

            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            cameraObject.transform.position = new Vector3(0f, 0f, -10f);
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Color.black;

            GameObject lightObject = new GameObject("Directional Light");
            lightObject.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            Light light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;

            GameObject root = new GameObject("HiveChameleon");
            root.AddComponent<Bootstrap>();

            if (!EditorSceneManager.SaveScene(scene, ScenePath))
            {
                throw new InvalidOperationException($"Could not save generated scene at {ScenePath}.");
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
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
