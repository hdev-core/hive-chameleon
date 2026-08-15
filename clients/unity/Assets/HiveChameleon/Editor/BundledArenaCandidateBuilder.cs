using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HiveChameleon.Presentation;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace HiveChameleon.Editor
{
    public static class BundledArenaCandidateBuilder
    {
        private const string NeonVisual =
            "Assets/HiveChameleon/Art/Maps/NeonServiceArcade/HC_NeonServiceArcade_Visual.fbx";
        private const string NeonCollision =
            "Assets/HiveChameleon/Art/Maps/NeonServiceArcade/HC_NeonServiceArcade_Collision.fbx";
        private const string NeonTextures =
            "Assets/HiveChameleon/Art/Maps/NeonServiceArcade/Textures";
        private const string NeonMarkers =
            "Assets/HiveChameleon/Resources/Maps/NeonServiceArcade/HC_NeonServiceArcade_Gameplay.json";
        private const string NeonPrefab =
            "Assets/HiveChameleon/Resources/Maps/NeonServiceArcade/HC_NeonServiceArcade.prefab";
        private const string NeonReviewScene =
            "Assets/Scenes/MapReview_NeonServiceArcade.unity";

        private static readonly ArenaSpec NeonSpec = new ArenaSpec(
            BundledArenaId.NeonServiceArcade,
            "Neon Service Arcade",
            2,
            6,
            NeonVisual,
            NeonCollision,
            NeonMarkers,
            NeonPrefab,
            NeonReviewScene,
            new Color(0.11f, 0.16f, 0.34f),
            new Color(0.07f, 0.08f, 0.16f),
            new Color(0.015f, 0.018f, 0.035f),
            new Color(0.008f, 0.012f, 0.03f)
        );

        [MenuItem("Hive Chameleon/Maps/Rebuild Official Arena")]
        public static void Rebuild()
        {
            EnsureInputs(NeonSpec);
            EnsureEmbeddedTextures(NeonSpec.VisualPath, NeonTextures);
            ConfigureModelImporter(NeonSpec.VisualPath, true);
            ConfigureModelImporter(NeonSpec.CollisionPath, false);

            BuildPrefab(NeonSpec);
            BuildReviewScene(NeonSpec);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            EditorSceneManager.OpenScene(NeonSpec.ReviewScenePath, OpenSceneMode.Single);
            Debug.Log("Official arena rebuilt: Neon Service Arcade.");
        }

        private static void EnsureInputs(ArenaSpec spec)
        {
            foreach (
                string path in new[]
                {
                    spec.VisualPath,
                    spec.CollisionPath,
                    spec.MarkerPath,
                }
            )
            {
                if (AssetDatabase.LoadMainAssetAtPath(path) == null)
                {
                    throw new FileNotFoundException(
                        $"Required bundled arena source is missing: {path}"
                    );
                }
            }
        }

        private static void EnsureEmbeddedTextures(
            string modelPath,
            string textureFolder
        )
        {
            if (
                AssetDatabase.IsValidFolder(textureFolder)
                && AssetDatabase.FindAssets(
                    "t:Texture2D",
                    new[] { textureFolder }
                ).Length > 0
            )
            {
                return;
            }

            string parent = Path.GetDirectoryName(textureFolder)
                ?.Replace('\\', '/');
            string folderName = Path.GetFileName(textureFolder);
            if (
                string.IsNullOrWhiteSpace(parent)
                || string.IsNullOrWhiteSpace(folderName)
            )
            {
                throw new InvalidOperationException(
                    $"Invalid arena texture folder: {textureFolder}."
                );
            }
            if (!AssetDatabase.IsValidFolder(textureFolder))
            {
                AssetDatabase.CreateFolder(parent, folderName);
            }

            ModelImporter importer =
                AssetImporter.GetAtPath(modelPath) as ModelImporter;
            if (importer == null || !importer.ExtractTextures(textureFolder))
            {
                throw new InvalidOperationException(
                    $"Embedded arena textures could not be extracted from {modelPath}."
                );
            }
            AssetDatabase.Refresh();
            importer = AssetImporter.GetAtPath(modelPath) as ModelImporter;
            importer?.SaveAndReimport();
        }

        private static void ConfigureModelImporter(
            string path,
            bool importMaterials
        )
        {
            ModelImporter importer = AssetImporter.GetAtPath(path) as ModelImporter;
            if (importer == null)
            {
                throw new InvalidOperationException(
                    $"Model importer is unavailable for {path}."
                );
            }

            importer.globalScale = 1f;
            importer.useFileScale = true;
            importer.importAnimation = false;
            importer.importBlendShapes = false;
            importer.importCameras = false;
            importer.importLights = false;
            importer.importVisibility = false;
            importer.bakeAxisConversion = false;
            importer.addCollider = !importMaterials;
            importer.isReadable = false;
            importer.preserveHierarchy = true;
            importer.materialImportMode = importMaterials
                ? ModelImporterMaterialImportMode.ImportStandard
                : ModelImporterMaterialImportMode.None;
            if (importMaterials)
            {
                importer.materialLocation =
                    ModelImporterMaterialLocation.InPrefab;
                importer.useSRGBMaterialColor = true;
            }
            importer.SaveAndReimport();
        }



        private static void BuildPrefab(ArenaSpec spec)
        {
            GameObject visualAsset =
                AssetDatabase.LoadAssetAtPath<GameObject>(spec.VisualPath);
            GameObject collisionAsset =
                AssetDatabase.LoadAssetAtPath<GameObject>(spec.CollisionPath);
            TextAsset markers =
                AssetDatabase.LoadAssetAtPath<TextAsset>(spec.MarkerPath);
            MarkerManifest manifest = JsonUtility.FromJson<MarkerManifest>(
                markers.text
            );
            if (manifest?.markers == null || manifest.markers.Length == 0)
            {
                throw new InvalidDataException(
                    $"No gameplay markers were found in {spec.MarkerPath}."
                );
            }

            GameObject root = new GameObject($"{spec.DisplayName} Arena");
            try
            {
                GameObject visual = InstantiateModel(
                    visualAsset,
                    "Visual",
                    root.transform
                );
                GameObject collision = InstantiateModel(
                    collisionAsset,
                    "Collision",
                    root.transform
                );

                PrepareVisualGeometry(visual);
                PrepareCollisionGeometry(collision);
                Transform[] hunterSpawns;
                Transform[] hiderSpawns;
                BuildSpawns(
                    root.transform,
                    manifest,
                    out hunterSpawns,
                    out hiderSpawns
                );
                BuildLighting(root.transform, spec);

                BundledArenaCandidate arena =
                    root.AddComponent<BundledArenaCandidate>();
                arena.ConfigureForEditor(
                    spec.Id,
                    spec.DisplayName,
                    spec.MinimumPlayers,
                    spec.MaximumPlayers,
                    hunterSpawns,
                    hiderSpawns,
                    spec.AmbientSky,
                    spec.AmbientEquator,
                    spec.AmbientGround,
                    spec.CameraBackground
                );

                PrefabUtility.SaveAsPrefabAsset(root, spec.PrefabPath);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static GameObject InstantiateModel(
            GameObject model,
            string name,
            Transform parent
        )
        {
            GameObject instance =
                PrefabUtility.InstantiatePrefab(model) as GameObject;
            if (instance == null)
            {
                throw new InvalidOperationException(
                    $"Could not instantiate model asset {model.name}."
                );
            }
            instance.name = name;
            instance.transform.SetParent(parent, false);
            instance.transform.localPosition = Vector3.zero;
            instance.transform.localRotation = Quaternion.identity;
            // Unity's FBX handedness conversion reflects the authored X axis.
            // Undo that reflection so meshes, gameplay markers, and Nakama's
            // (Blender X, Blender Z, -Blender Y) authority space stay aligned.
            instance.transform.localScale = new Vector3(-1f, 1f, 1f);
            PrefabUtility.UnpackPrefabInstance(
                instance,
                PrefabUnpackMode.Completely,
                InteractionMode.AutomatedAction
            );
            return instance;
        }

        private static void PrepareVisualGeometry(GameObject visual)
        {
            foreach (Collider collider in visual.GetComponentsInChildren<Collider>(true))
            {
                UnityEngine.Object.DestroyImmediate(collider);
            }

            foreach (Renderer renderer in visual.GetComponentsInChildren<Renderer>(true))
            {
                renderer.enabled = true;
                renderer.shadowCastingMode = ShadowCastingMode.On;
                renderer.receiveShadows = true;
                renderer.lightProbeUsage = LightProbeUsage.BlendProbes;
                renderer.reflectionProbeUsage = ReflectionProbeUsage.BlendProbes;
            }
            SetStaticRecursively(visual);
        }

        private static void PrepareCollisionGeometry(GameObject collision)
        {
            foreach (Renderer renderer in collision.GetComponentsInChildren<Renderer>(true))
            {
                renderer.enabled = false;
                renderer.shadowCastingMode = ShadowCastingMode.Off;
                renderer.receiveShadows = false;
            }

            int colliderCount = 0;
            foreach (MeshFilter filter in collision.GetComponentsInChildren<MeshFilter>(true))
            {
                if (filter.sharedMesh == null)
                {
                    continue;
                }
                MeshCollider collider =
                    filter.GetComponent<MeshCollider>()
                    ?? filter.gameObject.AddComponent<MeshCollider>();
                collider.sharedMesh = filter.sharedMesh;
                collider.convex = false;
                collider.enabled = true;
                colliderCount++;
            }
            if (colliderCount == 0)
            {
                throw new InvalidOperationException(
                    $"Collision model {collision.name} contains no mesh filters."
                );
            }
            SetStaticRecursively(collision);
        }

        private static void SetStaticRecursively(GameObject root)
        {
            const StaticEditorFlags flags =
                StaticEditorFlags.BatchingStatic
                | StaticEditorFlags.OccluderStatic
                | StaticEditorFlags.OccludeeStatic
                | StaticEditorFlags.ReflectionProbeStatic;

            foreach (Transform value in root.GetComponentsInChildren<Transform>(true))
            {
                GameObjectUtility.SetStaticEditorFlags(value.gameObject, flags);
            }
        }

        private static void BuildSpawns(
            Transform root,
            MarkerManifest manifest,
            out Transform[] hunterSpawns,
            out Transform[] hiderSpawns
        )
        {
            Transform gameplay = new GameObject("Gameplay").transform;
            gameplay.SetParent(root, false);
            Transform hunters = new GameObject("Hunter Spawns").transform;
            hunters.SetParent(gameplay, false);
            Transform hiders = new GameObject("Hider Spawns").transform;
            hiders.SetParent(gameplay, false);

            var hunterValues = new List<Transform>();
            var hiderValues = new List<Transform>();
            foreach (
                MarkerRecord marker in manifest.markers.OrderBy(
                    value => value.name,
                    StringComparer.Ordinal
                )
            )
            {
                bool hunter = marker.name.StartsWith(
                    "SPAWN_Hunter_",
                    StringComparison.Ordinal
                );
                bool hider = marker.name.StartsWith(
                    "SPAWN_Hider_",
                    StringComparison.Ordinal
                );
                if (!hunter && !hider)
                {
                    continue;
                }
                if (
                    marker.position_unity_xyz == null
                    || marker.position_unity_xyz.Length != 3
                )
                {
                    throw new InvalidDataException(
                        $"Marker {marker.name} has an invalid Unity position."
                    );
                }

                Transform spawn = new GameObject(marker.name).transform;
                spawn.SetParent(hunter ? hunters : hiders, false);
                spawn.localPosition = new Vector3(
                    marker.position_unity_xyz[0],
                    marker.position_unity_xyz[1],
                    marker.position_unity_xyz[2]
                );
                spawn.localRotation = Quaternion.Euler(
                    0f,
                    marker.rotation_unity_y_degrees,
                    0f
                );
                (hunter ? hunterValues : hiderValues).Add(spawn);
            }

            if (hunterValues.Count == 0 || hiderValues.Count == 0)
            {
                throw new InvalidDataException(
                    "Every bundled arena requires Hunter and Hider spawns."
                );
            }
            hunterSpawns = hunterValues.ToArray();
            hiderSpawns = hiderValues.ToArray();
        }

        private static void BuildLighting(Transform root, ArenaSpec spec)
        {
            Transform lighting = new GameObject("Lighting").transform;
            lighting.SetParent(root, false);

            AddPoint(
                lighting,
                "Arcade Cyan",
                new Vector3(-3.5f, 2.65f, 0.4f),
                new Color(0.05f, 0.65f, 1f),
                4.2f,
                8.5f
            );
            AddPoint(
                lighting,
                "Arcade Magenta",
                new Vector3(-7.2f, 2.45f, -3.1f),
                new Color(1f, 0.05f, 0.55f),
                3.8f,
                7f
            );
            AddPoint(
                lighting,
                "Prize Cafe Warm",
                new Vector3(6f, 2.65f, -3.5f),
                new Color(1f, 0.32f, 0.06f),
                4.4f,
                7f
            );
            AddPoint(
                lighting,
                "Workshop Cool",
                new Vector3(6f, 2.65f, 4.5f),
                new Color(0.17f, 0.42f, 1f),
                4.2f,
                7f
            );
        }

        private static void AddPoint(
            Transform parent,
            string name,
            Vector3 position,
            Color color,
            float intensity,
            float range
        )
        {
            GameObject value = new GameObject(name);
            value.transform.SetParent(parent, false);
            value.transform.localPosition = position;
            Light light = value.AddComponent<Light>();
            light.type = LightType.Point;
            light.color = color;
            light.intensity = intensity;
            light.range = range;
            light.shadows = LightShadows.Soft;
        }

        private static void BuildReviewScene(ArenaSpec spec)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(spec.ReviewScenePath));
            Scene scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene,
                NewSceneMode.Single
            );
            GameObject prefab =
                AssetDatabase.LoadAssetAtPath<GameObject>(spec.PrefabPath);
            GameObject arena =
                PrefabUtility.InstantiatePrefab(prefab, scene) as GameObject;
            arena.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);

            foreach (Transform value in arena.GetComponentsInChildren<Transform>(true))
            {
                if (
                    value.name.StartsWith("GEO_", StringComparison.Ordinal)
                    && value.name.EndsWith("Ceiling", StringComparison.Ordinal)
                )
                {
                    value.gameObject.SetActive(false);
                }
            }

            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            cameraObject.AddComponent<AudioListener>();
            camera.fieldOfView = 48f;
            camera.nearClipPlane = 0.05f;
            camera.farClipPlane = 80f;
            cameraObject.transform.position = new Vector3(14f, 15f, 16f);
            cameraObject.transform.rotation = Quaternion.LookRotation(
                new Vector3(0f, 1.1f, 0f) - cameraObject.transform.position
            );

            GameObject sunObject = new GameObject("Directional Light");
            sunObject.transform.rotation = Quaternion.Euler(48f, -35f, 0f);
            Light sun = sunObject.AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.88f, 0.74f);
            sun.intensity = 0.55f;
            sun.shadows = LightShadows.Soft;

            BundledArenaCandidate candidate =
                arena.GetComponent<BundledArenaCandidate>();
            candidate.ApplyPresentationEnvironment(camera);
            EditorSceneManager.SaveScene(scene, spec.ReviewScenePath);
        }

        [Serializable]
        private sealed class MarkerManifest
        {
            public MarkerRecord[] markers = Array.Empty<MarkerRecord>();
        }

        [Serializable]
        private sealed class MarkerRecord
        {
            public string name = string.Empty;
            public float[] position_unity_xyz = Array.Empty<float>();
            public float rotation_unity_y_degrees;
        }

        private sealed class ArenaSpec
        {
            public ArenaSpec(
                BundledArenaId id,
                string displayName,
                int minimumPlayers,
                int maximumPlayers,
                string visualPath,
                string collisionPath,
                string markerPath,
                string prefabPath,
                string reviewScenePath,
                Color ambientSky,
                Color ambientEquator,
                Color ambientGround,
                Color cameraBackground
            )
            {
                Id = id;
                DisplayName = displayName;
                MinimumPlayers = minimumPlayers;
                MaximumPlayers = maximumPlayers;
                VisualPath = visualPath;
                CollisionPath = collisionPath;
                MarkerPath = markerPath;
                PrefabPath = prefabPath;
                ReviewScenePath = reviewScenePath;
                AmbientSky = ambientSky;
                AmbientEquator = ambientEquator;
                AmbientGround = ambientGround;
                CameraBackground = cameraBackground;
            }

            public BundledArenaId Id { get; }
            public string DisplayName { get; }
            public int MinimumPlayers { get; }
            public int MaximumPlayers { get; }
            public string VisualPath { get; }
            public string CollisionPath { get; }
            public string MarkerPath { get; }
            public string PrefabPath { get; }
            public string ReviewScenePath { get; }
            public Color AmbientSky { get; }
            public Color AmbientEquator { get; }
            public Color AmbientGround { get; }
            public Color CameraBackground { get; }
        }
    }
}
