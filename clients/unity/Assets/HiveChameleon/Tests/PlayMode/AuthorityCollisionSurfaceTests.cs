using System.Collections;
using System.Linq;
using HiveChameleon.Presentation;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class AuthorityCollisionSurfaceTests
    {
        private GameObject _arena;

        // Physics queries are scene-wide, so an arena left behind by a failing
        // assertion would silently corrupt every later test in the run.
        [TearDown]
        public void TearDown()
        {
            if (_arena != null)
            {
                Object.DestroyImmediate(_arena);
                _arena = null;
            }
        }

        private GameObject LoadArena()
        {
            var prefab = Resources.Load<GameObject>(
                "Maps/NeonServiceArcade/HC_NeonServiceArcade"
            );
            Assert.That(prefab, Is.Not.Null, "the bundled arena prefab must exist");
            _arena = Object.Instantiate(prefab);
            return _arena;
        }

        /// <summary>
        /// The client must collide against the server's geometry, placed in the same
        /// world positions. A sign error here would mirror the whole arena, because
        /// the arena's art is parented under a negatively scaled transform.
        /// </summary>
        [UnityTest]
        public IEnumerator AuthoritySurfaceReplacesAuthoredCollisionInWorldSpace()
        {
            GameObject arena = LoadArena();
            yield return null;

            int authored = arena.GetComponentsInChildren<Collider>(true).Length;
            Assert.That(authored, Is.GreaterThan(0), "the arena ships authored collision");

            int built = AuthorityCollisionSurface.Apply(
                arena,
                AuthorityCollisionSurface.NeonServiceArcadeResource
            );
            yield return null;
            Physics.SyncTransforms();

            Assert.That(built, Is.GreaterThan(100), "the authority surface must be built");

            Collider[] colliders = arena.GetComponentsInChildren<Collider>(true);
            Assert.That(
                colliders.Length,
                Is.EqualTo(built),
                "the authored collision must be retired, not left alongside"
            );
            Assert.That(
                colliders.All(collider => collider is BoxCollider),
                Is.True,
                "the authority surface is built from axis-aligned boxes"
            );

            Bounds total = colliders[0].bounds;
            foreach (Collider collider in colliders)
            {
                total.Encapsulate(collider.bounds);
            }

            // The arena is 20.6 x 16.6 m centred on the origin. If the surface were
            // mirrored or offset, these would not hold.
            Assert.That(total.center.x, Is.EqualTo(0f).Within(0.35f));
            Assert.That(total.center.z, Is.EqualTo(0f).Within(0.35f));
            Assert.That(total.size.x, Is.EqualTo(20.6f).Within(0.6f));
            Assert.That(total.size.z, Is.EqualTo(16.6f).Within(0.6f));

            // Spot-check an asymmetric landmark so a mirrored X is impossible to miss:
            // the arcade floor slab sits at x = -4, never +4.
            Collider floor = colliders.FirstOrDefault(
                collider => collider.name == "GEO_Floor_Arcade"
            );
            Assert.That(floor, Is.Not.Null, "the arcade floor must be part of the surface");
            Assert.That(
                floor.bounds.center.x,
                Is.EqualTo(-4f).Within(0.2f),
                "the arcade floor is mirrored; the authority surface is flipped in X"
            );
            Assert.That(floor.bounds.size.x, Is.EqualTo(12f).Within(0.3f));
            Assert.That(floor.bounds.size.z, Is.EqualTo(16f).Within(0.3f));

        }

        /// <summary>
        /// Turned props must get a box that hugs them, not the upright envelope that
        /// merely contains them. The benches sit at roughly 37 degrees: fitted, each
        /// is about 1.85 x 0.72 m, whereas an axis-aligned box around the same mesh
        /// measures about 1.91 x 1.69 m and juts far past the bench.
        /// </summary>
        [UnityTest]
        public IEnumerator TurnedPropsGetBoxesFittedToTheirOwnAxes()
        {
            GameObject arena = LoadArena();
            yield return null;

            AuthorityCollisionSurface.Apply(
                arena,
                AuthorityCollisionSurface.NeonServiceArcadeResource
            );
            yield return null;
            Physics.SyncTransforms();

            BoxCollider[] boxes = arena.GetComponentsInChildren<BoxCollider>(true);
            int turned = boxes.Count(
                box => Quaternion.Angle(box.transform.localRotation, Quaternion.identity) > 1f
            );
            Assert.That(
                turned,
                Is.GreaterThan(20),
                "the arena has many props off the world axes; their boxes must be turned too"
            );

            BoxCollider bench = boxes.FirstOrDefault(box => box.name == "BenchA_Base");
            Assert.That(bench, Is.Not.Null, "the arcade bench must be collidable");
            Assert.That(
                Quaternion.Angle(bench.transform.localRotation, Quaternion.identity),
                Is.GreaterThan(10f),
                "the bench stands at an angle, so its box must be turned"
            );
            Assert.That(bench.size.x, Is.EqualTo(1.85f).Within(0.12f));
            Assert.That(bench.size.z, Is.EqualTo(0.72f).Within(0.12f));
        }

        /// <summary>A missing manifest must leave the authored collision in place.</summary>
        [UnityTest]
        public IEnumerator MissingManifestLeavesTheArenaCollidable()
        {
            GameObject arena = LoadArena();
            yield return null;

            int authored = arena.GetComponentsInChildren<Collider>(true).Length;
            LogAssert.ignoreFailingMessages = true;
            int built = AuthorityCollisionSurface.Apply(arena, "Maps/DoesNotExist");
            LogAssert.ignoreFailingMessages = false;

            Assert.That(built, Is.EqualTo(-1));
            Assert.That(
                arena.GetComponentsInChildren<Collider>(true).Length,
                Is.EqualTo(authored),
                "a missing manifest must not strip the arena of collision"
            );

        }
    }
}
