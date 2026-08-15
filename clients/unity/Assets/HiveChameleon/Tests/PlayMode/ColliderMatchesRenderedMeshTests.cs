using System.Collections;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class ColliderMatchesRenderedMeshTests
    {
        [UnityTest]
        public IEnumerator EveryColliderSitsOnTheMeshItRepresents()
        {
            var prefab = Resources.Load<GameObject>("Maps/NeonServiceArcade/HC_NeonServiceArcade");
            GameObject arena = Object.Instantiate(prefab);
            yield return null;
            Physics.SyncTransforms();
            Transform visual = arena.transform.Find("Visual");
            Transform collision = arena.transform.Find("Collision");
            var meshes = new Dictionary<string, Bounds>();
            foreach (Renderer r in visual.GetComponentsInChildren<Renderer>(true))
            {
                var mf = r.GetComponent<MeshFilter>();
                if (mf == null || mf.sharedMesh == null) continue;
                if (meshes.TryGetValue(r.name, out Bounds b)) { b.Encapsulate(r.bounds); meshes[r.name] = b; }
                else meshes[r.name] = r.bounds;
            }
            Collider[] cols = collision.GetComponentsInChildren<Collider>(true);
            int matched = 0, bad = 0, flipZ = 0;
            var worst = new List<string>();
            foreach (Collider c in cols)
            {
                if (!meshes.TryGetValue(c.name, out Bounds mesh)) continue;
                matched++;
                float d = Vector3.Distance(c.bounds.center, mesh.center);
                if (d > 0.30f)
                {
                    bad++;
                    var fz = new Vector3(c.bounds.center.x, c.bounds.center.y, -c.bounds.center.z);
                    if (Vector3.Distance(fz, mesh.center) < 0.30f) flipZ++;
                    if (worst.Count < 8) worst.Add($"{c.name} off={d:F2}m collider{c.bounds.center} mesh{mesh.center}");
                }
            }
            Assert.That(
                matched,
                Is.GreaterThan(100),
                "collision volumes must be name-matched to the meshes they represent"
            );
            Assert.That(
                bad,
                Is.EqualTo(0),
                "collision must sit on the rendered geometry. Misplaced: "
                    + string.Join(" | ", worst)
                    + (flipZ > 0
                        ? $" -- {flipZ} of them land correctly when Z is negated, "
                            + "which means the Blender to Unity axis conversion is mirrored"
                        : string.Empty)
            );
            Object.DestroyImmediate(arena);
        }
    }
}
