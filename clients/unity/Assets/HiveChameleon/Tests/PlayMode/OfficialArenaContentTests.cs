using System.Collections;
using System.Linq;
using HiveChameleon.Presentation;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class OfficialArenaContentTests
    {
        [UnityTest]
        public IEnumerator CityDistrictBuildsStaticTraversalSpaceWithoutPlayerProps()
        {
            var cameraObject = new GameObject("Test camera");
            cameraObject.tag = "MainCamera";
            cameraObject.AddComponent<Camera>();

            var lightObject = new GameObject("Test directional light");
            lightObject.AddComponent<Light>();

            var mapObject = new GameObject("Map under test");
            CityDistrictMap map = mapObject.AddComponent<CityDistrictMap>();
            yield return null;

            Assert.That(CityDistrictMap.OfficialSlug, Is.EqualTo("prism-foundry"));
            Assert.That(CityDistrictMap.ContentVersion, Is.EqualTo("m4-4"));
            Assert.That(
                CityDistrictMap.AuthorityGeometryVersion,
                Is.EqualTo("chroma-district-authority-proxy-1")
            );
            Assert.That(
                CityDistrictMap.AuthorityGeometryDigest,
                Does.StartWith("sha256:")
            );
            Assert.That(
                map.HiderSpawn(3),
                Is.EqualTo(new Vector3(-12.8f, 0.05f, 9.8f))
            );
            Assert.That(
                Vector3.Distance(map.LocalHunterSpawn, map.LocalHiderSpawn),
                Is.GreaterThan(1f),
                "Hunters and Hiders must enter the city from distinct starts."
            );
            Assert.That(
                map.HiderSpawn(0),
                Is.Not.EqualTo(map.HiderSpawn(1)),
                "The map must provide several character spawn positions."
            );
            Assert.That(
                map.GetComponentsInChildren<Collider>(true).Length,
                Is.GreaterThan(4),
                "The imported city and its boundaries must form a traversal space."
            );
            Assert.That(
                map.GetComponentsInChildren<CamouflagedPlayerAvatar>(true).Length,
                Is.Zero,
                "The map must not turn scenery into Hiders or own player targets."
            );
            Material[] cityMaterials = map
                .GetComponentsInChildren<Renderer>(true)
                .SelectMany(renderer => renderer.sharedMaterials)
                .Where(material => material != null)
                .Distinct()
                .ToArray();
            Assert.That(
                cityMaterials,
                Has.Some.Matches<Material>(
                    material =>
                        material.name == "HC_CitySurface"
                        && material.shader != null
                        && material.shader.name == "Standard"
                ),
                "The official city must use its clean Built-in renderer material."
            );

            Object.Destroy(mapObject);
            Object.Destroy(cameraObject);
            Object.Destroy(lightObject);
            yield return null;
        }

        [UnityTest]
        public IEnumerator PlayerAvatarOwnsTheOnlyTargetableHiderHitbox()
        {
            var avatarObject = new GameObject("Remote player");
            CamouflagedPlayerAvatar avatar =
                avatarObject.AddComponent<CamouflagedPlayerAvatar>();
            avatar.Configure(
                "player-hider",
                "Hider",
                "hider",
                Color.gray,
                Color.cyan,
                true
            );
            avatar.transform.position = new Vector3(0f, 0f, 5f);
            Physics.SyncTransforms();
            yield return null;

            CapsuleCollider[] hitboxes =
                avatar.GetComponentsInChildren<CapsuleCollider>(true);
            Assert.That(hitboxes, Has.Length.EqualTo(1));
            Assert.That(hitboxes[0].isTrigger, Is.True);
            Assert.That(hitboxes[0].enabled, Is.True);
            Assert.That(
                Physics.Raycast(
                    new Ray(new Vector3(0f, 1f, 0f), Vector3.forward),
                    out RaycastHit hit,
                    10f,
                    Physics.DefaultRaycastLayers,
                    QueryTriggerInteraction.Collide
                ),
                Is.True
            );
            Assert.That(
                hit.collider.GetComponentInParent<CamouflagedPlayerAvatar>().PlayerId,
                Is.EqualTo("player-hider")
            );

            avatar.SetFound(true);
            Assert.That(hitboxes[0].enabled, Is.False);
            avatar.SetFound(false);
            avatar.SetRole("hunter");
            Assert.That(hitboxes[0].enabled, Is.False);
            avatar.SetRole("hider");
            avatar.SetStatus("converted");
            Assert.That(hitboxes[0].enabled, Is.False);

            Object.Destroy(avatarObject);
            yield return null;
        }

        [UnityTest]
        public IEnumerator HumanoidPrefabsHaveHumanRigWeaponsAndNoArtColliders()
        {
            var parentObject = new GameObject("Character root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Hider under test",
                parentObject.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            string[] transformNames = hider
                .GetComponentsInChildren<Transform>(true)
                .Select(value => value.name)
                .ToArray();
            Assert.That(transformNames, Does.Contain("Head"));
            Assert.That(transformNames, Does.Contain("LeftHand"));
            Assert.That(transformNames, Does.Contain("RightHand"));
            Assert.That(transformNames, Does.Contain("LeftFoot"));
            Assert.That(transformNames, Does.Contain("RightFoot"));
            Renderer[] hiderRenderers = hider.GetComponentsInChildren<Renderer>();
            Assert.That(
                hiderRenderers.Length,
                Is.GreaterThanOrEqualTo(20),
                "The humanoid must retain a readable segmented silhouette."
            );
            Bounds hiderBounds = hiderRenderers[0].bounds;
            for (int index = 1; index < hiderRenderers.Length; index++)
            {
                hiderBounds.Encapsulate(hiderRenderers[index].bounds);
            }
            Assert.That(
                hiderBounds.size.y,
                Is.InRange(1.7f, 2.1f),
                "The humanoid must remain human-sized in the arena."
            );
            Assert.That(
                hider.GetComponentsInChildren<Collider>().Length,
                Is.Zero,
                "Character art must not interfere with arena raycasts."
            );

            GameObject hunter = HumanoidPlayerFactory.CreateHunter(
                "Hunter under test",
                parentObject.transform,
                Color.white,
                Color.cyan
            );
            GameObject rifle = HumanoidPlayerFactory.CreateFirstPersonRifle(
                "Rifle under test",
                parentObject.transform
            );
            yield return null;

            Assert.That(
                hunter.GetComponentsInChildren<Renderer>().Length,
                Is.GreaterThan(hider.GetComponentsInChildren<Renderer>().Length),
                "The hunter prefab must include the equipped rifle."
            );
            Transform equippedRifle = hunter
                .GetComponentsInChildren<Transform>(true)
                .Single(value => value.name == "Hunter Rifle");
            Assert.That(equippedRifle.localPosition, Is.EqualTo(Vector3.zero));
            Assert.That(
                equippedRifle.localScale,
                Is.EqualTo(Vector3.one),
                "The equipped rifle must retain the FBX import scale under the hand bone."
            );
            Assert.That(
                rifle.GetComponentsInChildren<Renderer>().Length,
                Is.GreaterThanOrEqualTo(8)
            );
            Assert.That(rifle.GetComponentsInChildren<Collider>().Length, Is.Zero);

            Object.Destroy(parentObject);
            yield return null;
        }
    }
}
