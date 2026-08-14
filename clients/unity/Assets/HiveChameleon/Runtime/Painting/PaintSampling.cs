using System;
using UnityEngine;

namespace HiveChameleon.Painting
{
    public readonly struct PaintSampleResult
    {
        public bool Available { get; }
        public string Source { get; }
        public string Status { get; }
        public PaintMaterialValues Material { get; }
        public PaintChannels AvailableChannels { get; }
        public bool IncludesLighting { get; }

        private PaintSampleResult(
            bool available,
            string source,
            string status,
            PaintMaterialValues material,
            PaintChannels channels,
            bool includesLighting
        )
        {
            Available = available;
            Source = source ?? string.Empty;
            Status = status ?? string.Empty;
            Material = material;
            AvailableChannels = channels;
            IncludesLighting = includesLighting;
        }

        public static PaintSampleResult Success(
            string source,
            PaintMaterialValues material,
            PaintChannels channels,
            bool includesLighting = false
        )
        {
            return new PaintSampleResult(
                true,
                source,
                string.Empty,
                material.Clamped(),
                channels,
                includesLighting
            );
        }

        public static PaintSampleResult Failure(string status)
        {
            return new PaintSampleResult(
                false,
                string.Empty,
                status,
                PaintMaterialValues.NeutralWhite,
                PaintChannels.None,
                false
            );
        }
    }

    /// <summary>
    /// Complex scene materials opt into exact pre-lighting sampling through this interface.
    /// Providers own terrain blending, decals, procedural shaders, and custom material data.
    /// </summary>
    public interface IPaintSampleProvider
    {
        bool TrySampleMaterial(
            RaycastHit hit,
            int regionSize,
            out PaintSampleResult result
        );
    }

    public sealed class PaintMaterialSampler : IDisposable
    {
        private readonly Material _textureSampleMaterial;
        private Texture2D _readback;

        public PaintMaterialSampler()
        {
            Shader shader = Shader.Find("Hidden/HiveChameleon/Texture Sample");
            if (shader == null)
            {
                throw new MissingReferenceException(
                    "The material-sampling shader is unavailable."
                );
            }
            _textureSampleMaterial = new Material(shader)
            {
                name = "HC Material Sample",
                hideFlags = HideFlags.HideAndDontSave,
            };
        }

        public PaintSampleResult Sample(
            Camera camera,
            Vector2 screenPoint,
            int regionSize,
            float maximumDistance = 30f
        )
        {
            if (camera == null)
            {
                return PaintSampleResult.Failure("Painting camera is unavailable.");
            }
            int region = NormalizeRegion(regionSize);
            Ray ray = camera.ScreenPointToRay(screenPoint);
            RaycastHit[] hits = Physics.RaycastAll(
                ray,
                maximumDistance,
                Physics.DefaultRaycastLayers,
                QueryTriggerInteraction.Ignore
            );
            Array.Sort(hits, (left, right) => left.distance.CompareTo(right.distance));
            for (int index = 0; index < hits.Length; index++)
            {
                RaycastHit hit = hits[index];
                if (
                    hit.collider.GetComponent<PaintSurfaceProxy>() != null
                    || hit.collider.GetComponentInParent<PaintableBody>() != null
                )
                {
                    continue;
                }

                MonoBehaviour[] providers =
                    hit.collider.GetComponentsInParent<MonoBehaviour>(true);
                for (int providerIndex = 0; providerIndex < providers.Length; providerIndex++)
                {
                    if (
                        providers[providerIndex] is IPaintSampleProvider provider
                        && provider.TrySampleMaterial(hit, region, out PaintSampleResult result)
                    )
                    {
                        return result;
                    }
                }

                return SampleStandardSurface(hit, region);
            }
            return PaintSampleResult.Failure("No sampleable map surface is under the cursor.");
        }

        private PaintSampleResult SampleStandardSurface(RaycastHit hit, int regionSize)
        {
            Renderer renderer =
                hit.collider.GetComponent<Renderer>()
                ?? hit.collider.GetComponentInParent<Renderer>();
            if (renderer == null)
            {
                return PaintSampleResult.Failure(
                    "That surface needs a material sample provider."
                );
            }

            int materialIndex = ResolveMaterialIndex(hit, renderer);
            Material[] materials = renderer.sharedMaterials;
            if (materialIndex < 0 || materialIndex >= materials.Length)
            {
                return PaintSampleResult.Failure(
                    "The surface material slot could not be resolved."
                );
            }
            Material material = materials[materialIndex];
            if (material == null)
            {
                return PaintSampleResult.Failure("That surface has no material.");
            }

            var propertyBlock = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(propertyBlock, materialIndex);
            int baseColorId = material.HasProperty("_BaseColor")
                ? Shader.PropertyToID("_BaseColor")
                : material.HasProperty("_Color")
                    ? Shader.PropertyToID("_Color")
                    : -1;
            if (baseColorId < 0)
            {
                return PaintSampleResult.Failure(
                    $"{material.name} needs a material sample provider."
                );
            }

            Color baseLinear = material.GetColor(baseColorId);
            if (propertyBlock.HasColor(baseColorId))
            {
                baseLinear = propertyBlock.GetColor(baseColorId);
            }

            int textureId = material.HasProperty("_BaseMap")
                ? Shader.PropertyToID("_BaseMap")
                : material.HasProperty("_MainTex")
                    ? Shader.PropertyToID("_MainTex")
                    : -1;
            if (textureId >= 0 && material.GetTexture(textureId) is Texture texture)
            {
                Vector2 scale = material.GetTextureScale(textureId);
                Vector2 offset = material.GetTextureOffset(textureId);
                Vector2 uv = Vector2.Scale(hit.textureCoord, scale) + offset;
                if (!TrySampleTexture(texture, uv, regionSize, out Color textureLinear))
                {
                    return PaintSampleResult.Failure(
                        $"{material.name} could not provide its base texture sample."
                    );
                }
                baseLinear = MultiplyLinear(baseLinear, textureLinear);
            }

            if (TrySampleVertexTint(hit, renderer, out Color vertexTintLinear))
            {
                baseLinear = MultiplyLinear(baseLinear, vertexTintLinear);
            }

            PaintMaterialValues values = PaintMaterialValues.NeutralWhite;
            values.BaseColorLinear = PaintColorMath.ClampLinear(baseLinear);
            PaintChannels channels = PaintChannels.BaseColor;

            if (material.HasProperty("_Metallic"))
            {
                values.Metallic = Mathf.Clamp01(material.GetFloat("_Metallic"));
                channels |= PaintChannels.Metallic;
            }
            if (material.HasProperty("_Smoothness"))
            {
                values.Roughness = 1f - Mathf.Clamp01(material.GetFloat("_Smoothness"));
                channels |= PaintChannels.Roughness;
            }
            else if (material.HasProperty("_Glossiness"))
            {
                values.Roughness = 1f - Mathf.Clamp01(material.GetFloat("_Glossiness"));
                channels |= PaintChannels.Roughness;
            }
            if (material.HasProperty("_EmissionColor"))
            {
                Color emission = material.GetColor("_EmissionColor");
                if (propertyBlock.HasColor(Shader.PropertyToID("_EmissionColor")))
                {
                    emission = propertyBlock.GetColor("_EmissionColor");
                }
                Color linearEmission = emission;
                float intensity = Mathf.Max(
                    linearEmission.r,
                    Mathf.Max(linearEmission.g, linearEmission.b)
                );
                values.EmissionIntensity = Mathf.Clamp(intensity, 0f, 8f);
                values.EmissionColorLinear =
                    intensity > 0.0001f ? linearEmission / intensity : Color.black;
                channels |= PaintChannels.Emission;
            }

            return PaintSampleResult.Success(material.name, values, channels);
        }

        private bool TrySampleTexture(
            Texture source,
            Vector2 uv,
            int regionSize,
            out Color linear
        )
        {
            linear = Color.white;
            if (source == null)
            {
                return false;
            }
            int region = NormalizeRegion(regionSize);
            RenderTexture target = RenderTexture.GetTemporary(
                region,
                region,
                0,
                RenderTextureFormat.ARGB32,
                RenderTextureReadWrite.Linear
            );
            RenderTexture previous = RenderTexture.active;
            try
            {
                _textureSampleMaterial.SetTexture("_SourceTex", source);
                _textureSampleMaterial.SetVector(
                    "_SampleUV",
                    new Vector4(Mathf.Repeat(uv.x, 1f), Mathf.Repeat(uv.y, 1f), 0f, 0f)
                );
                _textureSampleMaterial.SetInt("_RegionSize", region);
                Graphics.Blit(null, target, _textureSampleMaterial);
                RenderTexture.active = target;
                if (_readback == null || _readback.width != region)
                {
                    if (_readback != null)
                    {
                        UnityEngine.Object.Destroy(_readback);
                    }
                    _readback = new Texture2D(
                        region,
                        region,
                        TextureFormat.RGBA32,
                        false,
                        true
                    )
                    {
                        name = "HC Material Sample Readback",
                        hideFlags = HideFlags.HideAndDontSave,
                    };
                }
                _readback.ReadPixels(new Rect(0f, 0f, region, region), 0, 0, false);
                _readback.Apply(false, false);
                Color[] pixels = _readback.GetPixels();
                Color sum = Color.clear;
                for (int index = 0; index < pixels.Length; index++)
                {
                    sum += pixels[index];
                }
                linear = sum / Mathf.Max(1, pixels.Length);
                linear.a = 1f;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
            }
        }

        private static int ResolveMaterialIndex(RaycastHit hit, Renderer renderer)
        {
            if (!(hit.collider is MeshCollider collider) || collider.sharedMesh == null)
            {
                return 0;
            }
            Mesh mesh = collider.sharedMesh;
            int triangleOffset = 0;
            for (int submesh = 0; submesh < mesh.subMeshCount; submesh++)
            {
                int triangleCount = (int)mesh.GetIndexCount(submesh) / 3;
                if (hit.triangleIndex < triangleOffset + triangleCount)
                {
                    return Mathf.Min(submesh, renderer.sharedMaterials.Length - 1);
                }
                triangleOffset += triangleCount;
            }
            return 0;
        }

        private static bool TrySampleVertexTint(
            RaycastHit hit,
            Renderer renderer,
            out Color tintLinear
        )
        {
            tintLinear = Color.white;
            if (!(hit.collider is MeshCollider collider) || collider.sharedMesh == null)
            {
                return false;
            }
            try
            {
                Mesh mesh = collider.sharedMesh;
                Color[] colors = mesh.colors;
                int[] triangles = mesh.triangles;
                int triangle = hit.triangleIndex * 3;
                if (
                    colors == null
                    || colors.Length != mesh.vertexCount
                    || triangle < 0
                    || triangle + 2 >= triangles.Length
                )
                {
                    return false;
                }
                Vector3 barycentric = hit.barycentricCoordinate;
                Color linearTint =
                    colors[triangles[triangle]] * barycentric.x
                    + colors[triangles[triangle + 1]] * barycentric.y
                    + colors[triangles[triangle + 2]] * barycentric.z;
                tintLinear = linearTint;
                return true;
            }
            catch (UnityException)
            {
                return false;
            }
        }

        private static Color MultiplyLinear(Color left, Color right)
        {
            return new Color(
                left.r * right.r,
                left.g * right.g,
                left.b * right.b,
                left.a * right.a
            );
        }

        private static int NormalizeRegion(int requested)
        {
            return requested >= 5 ? 5 : requested >= 3 ? 3 : 1;
        }

        public void Dispose()
        {
            if (_textureSampleMaterial != null)
            {
                UnityEngine.Object.Destroy(_textureSampleMaterial);
            }
            if (_readback != null)
            {
                UnityEngine.Object.Destroy(_readback);
            }
        }
    }

    public sealed class PaintRenderedColorSampler : IDisposable
    {
        private Camera _samplingCamera;
        private Texture2D _readback;

        public PaintSampleResult Sample(
            Camera sourceCamera,
            Vector2 screenPoint,
            RenderedSampleRegion region,
            GameObject localBody
        )
        {
            if (sourceCamera == null || Screen.width < 1 || Screen.height < 1)
            {
                return PaintSampleResult.Failure("Rendered sampling is unavailable.");
            }
            EnsureCamera();
            int size = (int)region;
            RenderTexture target = RenderTexture.GetTemporary(
                Screen.width,
                Screen.height,
                24,
                RenderTextureFormat.ARGB32,
                RenderTextureReadWrite.sRGB
            );
            bool bodyWasActive = localBody != null && localBody.activeSelf;
            try
            {
                _samplingCamera.CopyFrom(sourceCamera);
                _samplingCamera.transform.SetPositionAndRotation(
                    sourceCamera.transform.position,
                    sourceCamera.transform.rotation
                );
                _samplingCamera.enabled = false;
                _samplingCamera.targetTexture = target;
                _samplingCamera.cullingMask &= ~(1 << PaintableBody.EditColliderLayer);
                if (bodyWasActive)
                {
                    localBody.SetActive(false);
                }
                _samplingCamera.Render();
                if (bodyWasActive)
                {
                    localBody.SetActive(true);
                }

                int startX = Mathf.Clamp(
                    Mathf.RoundToInt(screenPoint.x) - size / 2,
                    0,
                    Mathf.Max(0, Screen.width - size)
                );
                int startY = Mathf.Clamp(
                    Mathf.RoundToInt(screenPoint.y) - size / 2,
                    0,
                    Mathf.Max(0, Screen.height - size)
                );
                if (_readback == null || _readback.width != size)
                {
                    if (_readback != null)
                    {
                        UnityEngine.Object.Destroy(_readback);
                    }
                    _readback = new Texture2D(
                        size,
                        size,
                        TextureFormat.RGBA32,
                        false,
                        true
                    )
                    {
                        name = "HC Rendered Color Sample",
                        hideFlags = HideFlags.HideAndDontSave,
                    };
                }
                RenderTexture previous = RenderTexture.active;
                RenderTexture.active = target;
                _readback.ReadPixels(
                    new Rect(startX, startY, size, size),
                    0,
                    0,
                    false
                );
                _readback.Apply(false, false);
                RenderTexture.active = previous;

                Color[] pixels = _readback.GetPixels();
                Color srgb = Color.clear;
                for (int index = 0; index < pixels.Length; index++)
                {
                    srgb += pixels[index];
                }
                srgb /= Mathf.Max(1, pixels.Length);
                srgb.a = 1f;
                PaintMaterialValues values = PaintMaterialValues.NeutralWhite;
                values.BaseColorLinear = PaintColorMath.SrgbToLinear(srgb);
                return PaintSampleResult.Success(
                    $"Lit scene {size}×{size}",
                    values,
                    PaintChannels.BaseColor,
                    true
                );
            }
            catch (Exception)
            {
                if (bodyWasActive && localBody != null)
                {
                    localBody.SetActive(true);
                }
                return PaintSampleResult.Failure(
                    "The rendered scene could not be sampled on this device."
                );
            }
            finally
            {
                _samplingCamera.targetTexture = null;
                RenderTexture.ReleaseTemporary(target);
            }
        }

        private void EnsureCamera()
        {
            if (_samplingCamera != null)
            {
                return;
            }
            var cameraObject = new GameObject("Rendered Color Sampler")
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            _samplingCamera = cameraObject.AddComponent<Camera>();
            _samplingCamera.enabled = false;
        }

        public void Dispose()
        {
            if (_samplingCamera != null)
            {
                UnityEngine.Object.Destroy(_samplingCamera.gameObject);
            }
            if (_readback != null)
            {
                UnityEngine.Object.Destroy(_readback);
            }
        }
    }
}
