using System.Collections.Generic;
using System.Linq;
using HiveChameleon.Presentation;
using UnityEditor;
using UnityEngine;

namespace HiveChameleon.EditorTools
{
    /// <summary>
    /// Bakes the server's authority geometry into the bundled arena prefab.
    /// </summary>
    /// <remarks>
    /// The arena used to carry hand-authored collision meshes that were maintained
    /// separately from the server manifest, so the two disagreed about where the
    /// solid world was. <see cref="AuthorityCollisionSurface"/> already rebuilds the
    /// surface at runtime, but the prefab kept the stale meshes, which is what the
    /// Scene view still drew. Running this bakes the same geometry into the asset so
    /// the editor shows what is actually played.
    /// </remarks>
    public static class ArenaCollisionBaker
    {
        private const string PrefabPath =
            "Assets/HiveChameleon/Resources/Maps/NeonServiceArcade/HC_NeonServiceArcade.prefab";

        // Mirrors the spawn table in runtime/nakama/arena_catalog.go. Drift is caught
        // by the PlayMode spawn-safety test, which rejects a spawn inside geometry.
        private static readonly Vector3[] HunterSpawns =
        {
            new Vector3(-9.00f, 0.05f, -5.25f),
            new Vector3(-9.00f, 0.05f, -3.75f),
        };

        private static readonly Vector3[] HiderSpawns =
        {
            new Vector3(-9.00f, 0.05f, -1.00f),
            new Vector3(8.00f, 0.05f, 7.00f),
            new Vector3(4.50f, 0.05f, -6.00f),
            new Vector3(-1.75f, 0.05f, 5.75f),
            new Vector3(-1.50f, 0.05f, -1.75f),
            new Vector3(8.00f, 0.05f, 0.00f),
        };

        [MenuItem("Hive Chameleon/Bake arena collision from authority geometry")]
        public static void Bake()
        {
            GameObject root = PrefabUtility.LoadPrefabContents(PrefabPath);
            if (root == null)
            {
                Debug.LogError($"Could not open {PrefabPath}");
                return;
            }

            try
            {
                int retired = RetireAuthoredCollision(root);
                int built = AuthorityCollisionSurface.BuildInto(
                    root,
                    AuthorityCollisionSurface.NeonServiceArcadeResource
                );
                if (built <= 0)
                {
                    Debug.LogError("Authority geometry could not be read; prefab untouched.");
                    return;
                }

                int moved = MoveSpawns(root);
                PrefabUtility.SaveAsPrefabAsset(root, PrefabPath);
                Debug.Log(
                    $"Arena collision baked: retired {retired} authored colliders, "
                        + $"built {built} authority colliders, moved {moved} spawns."
                );
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }
        }

        private static int RetireAuthoredCollision(GameObject root)
        {
            var colliders = new List<Collider>();
            root.GetComponentsInChildren(true, colliders);
            int retired = 0;
            foreach (Collider collider in colliders)
            {
                if (collider == null)
                {
                    continue;
                }
                Object.DestroyImmediate(collider, true);
                retired++;
            }
            return retired;
        }

        private static int MoveSpawns(GameObject root)
        {
            var candidate = root.GetComponent<BundledArenaCandidate>();
            if (candidate == null)
            {
                return 0;
            }

            var serialized = new SerializedObject(candidate);
            int moved = 0;
            moved += MoveSpawnArray(serialized, "hunterSpawns", HunterSpawns);
            moved += MoveSpawnArray(serialized, "hiderSpawns", HiderSpawns);
            serialized.ApplyModifiedPropertiesWithoutUndo();
            return moved;
        }

        private static int MoveSpawnArray(
            SerializedObject serialized,
            string field,
            IReadOnlyList<Vector3> positions
        )
        {
            SerializedProperty array = serialized.FindProperty(field);
            if (array == null || !array.isArray)
            {
                return 0;
            }
            int moved = 0;
            for (int index = 0; index < array.arraySize && index < positions.Count; index++)
            {
                var marker =
                    array.GetArrayElementAtIndex(index).objectReferenceValue as Transform;
                if (marker == null)
                {
                    continue;
                }
                marker.position = positions[index];
                moved++;
            }
            return moved;
        }
    }
}
