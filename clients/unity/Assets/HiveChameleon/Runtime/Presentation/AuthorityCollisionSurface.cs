using System;
using System.Collections.Generic;
using HiveChameleon.Painting;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    /// <summary>
    /// Rebuilds an arena's physics surface from the same authority geometry the
    /// server collides against.
    /// </summary>
    /// <remarks>
    /// The bundled arena ships hand-authored collision meshes alongside its art.
    /// Those are authored independently of the server manifest, so the two drift:
    /// the client's CharacterController would stop against boxes the server
    /// considers empty, and walk through props the server treats as solid, which
    /// the player experiences as rubber-banding and misplaced hitboxes. Driving
    /// the client surface from the server's own manifest removes the second source
    /// of truth entirely.
    /// </remarks>
    public static class AuthorityCollisionSurface
    {
        public const string NeonServiceArcadeResource =
            "Maps/NeonServiceArcade/NeonServiceArcadeAuthority";

        private const string SurfaceRootName = "Authority collision";

        [Serializable]
        private sealed class Vector
        {
            public float x;
            public float y;
            public float z;

            public Vector3 ToVector3() => new Vector3(x, y, z);
        }

        [Serializable]
        private sealed class OrientedBox
        {
            public string name;
            public Vector center;
            public half_extent_holder half_extent;
            public quaternion_xyz_holder quaternion_xyz;
            public float quaternion_w;
        }

        [Serializable]
        private sealed class quaternion_xyz_holder
        {
            public float x;
            public float y;
            public float z;
        }

        // JsonUtility maps by field name, so the snake_case key needs a field of
        // the same name; this wrapper keeps that ugliness out of the call sites.
        [Serializable]
        private sealed class half_extent_holder
        {
            public float x;
            public float y;
            public float z;

            public Vector3 ToVector3() => new Vector3(x, y, z);
        }

        [Serializable]
        private sealed class Manifest
        {
            public int schema_version;
            public string version;
            public string map_slug;
            public OrientedBox[] buildings;
        }

        /// <summary>
        /// Destroys an object, choosing the call that is legal in the current mode so
        /// the same code can run at load time and from the editor baker.
        /// </summary>
        private static void Discard(UnityEngine.Object target)
        {
            if (Application.isPlaying)
            {
                UnityEngine.Object.Destroy(target);
            }
            else
            {
                UnityEngine.Object.DestroyImmediate(target, true);
            }
        }

        /// <summary>
        /// Builds the authority surface under <paramref name="mapObject"/> without
        /// touching any collision already present. Returns the number of colliders
        /// built, or -1 if the manifest could not be read.
        /// </summary>
        public static int BuildInto(GameObject mapObject, string resourcePath)
        {
            return Apply(mapObject, resourcePath, retireExisting: false);
        }

        /// <summary>
        /// Replaces every collider under <paramref name="mapObject"/> with boxes from
        /// the manifest. Returns the number of colliders built, or -1 if the manifest
        /// could not be read (the existing collision is then left untouched).
        /// </summary>
        public static int Apply(GameObject mapObject, string resourcePath)
        {
            return Apply(mapObject, resourcePath, retireExisting: true);
        }

        private static int Apply(
            GameObject mapObject,
            string resourcePath,
            bool retireExisting
        )
        {
            if (mapObject == null)
            {
                throw new ArgumentNullException(nameof(mapObject));
            }

            var asset = Resources.Load<TextAsset>(resourcePath);
            if (asset == null)
            {
                Debug.LogError(
                    $"Authority collision manifest '{resourcePath}' is missing; "
                        + "the arena keeps its authored collision."
                );
                return -1;
            }

            Manifest manifest;
            try
            {
                manifest = JsonUtility.FromJson<Manifest>(asset.text);
            }
            catch (Exception error)
            {
                Debug.LogError($"Authority collision manifest is unreadable: {error.Message}");
                return -1;
            }

            if (manifest?.buildings == null || manifest.buildings.Length == 0)
            {
                Debug.LogError("Authority collision manifest contains no geometry.");
                return -1;
            }

            // Retire the authored collision before adding the authoritative surface,
            // so a prop is never solid twice or solid in two different places.
            if (retireExisting)
            {
                var retired = new List<Collider>();
                mapObject.GetComponentsInChildren(true, retired);
                for (int index = 0; index < retired.Count; index++)
                {
                    Collider collider = retired[index];
                    if (
                        collider != null
                        && collider.GetComponentInParent<PaintableBody>() == null
                    )
                    {
                        Discard(collider);
                    }
                }
            }

            // The arena keeps its physics under a "Collision" child; staying there
            // preserves the hierarchy the rest of the game and the tests expect.
            Transform host = mapObject.transform.Find("Collision") ?? mapObject.transform;

            // Sweep the whole arena, not just the host, so a surface left anywhere by
            // an earlier build cannot survive as a second set of solid geometry.
            var stale = new List<Transform>();
            mapObject.GetComponentsInChildren(true, stale);
            for (int index = 0; index < stale.Count; index++)
            {
                Transform candidate = stale[index];
                if (candidate != null && candidate.name == SurfaceRootName)
                {
                    Discard(candidate.gameObject);
                }
            }

            var root = new GameObject(SurfaceRootName);
            root.transform.SetParent(host, false);

            // The arena art hangs under a negatively scaled transform. Cancel the
            // inherited scale so the manifest's coordinates land in world space
            // unmirrored; without this the whole surface is flipped in X.
            Vector3 inherited = host.lossyScale;
            root.transform.localScale = new Vector3(
                Mathf.Approximately(inherited.x, 0f) ? 1f : 1f / inherited.x,
                Mathf.Approximately(inherited.y, 0f) ? 1f : 1f / inherited.y,
                Mathf.Approximately(inherited.z, 0f) ? 1f : 1f / inherited.z
            );
            root.transform.localPosition = Vector3.zero;
            root.transform.localRotation = Quaternion.identity;

            int built = 0;
            for (int index = 0; index < manifest.buildings.Length; index++)
            {
                OrientedBox box = manifest.buildings[index];
                if (box?.center == null || box.half_extent == null)
                {
                    continue;
                }
                var child = new GameObject(
                    string.IsNullOrEmpty(box.name) ? $"COL_{index:D3}" : box.name
                );
                child.transform.SetParent(root.transform, false);
                child.layer = mapObject.layer;

                // Volumes may be turned about the vertical, which is the only
                // rotation the authority format carries. Carrying it on the child
                // transform keeps the collider itself axis-aligned in its own
                // frame, so a turned prop gets a box that hugs it rather than the
                // larger upright envelope that would contain it.
                child.transform.localPosition = box.center.ToVector3();
                child.transform.localRotation = box.quaternion_xyz == null
                    ? Quaternion.identity
                    : new Quaternion(
                        box.quaternion_xyz.x,
                        box.quaternion_xyz.y,
                        box.quaternion_xyz.z,
                        box.quaternion_w
                    );

                BoxCollider collider = child.AddComponent<BoxCollider>();
                collider.center = Vector3.zero;
                collider.size = box.half_extent.ToVector3() * 2f;
                built++;
            }

            return built;
        }
    }
}
