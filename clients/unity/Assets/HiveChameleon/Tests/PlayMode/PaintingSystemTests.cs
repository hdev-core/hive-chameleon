using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using HiveChameleon.Painting;
using HiveChameleon.Presentation;
using HiveChameleon.Realtime;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class PaintingSystemTests
    {
        private const int NakamaInboundWebSocketLimitBytes = 4096;

        [Test]
        public void SourceOverOpacityIsPredictableAndCompounds()
        {
            Color oldColor = new Color(0.1f, 0.2f, 0.3f, 1f);
            Color brush = new Color(0.9f, 0.6f, 0.2f, 1f);

            Assert.That(PaintColorMath.SourceOver(oldColor, brush, 0f), Is.EqualTo(oldColor));
            Assert.That(PaintColorMath.SourceOver(oldColor, brush, 1f), Is.EqualTo(brush));

            Color half = PaintColorMath.SourceOver(oldColor, brush, 0.5f);
            Assert.That(half.r, Is.EqualTo(0.5f).Within(0.0001f));
            Assert.That(half.g, Is.EqualTo(0.4f).Within(0.0001f));
            Assert.That(half.b, Is.EqualTo(0.25f).Within(0.0001f));

            Color twice = PaintColorMath.SourceOver(half, brush, 0.5f);
            Assert.That(twice.r, Is.EqualTo(0.7f).Within(0.0001f));
            Assert.That(twice.g, Is.EqualTo(0.5f).Within(0.0001f));
            Assert.That(twice.b, Is.EqualTo(0.225f).Within(0.0001f));
        }

        [Test]
        public void SrgbHexRoundTripsWithoutDoubleGamma()
        {
            Assert.That(
                PaintColorMath.TryParseRgbaHex("7FA3C9BF", out Color linear),
                Is.True
            );
            Assert.That(PaintColorMath.ToRgbaHex(linear), Is.EqualTo("7FA3C9BF"));
        }

        [Test]
        public void RuntimePaintShadersAreIncludedInPlayerBuilds()
        {
            string graphicsSettings = File.ReadAllText(
                Path.Combine(
                    Application.dataPath,
                    "..",
                    "ProjectSettings",
                    "GraphicsSettings.asset"
                )
            );

            Assert.That(
                graphicsSettings,
                Does.Contain("1df25faf9e0634e99840a0dc7784c07d"),
                "The painted-body shader would be stripped from Shader.Find builds."
            );
            Assert.That(
                graphicsSettings,
                Does.Contain("c2ab9f93442f440d19137d0075a02d7b"),
                "The runtime brush shader would be stripped from Shader.Find builds."
            );
            Assert.That(
                graphicsSettings,
                Does.Contain("27209863bf2f04181a2cb85c76a50782"),
                "The material-sampling shader would be stripped from Shader.Find builds."
            );
        }

        [Test]
        public void MaterialChannelsRemainIndependent()
        {
            PaintMaterialValues oldValue = PaintMaterialValues.NeutralWhite;
            PaintMaterialValues brush = oldValue;
            brush.BaseColorLinear = Color.red;
            brush.Metallic = 1f;
            brush.Roughness = 0f;
            brush.EmissionColorLinear = Color.blue;
            brush.EmissionIntensity = 4f;

            PaintMaterialValues result = PaintMaterialValues.Blend(
                oldValue,
                brush,
                1f,
                PaintChannels.Metallic
            );
            Assert.That(result.BaseColorLinear, Is.EqualTo(oldValue.BaseColorLinear));
            Assert.That(result.Metallic, Is.EqualTo(1f));
            Assert.That(result.Roughness, Is.EqualTo(oldValue.Roughness));
            Assert.That(result.EmissionIntensity, Is.EqualTo(0f));
        }

        [Test]
        public void MaximumUnityPaintCommandFitsNakamaWebSocketFrame()
        {
            var command = new PaintStrokeCommand
            {
                body_id = PaintableBody.StandardBodyId,
                renderer_id = "body.right-shoulder-cap",
                points = new PaintPoint[PlayerPaintMode.MaximumPointsPerCommand],
                radius = 0.24999999f,
                hardness = 0.87654321f,
                opacity = 0.76543218f,
                material = new PaintMaterialSnapshot
                {
                    base_r = 0.12345678f,
                    base_g = 0.87654321f,
                    base_b = 0.45678912f,
                    metallic = 0.3456789f,
                    roughness = 0.6543219f,
                    emission_r = 0.2345678f,
                    emission_g = 0.7654321f,
                    emission_b = 0.5678912f,
                    emission_intensity = 7.123456f,
                },
                channels = 15,
                client_sequence = long.MaxValue,
                client_tick = long.MaxValue,
            };
            for (int index = 0; index < command.points.Length; index++)
            {
                command.points[index] = new PaintPoint(
                    0.12345678f + index * 0.000001f,
                    0.87654321f - index * 0.000001f
                );
            }

            string payload = JsonUtility.ToJson(command);
            int payloadBytes = Encoding.UTF8.GetByteCount(payload);
            Assert.That(
                payloadBytes,
                Is.LessThanOrEqualTo(NakamaRealtimeConnection.MaximumPaintCommandJsonBytes),
                "The client-side guard would reject its own maximum paint chunk."
            );

            int wireBytes = MeasureNakamaMatchDataFrameBytes(payload);
            Assert.That(
                wireBytes,
                Is.LessThanOrEqualTo(NakamaInboundWebSocketLimitBytes - 512),
                "The paint frame needs at least 512 bytes of growth headroom before Nakama "
                    + "will close WebGL with 'websocket: read limit exceeded'."
            );
        }

        private static int MeasureNakamaMatchDataFrameBytes(string payload)
        {
            Assembly assembly = System.AppDomain.CurrentDomain
                .GetAssemblies()
                .First(candidate => candidate.GetType("Nakama.MatchSendMessage") != null);
            System.Type matchType = assembly.GetType("Nakama.MatchSendMessage", true);
            System.Type envelopeType = assembly.GetType("Nakama.WebSocketMessageEnvelope", true);
            System.Type writerType = assembly.GetType("Nakama.TinyJson.JsonWriter", true);
            object match = System.Activator.CreateInstance(matchType);
            matchType.GetProperty("MatchId").SetValue(
                match,
                "01234567-89ab-cdef-0123-456789abcdef."
            );
            matchType.GetProperty("OpCode").SetValue(match, "16");
            matchType.GetProperty("State").SetValue(
                match,
                System.Convert.ToBase64String(Encoding.UTF8.GetBytes(payload))
            );
            object envelope = System.Activator.CreateInstance(envelopeType);
            envelopeType.GetProperty("MatchStateSend").SetValue(envelope, match);
            MethodInfo toJson = writerType.GetMethod(
                "ToJson",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            );
            string frame = (string)toJson.Invoke(null, new[] { envelope });
            return Encoding.UTF8.GetByteCount(frame);
        }

        [UnityTest]
        public IEnumerator BundledHumanoidExposesSemanticPaintAndMotionContracts()
        {
            var parent = new GameObject("Paint test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Paintable Hider",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            HumanoidPresentationRig motion = hider.GetComponent<HumanoidPresentationRig>();
            Assert.That(body, Is.Not.Null);
            Assert.That(body.BodyId, Is.EqualTo(PaintableBody.StandardBodyId));
            Assert.That(body.RendererBindings.Count, Is.EqualTo(27));
            Assert.That(
                body.RendererBindings.Select(binding => binding.RendererId),
                Does.Contain("body.chest")
            );
            Assert.That(
                body.RendererBindings.Select(binding => binding.RendererId),
                Does.Contain("body.pelvis")
            );
            Assert.That(
                body.RendererBindings.Select(binding => binding.RendererId),
                Does.Contain("body.left-boot")
            );
            Assert.That(motion, Is.Not.Null);

            Transform leftLeg = motion.Bone(HumanBodyBones.LeftUpperLeg);
            Assert.That(leftLeg, Is.Not.Null);
            Quaternion bind = leftLeg.localRotation;
            motion.SetMotion(Vector3.forward * 6f, 9.5f, true, false, false, false, 0f);
            motion.EvaluateImmediately();
            Assert.That(Quaternion.Angle(bind, leftLeg.localRotation), Is.GreaterThan(0.01f));

            Object.Destroy(parent);
            yield return null;
        }

        [UnityTest]
        public IEnumerator HunterRifleIsBoundToAnimatedHand()
        {
            var parent = new GameObject("Hunter motion test root");
            GameObject hunter = HumanoidPlayerFactory.CreateHunter(
                "Animated Hunter",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            HumanoidPresentationRig rig = hunter.GetComponent<HumanoidPresentationRig>();
            Transform rifle = hunter
                .GetComponentsInChildren<Transform>(true)
                .First(transform => transform.name == "Hunter Rifle");
            Assert.That(rig, Is.Not.Null);
            Assert.That(rig.EquippedWeapon, Is.EqualTo(rifle));
            Assert.That(rifle.GetComponentInParent<HumanoidPresentationRig>(), Is.EqualTo(rig));

            Object.Destroy(parent);
            yield return null;
        }

        [UnityTest]
        public IEnumerator PaintRayIgnoresTheLocalGameplayCapsule()
        {
            var player = new GameObject("Player with gameplay capsule");
            CharacterController controller = player.AddComponent<CharacterController>();
            controller.center = new Vector3(0f, 0.95f, 0f);
            controller.height = 1.9f;
            controller.radius = 0.42f;
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Paintable Hider",
                player.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            body.EnterEditMode();
            body.RefreshEditColliders(true);
            Physics.SyncTransforms();

            bool paintedSurfaceReached = false;
            PaintBodyHit hit = default;
            MeshCollider[] paintColliders = hider
                .GetComponentsInChildren<Collider>(true)
                .Where(collider => collider.gameObject.layer == PaintableBody.EditColliderLayer)
                .OfType<MeshCollider>()
                .ToArray();
            Assert.That(paintColliders.Length, Is.EqualTo(body.RendererBindings.Count));
            foreach (MeshCollider collider in paintColliders)
            {
                Mesh mesh = collider.sharedMesh;
                if (mesh == null || mesh.triangles.Length < 3)
                {
                    continue;
                }
                int[] triangles = mesh.triangles;
                Vector3[] vertices = mesh.vertices;
                for (int triangle = 0; triangle < triangles.Length; triangle += 3)
                {
                    Vector3 a = vertices[triangles[triangle]];
                    Vector3 b = vertices[triangles[triangle + 1]];
                    Vector3 c = vertices[triangles[triangle + 2]];
                    Vector3 localNormal = Vector3.Cross(b - a, c - a).normalized;
                    Vector3 point = collider.transform.TransformPoint((a + b + c) / 3f);
                    Vector3 normal = collider.transform.TransformDirection(localNormal).normalized;
                    Ray ray = new Ray(point + normal * 4f, -normal);
                    if (body.TryRaycast(ray, 8f, out hit))
                    {
                        paintedSurfaceReached = true;
                        break;
                    }
                }
                if (paintedSurfaceReached)
                {
                    break;
                }
            }

            Assert.That(
                paintedSurfaceReached,
                Is.True,
                "The owning CharacterController must not hide the UV paint surface."
            );
            Assert.That(hit.RendererId, Is.Not.Empty);

            Object.Destroy(player);
            yield return null;
        }

        [UnityTest]
        public IEnumerator RuntimeBrushWritesColorIntoTheBodyAtlas()
        {
            var parent = new GameObject("Paint atlas test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Paintable Hider",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            PaintableRendererBinding binding = body.RendererBindings.First();
            var material = PaintMaterialValues.NeutralWhite;
            material.BaseColorLinear = Color.red;
            Assert.That(
                body.ApplyStroke(
                    binding.RendererId,
                    new[] { new Vector2(0.5f, 0.5f) },
                    0.12f,
                    1f,
                    1f,
                    material,
                    PaintChannels.BaseColor
                ),
                Is.True
            );
            yield return null;

            FieldInfo atlasField = typeof(PaintableBody).GetField(
                "_baseAtlas",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            RenderTexture atlas = (RenderTexture)atlasField.GetValue(body);
            int grid = Mathf.CeilToInt(Mathf.Sqrt(body.RendererBindings.Count));
            int tileSize = atlas.width / grid;
            int tileCenter = tileSize / 2;
            var pixel = new Texture2D(atlas.width, atlas.height, TextureFormat.RGBA32, false, true);
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = atlas;
            pixel.ReadPixels(new Rect(0f, 0f, atlas.width, atlas.height), 0, 0);
            pixel.Apply(false, false);
            RenderTexture.active = previous;
            Color painted = pixel.GetPixel(tileCenter, tileCenter);

            // Linear render-target readback can be quantized/converted by the active graphics
            // backend; red dominance plus near-zero green/blue proves the stamp replaced white.
            Assert.That(painted.r, Is.GreaterThan(0.7f));
            Assert.That(painted.g, Is.LessThan(0.1f));
            Assert.That(painted.b, Is.LessThan(0.1f));

            material.BaseColorLinear = Color.blue;
            Assert.That(
                body.ApplyStroke(
                    binding.RendererId,
                    new[] { new Vector2(0.75f, 0.75f) },
                    0.08f,
                    1f,
                    1f,
                    material,
                    PaintChannels.BaseColor
                ),
                Is.True
            );
            yield return null;
            RenderTexture.active = atlas;
            pixel.ReadPixels(new Rect(0f, 0f, atlas.width, atlas.height), 0, 0);
            pixel.Apply(false, false);
            RenderTexture.active = previous;
            Color retainedRed = pixel.GetPixel(tileCenter, tileCenter);
            int blueCenter = Mathf.RoundToInt(6f + 0.75f * (tileSize - 12f));
            Color paintedBlue = pixel.GetPixel(blueCenter, blueCenter);
            Assert.That(
                retainedRed.r - Mathf.Max(retainedRed.g, retainedRed.b),
                Is.GreaterThan(0.5f),
                "A later stamp must not erase the earlier red stroke."
            );
            Assert.That(
                paintedBlue.b - Mathf.Max(paintedBlue.r, paintedBlue.g),
                Is.GreaterThan(0.5f),
                "The later blue stroke must also appear in the atlas."
            );

            Object.Destroy(pixel);
            Object.Destroy(parent);
            yield return null;
        }

        [UnityTest]
        public IEnumerator RuntimeBrushWritesAndRetainsColorInEveryBodyTile()
        {
            var root = new GameObject("Every paint tile test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Every Tile Hider",
                root.transform,
                Color.white,
                Color.white
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            var red = PaintMaterialValues.NeutralWhite;
            red.BaseColorLinear = Color.red;
            foreach (PaintableRendererBinding binding in body.RendererBindings)
            {
                Assert.That(
                    body.ApplyStroke(
                        binding.RendererId,
                        new[] { new Vector2(0.5f, 0.5f) },
                        0.14f,
                        1f,
                        1f,
                        red,
                        PaintChannels.BaseColor
                    ),
                    Is.True,
                    binding.RendererId
                );
            }
            yield return null;

            FieldInfo atlasField = typeof(PaintableBody).GetField(
                "_baseAtlas",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            RenderTexture atlas = (RenderTexture)atlasField.GetValue(body);
            int grid = Mathf.CeilToInt(Mathf.Sqrt(body.RendererBindings.Count));
            int tileSize = atlas.width / grid;
            int usableCenter = tileSize / 2;
            var pixels = new Texture2D(
                atlas.width,
                atlas.height,
                TextureFormat.RGBA32,
                false,
                true
            );
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = atlas;
            pixels.ReadPixels(new Rect(0f, 0f, atlas.width, atlas.height), 0, 0);
            pixels.Apply(false, false);
            RenderTexture.active = previous;
            for (int index = 0; index < body.RendererBindings.Count; index++)
            {
                int column = index % grid;
                int row = index / grid;
                Color painted = pixels.GetPixel(
                    column * tileSize + usableCenter,
                    row * tileSize + usableCenter
                );
                Assert.That(
                    painted.r,
                    Is.GreaterThan(painted.g + 0.5f),
                    body.RendererBindings[index].RendererId
                );
                Assert.That(
                    painted.r,
                    Is.GreaterThan(painted.b + 0.5f),
                    body.RendererBindings[index].RendererId
                );
            }

            Object.Destroy(pixels);
            Object.Destroy(root);
            yield return null;
        }

        [UnityTest]
        public IEnumerator EveryHumanoidSurfaceHasAWorkingUvPaintCollider()
        {
            var root = new GameObject("Every paint surface test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Every Surface Hider",
                root.transform,
                Color.white,
                Color.white
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            body.EnterEditMode();
            body.RefreshEditColliders(true);
            Physics.SyncTransforms();
            MeshCollider[] colliders = hider
                .GetComponentsInChildren<MeshCollider>(true)
                .Where(collider => collider.gameObject.layer == PaintableBody.EditColliderLayer)
                .ToArray();
            Assert.That(colliders.Length, Is.EqualTo(27));

            foreach (MeshCollider collider in colliders)
            {
                Mesh mesh = collider.sharedMesh;
                Assert.That(mesh, Is.Not.Null, collider.name);
                Assert.That(mesh.triangles.Length, Is.GreaterThanOrEqualTo(3), collider.name);
                Assert.That(mesh.uv.Length, Is.EqualTo(mesh.vertexCount), collider.name);
                bool hitSurface = false;
                int[] triangles = mesh.triangles;
                Vector3[] vertices = mesh.vertices;
                for (int triangle = 0; triangle < triangles.Length; triangle += 3)
                {
                    Vector3 a = vertices[triangles[triangle]];
                    Vector3 b = vertices[triangles[triangle + 1]];
                    Vector3 c = vertices[triangles[triangle + 2]];
                    Vector3 normal = Vector3.Cross(b - a, c - a).normalized;
                    if (normal.sqrMagnitude < 0.5f)
                    {
                        continue;
                    }
                    Vector3 center = collider.transform.TransformPoint((a + b + c) / 3f);
                    Vector3 worldNormal = collider.transform.TransformDirection(normal).normalized;
                    Ray ray = new Ray(center + worldNormal * 0.25f, -worldNormal);
                    if (!collider.Raycast(ray, out RaycastHit hit, 0.5f))
                    {
                        continue;
                    }
                    Assert.That(hit.textureCoord.x, Is.InRange(0f, 1f), collider.name);
                    Assert.That(hit.textureCoord.y, Is.InRange(0f, 1f), collider.name);
                    hitSurface = true;
                    break;
                }
                Assert.That(hitSurface, Is.True, $"No UV-aware ray reached {collider.name}.");
            }

            Object.Destroy(root);
            yield return null;
        }

        [UnityTest]
        public IEnumerator PaintModeCameraRayReachesTheVisibleHumanoid()
        {
            var player = new GameObject("Paint camera test player");
            CharacterController controller = player.AddComponent<CharacterController>();
            controller.center = new Vector3(0f, 0.95f, 0f);
            controller.height = 1.9f;
            controller.radius = 0.42f;
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Paintable Hider",
                player.transform,
                Color.white,
                Color.cyan
            );
            var cameraObject = new GameObject("Paint camera");
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.enabled = false;
            camera.fieldOfView = 51f;
            Vector3 focus = player.transform.position + Vector3.up * 1.05f;
            Vector3 cameraPosition = focus + new Vector3(-0.42f, 0f, -2.7f);
            camera.transform.SetPositionAndRotation(
                cameraPosition,
                Quaternion.LookRotation(focus - cameraPosition, Vector3.up)
            );
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            body.EnterEditMode();
            body.RefreshEditColliders(true);
            Physics.SyncTransforms();

            MeshCollider[] exactCameraColliders = hider
                .GetComponentsInChildren<Collider>(true)
                .Where(collider => collider.gameObject.layer == PaintableBody.EditColliderLayer)
                .OfType<MeshCollider>()
                .ToArray();
            Assert.That(exactCameraColliders.Length, Is.GreaterThan(0));
            string boundsSummary = string.Join(
                "; ",
                exactCameraColliders
                    .Take(4)
                    .Select(collider => $"{collider.bounds.center}/{collider.bounds.size}")
            );
            Assert.That(
                exactCameraColliders.Max(collider => collider.bounds.size.magnitude),
                Is.LessThan(4f),
                $"Paint proxies must coincide with the roughly two-metre humanoid: {boundsSummary}"
            );

            PaintBodyHit firstHit = default;
            int reachableSamples = 0;
            for (int row = 1; row < 10; row++)
            {
                for (int column = 1; column < 10; column++)
                {
                    Ray ray = camera.ViewportPointToRay(
                        new Vector3(column / 10f, row / 10f, 0f)
                    );
                    if (!body.TryRaycast(ray, 8f, out PaintBodyHit hit))
                    {
                        continue;
                    }
                    if (reachableSamples == 0)
                    {
                        firstHit = hit;
                    }
                    reachableSamples++;
                }
            }

            Assert.That(
                reachableSamples,
                Is.GreaterThan(2),
                $"The exact Paint Mode camera must produce UV-aware body hits. "
                    + $"Camera={camera.transform.position}->{camera.transform.forward}; "
                    + $"colliders={boundsSummary}"
            );
            Assert.That(firstHit.RendererId, Is.Not.Empty);
            Assert.That(firstHit.UV.x, Is.InRange(0f, 1f));
            Assert.That(firstHit.UV.y, Is.InRange(0f, 1f));
            var brush = PaintMaterialValues.NeutralWhite;
            brush.BaseColorLinear = Color.red;
            Assert.That(
                body.ApplyStroke(
                    firstHit.RendererId,
                    new[] { firstHit.UV },
                    0.08f,
                    1f,
                    1f,
                    brush,
                    PaintChannels.BaseColor
                ),
                Is.True,
                "A hit from the live Paint Mode camera must be accepted by the atlas writer."
            );

            Object.Destroy(cameraObject);
            Object.Destroy(player);
            yield return null;
        }

        [UnityTest]
        public IEnumerator PaintedBodyShaderDisplaysRuntimePaintOnTheHumanoid()
        {
            const int previewSize = 512;
            var root = new GameObject("Paint render test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Paintable Hider",
                root.transform,
                Color.white,
                Color.cyan
            );
            var cameraObject = new GameObject("Paint render test camera");
            cameraObject.transform.SetPositionAndRotation(
                new Vector3(0f, 1.05f, -4f),
                Quaternion.identity
            );
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.enabled = false;
            camera.fieldOfView = 30f;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.025f, 0.025f, 0.025f, 1f);
            var target = new RenderTexture(
                previewSize,
                previewSize,
                24,
                RenderTextureFormat.ARGB32,
                RenderTextureReadWrite.Linear
            );
            target.Create();
            camera.targetTexture = target;

            var lightObject = new GameObject("Paint render test light");
            lightObject.transform.rotation = Quaternion.Euler(35f, -25f, 0f);
            Light light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.5f;
            yield return null;

            PaintableBody body = hider.GetComponent<PaintableBody>();
            var red = PaintMaterialValues.NeutralWhite;
            red.BaseColorLinear = Color.red;
            var fillPoints = new[]
            {
                new Vector2(0.1f, 0.1f), new Vector2(0.3f, 0.1f),
                new Vector2(0.5f, 0.1f), new Vector2(0.7f, 0.1f),
                new Vector2(0.9f, 0.1f), new Vector2(0.1f, 0.3f),
                new Vector2(0.3f, 0.3f), new Vector2(0.5f, 0.3f),
                new Vector2(0.7f, 0.3f), new Vector2(0.9f, 0.3f),
                new Vector2(0.1f, 0.5f), new Vector2(0.3f, 0.5f),
                new Vector2(0.5f, 0.5f), new Vector2(0.7f, 0.5f),
                new Vector2(0.9f, 0.5f), new Vector2(0.1f, 0.7f),
                new Vector2(0.3f, 0.7f), new Vector2(0.5f, 0.7f),
                new Vector2(0.7f, 0.7f), new Vector2(0.9f, 0.7f),
                new Vector2(0.1f, 0.9f), new Vector2(0.3f, 0.9f),
                new Vector2(0.5f, 0.9f), new Vector2(0.7f, 0.9f),
                new Vector2(0.9f, 0.9f),
            };
            foreach (PaintableRendererBinding binding in body.RendererBindings)
            {
                Assert.That(
                    body.ApplyStroke(
                        binding.RendererId,
                        fillPoints,
                        0.16f,
                        1f,
                        1f,
                        red,
                        PaintChannels.BaseColor
                    ),
                    Is.True
                );
            }
            yield return null;

            camera.Render();
            var pixels = new Texture2D(
                previewSize,
                previewSize,
                TextureFormat.RGBA32,
                false,
                true
            );
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0f, 0f, previewSize, previewSize), 0, 0);
            pixels.Apply(false, false);
            RenderTexture.active = previous;

            int redPixels = pixels
                .GetPixels32()
                .Count(pixel => pixel.r > pixel.g + 35 && pixel.r > pixel.b + 35);
            Assert.That(
                redPixels,
                Is.GreaterThan(1000),
                "The runtime atlas changed, but the actual humanoid shader did not display it."
            );

            string previewPath = Path.Combine(
                Application.temporaryCachePath,
                "hive-chameleon-painted-body.png"
            );
            File.WriteAllBytes(previewPath, pixels.EncodeToPNG());
            Debug.Log($"Painted humanoid render proof: {previewPath}");

            camera.targetTexture = null;
            Object.Destroy(pixels);
            target.Release();
            Object.Destroy(target);
            Object.Destroy(lightObject);
            Object.Destroy(cameraObject);
            Object.Destroy(root);
            yield return null;
        }

        [UnityTest]
        public IEnumerator RoleVariantsShareOneSemanticPaintAppearance()
        {
            var parent = new GameObject("Shared paint test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Shared Hider",
                parent.transform,
                Color.white,
                Color.cyan
            );
            GameObject hunter = HumanoidPlayerFactory.CreateHunter(
                "Shared Hunter",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            PaintableBody hiderBody = HumanoidPlayerFactory.PaintableBodyFor(hider);
            PaintableBody hunterBody = HumanoidPlayerFactory.PaintableBodyFor(hunter);
            Assert.That(
                HumanoidPlayerFactory.SharePaintAppearance(hider, hunter),
                Is.True
            );
            Assert.That(hunterBody.SharesAppearance, Is.True);
            Assert.That(hunterBody.BodyId, Is.EqualTo(hiderBody.BodyId));
            Assert.That(
                hunterBody.RendererBindings.Select(binding => binding.RendererId),
                Is.EquivalentTo(
                    hiderBody.RendererBindings.Select(binding => binding.RendererId)
                )
            );

            Object.Destroy(parent);
            yield return null;
        }
    }
}
