using System.Collections;
using System.Linq;
using HiveChameleon.Presentation;
using HiveChameleon.Realtime;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class BundledArenaCandidateTests
    {
        [Test]
        public void AuthoritativeCatalogExposesEverySelectableArena()
        {
            Assert.That(AuthoritativeArenaCatalog.All, Has.Length.EqualTo(1));
            Assert.That(
                AuthoritativeArenaCatalog.All.Select(value => value.Slug),
                Is.EquivalentTo(
                    new[] { AuthoritativeArenaCatalog.NeonServiceArcadeSlug }
                )
            );

            foreach (
                AuthoritativeArenaDefinition definition in AuthoritativeArenaCatalog.All
            )
            {
                var available = new AvailableMapSnapshot
                {
                    map_version_id =
                        "0199abc1-2345-7abc-8def-0123456789ab",
                    map_slug = definition.Slug,
                    display_name = definition.DisplayName,
                    description = definition.Description,
                    content_version = definition.ContentVersion,
                    authority_geometry_version =
                        definition.AuthorityGeometryVersion,
                    authority_geometry_digest =
                        definition.AuthorityGeometryDigest,
                    recommended_minimum_players = 2,
                    recommended_maximum_players = 10,
                };
                var round = new RoundSnapshot
                {
                    id = "0199abc1-2345-7abc-9def-0123456789ac",
                    map_version_id = available.map_version_id,
                    map_slug = definition.Slug,
                    map_display_name = definition.DisplayName,
                    map_content_version = definition.ContentVersion,
                    game_server_build_version =
                        LobbyMenuRules.SupportedGameServerBuildVersion,
                    protocol_version = LobbyMenuRules.SupportedProtocolVersion,
                    authority_geometry_version =
                        definition.AuthorityGeometryVersion,
                    authority_geometry_digest =
                        definition.AuthorityGeometryDigest,
                    status = "hunting",
                };

                Assert.That(AuthoritativeArenaCatalog.Supports(available), Is.True);
                Assert.That(
                    AuthoritativeArenaCatalog.TryResolve(round, out var resolved),
                    Is.True
                );
                Assert.That(resolved, Is.SameAs(definition));
                Assert.That(LobbyMenuRules.IsGameplayRound(round), Is.True);
            }
        }

        [UnityTest]
        public IEnumerator BundledCandidatesContainRenderableGeometryCollisionAndSpawns()
        {
            ArenaExpectation[] expectations =
            {
                new ArenaExpectation(
                    "Maps/NeonServiceArcade/HC_NeonServiceArcade",
                    BundledArenaId.NeonServiceArcade,
                    "Neon Service Arcade",
                    2,
                    6,
                    2,
                    6,
                    "COL_WorkshopPanelRack",
                    new Vector3(8.5f, 0.9f, 7.15f)
                ),
            };

            foreach (ArenaExpectation expectation in expectations)
            {
                GameObject prefab = Resources.Load<GameObject>(
                    expectation.ResourcePath
                );
                Assert.That(
                    prefab,
                    Is.Not.Null,
                    $"{expectation.DisplayName} must be loadable from Resources."
                );

                GameObject instance = Object.Instantiate(prefab);
                yield return null;

                try
                {
                    BundledArenaCandidate arena =
                        instance.GetComponent<BundledArenaCandidate>();
                    Assert.That(arena, Is.Not.Null);
                    Assert.That(arena.ArenaId, Is.EqualTo(expectation.Id));
                    Assert.That(arena.DisplayName, Is.EqualTo(expectation.DisplayName));
                    Assert.That(
                        arena.RecommendedMinimumPlayers,
                        Is.EqualTo(expectation.MinimumPlayers)
                    );
                    Assert.That(
                        arena.RecommendedMaximumPlayers,
                        Is.EqualTo(expectation.MaximumPlayers)
                    );
                    Assert.That(
                        arena.HunterSpawnCount,
                        Is.EqualTo(expectation.HunterSpawnCount)
                    );
                    Assert.That(
                        arena.HiderSpawnCount,
                        Is.EqualTo(expectation.HiderSpawnCount)
                    );

                    Vector3[] hunterSpawns = Enumerable
                        .Range(0, arena.HunterSpawnCount)
                        .Select(arena.HunterSpawn)
                        .ToArray();
                    Vector3[] hiderSpawns = Enumerable
                        .Range(0, arena.HiderSpawnCount)
                        .Select(arena.HiderSpawn)
                        .ToArray();
                    Assert.That(hunterSpawns.Distinct().Count(), Is.EqualTo(hunterSpawns.Length));
                    Assert.That(hiderSpawns.Distinct().Count(), Is.EqualTo(hiderSpawns.Length));
                    Assert.That(
                        Vector3.Distance(arena.LocalHunterSpawn, arena.LocalHiderSpawn),
                        Is.GreaterThan(1f)
                    );

                    Physics.SyncTransforms();
                    for (int index = 0; index < hunterSpawns.Length; index++)
                    {
                        AssertSpawnSafety(
                            expectation.DisplayName,
                            "Hunter",
                            index,
                            hunterSpawns[index]
                        );
                    }
                    for (int index = 0; index < hiderSpawns.Length; index++)
                    {
                        AssertSpawnSafety(
                            expectation.DisplayName,
                            "Hider",
                            index,
                            hiderSpawns[index]
                        );
                    }

                    Transform visual = instance.transform.Find("Visual");
                    Transform collision = instance.transform.Find("Collision");
                    Transform gameplay = instance.transform.Find("Gameplay");
                    Assert.That(visual, Is.Not.Null);
                    Assert.That(collision, Is.Not.Null);
                    Assert.That(gameplay, Is.Not.Null);
                    Assert.That(visual.localScale, Is.EqualTo(collision.localScale));

                    Transform authorityAnchor = collision
                        .GetComponentsInChildren<Transform>(true)
                        .SingleOrDefault(
                            value => value.name == expectation.AuthorityAnchorName
                        );
                    Assert.That(
                        authorityAnchor,
                        Is.Not.Null,
                        $"{expectation.DisplayName} must contain its authority-space anchor."
                    );
                    Assert.That(
                        Vector3.Distance(
                            authorityAnchor.position,
                            expectation.AuthorityAnchorPosition
                        ),
                        Is.LessThan(0.001f),
                        $"{expectation.DisplayName} FBX geometry is mirrored away from authority space."
                    );

                    Renderer[] visualRenderers =
                        visual.GetComponentsInChildren<Renderer>(true);
                    Assert.That(
                        visualRenderers.Length,
                        Is.GreaterThan(500),
                        $"{expectation.DisplayName} must contain the supplied detailed environment."
                    );
                    Assert.That(visualRenderers.All(renderer => renderer.enabled), Is.True);
                    Material[] visualMaterials = visualRenderers
                        .SelectMany(renderer => renderer.sharedMaterials)
                        .Where(material => material != null)
                        .Distinct()
                        .ToArray();
                    Assert.That(
                        visualMaterials.Count(material => material.mainTexture != null),
                        Is.GreaterThan(10),
                        "The supplied Blender textures must remain bound after model import."
                    );
                    Assert.That(
                        visual.GetComponentsInChildren<Collider>(true),
                        Is.Empty,
                        "Visual FBX geometry must never create duplicate physics surfaces."
                    );

                    MeshCollider[] collisionMeshes =
                        collision.GetComponentsInChildren<MeshCollider>(true);
                    Assert.That(
                        collisionMeshes.Length,
                        Is.GreaterThan(10),
                        $"{expectation.DisplayName} must contain authored traversal collision."
                    );
                    Assert.That(
                        collisionMeshes.All(
                            collider =>
                                collider.enabled
                                && !collider.convex
                                && collider.sharedMesh != null
                        ),
                        Is.True
                    );
                    Assert.That(
                        collision
                            .GetComponentsInChildren<Renderer>(true)
                            .All(renderer => !renderer.enabled),
                        Is.True,
                        "Collision-only FBX geometry must stay invisible."
                    );
                    Assert.That(
                        instance.GetComponentsInChildren<CamouflagedPlayerAvatar>(true),
                        Is.Empty,
                        "Map art must not contain player targets."
                    );
                }
                finally
                {
                    Object.Destroy(instance);
                }

                yield return null;
            }
        }

        private static void AssertSpawnSafety(
            string arenaName,
            string role,
            int index,
            Vector3 position
        )
        {
            const float playerRadius = 0.38f;
            const float playerHeight = 1.90f;
            const float clearanceRadius = playerRadius + 0.08f + 0.10f;
            Vector3 clearanceBottom =
                position + Vector3.up * (clearanceRadius + 0.12f);
            Vector3 clearanceTop =
                position + Vector3.up * (playerHeight - clearanceRadius);
            Collider[] clearanceOverlaps = Physics.OverlapCapsule(
                clearanceBottom,
                clearanceTop,
                clearanceRadius,
                Physics.AllLayers,
                QueryTriggerInteraction.Ignore
            );
            Assert.That(
                clearanceOverlaps,
                Is.Empty,
                $"{arenaName} {role} spawn {index} lacks collider safety clearance: "
                    + string.Join(", ", clearanceOverlaps.Select(value => value.name))
            );

            Vector3 sweepBottom =
                position + Vector3.up * (playerRadius + 0.12f);
            Vector3 sweepTop = position + Vector3.up * (playerHeight - playerRadius);
            int clearDirections = 0;
            const int directionCount = 16;
            for (int directionIndex = 0; directionIndex < directionCount; directionIndex++)
            {
                float angle = directionIndex * Mathf.PI * 2f / directionCount;
                var direction = new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle));
                if (
                    !Physics.CapsuleCast(
                        sweepBottom,
                        sweepTop,
                        playerRadius,
                        direction,
                        1.25f,
                        Physics.AllLayers,
                        QueryTriggerInteraction.Ignore
                    )
                )
                {
                    clearDirections++;
                }
            }
            Assert.That(
                clearDirections,
                Is.GreaterThanOrEqualTo(4),
                $"{arenaName} {role} spawn {index} does not have a safe exit route."
            );
        }

        private readonly struct ArenaExpectation
        {
            public ArenaExpectation(
                string resourcePath,
                BundledArenaId id,
                string displayName,
                int minimumPlayers,
                int maximumPlayers,
                int hunterSpawnCount,
                int hiderSpawnCount,
                string authorityAnchorName,
                Vector3 authorityAnchorPosition
            )
            {
                ResourcePath = resourcePath;
                Id = id;
                DisplayName = displayName;
                MinimumPlayers = minimumPlayers;
                MaximumPlayers = maximumPlayers;
                HunterSpawnCount = hunterSpawnCount;
                HiderSpawnCount = hiderSpawnCount;
                AuthorityAnchorName = authorityAnchorName;
                AuthorityAnchorPosition = authorityAnchorPosition;
            }

            public string ResourcePath { get; }

            public BundledArenaId Id { get; }

            public string DisplayName { get; }

            public int MinimumPlayers { get; }

            public int MaximumPlayers { get; }

            public int HunterSpawnCount { get; }

            public int HiderSpawnCount { get; }

            public string AuthorityAnchorName { get; }

            public Vector3 AuthorityAnchorPosition { get; }
        }
    }
}
