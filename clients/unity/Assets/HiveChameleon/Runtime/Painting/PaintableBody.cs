using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace HiveChameleon.Painting
{
    [Serializable]
    public sealed class PaintableRendererBinding
    {
        [SerializeField]
        private string rendererId = string.Empty;

        [SerializeField]
        private Renderer renderer;

        [SerializeField]
        private int materialIndex;

        [SerializeField]
        private PaintChannels allowedChannels = PaintChannels.All;

        [SerializeField]
        private bool wrapU = true;

        [SerializeField]
        private bool wrapV;

        public string RendererId => rendererId;
        public Renderer Renderer => renderer;
        public int MaterialIndex => materialIndex;
        public PaintChannels AllowedChannels => allowedChannels;
        public bool WrapU => wrapU;
        public bool WrapV => wrapV;

        public PaintableRendererBinding(
            string id,
            Renderer target,
            int targetMaterialIndex,
            PaintChannels channels,
            bool repeatsU,
            bool repeatsV
        )
        {
            rendererId = id ?? string.Empty;
            renderer = target;
            materialIndex = targetMaterialIndex;
            allowedChannels = channels;
            wrapU = repeatsU;
            wrapV = repeatsV;
        }
    }

    [Serializable]
    public sealed class SolidColorRendererBinding
    {
        [SerializeField]
        private Renderer renderer;

        [SerializeField]
        private int materialIndex;

        public Renderer Renderer => renderer;
        public int MaterialIndex => materialIndex;

        public SolidColorRendererBinding(Renderer target, int targetMaterialIndex)
        {
            renderer = target;
            materialIndex = targetMaterialIndex;
        }
    }

    public readonly struct PaintBodyHit
    {
        public string RendererId { get; }
        public Vector2 UV { get; }
        public Vector3 Point { get; }
        public Vector3 Normal { get; }

        public PaintBodyHit(
            string rendererId,
            Vector2 uv,
            Vector3 point,
            Vector3 normal
        )
        {
            RendererId = rendererId;
            UV = uv;
            Point = point;
            Normal = normal;
        }
    }

    /// <summary>
    /// A model-authored mapping from semantic body-part IDs to renderers. Runtime painting only
    /// uses this component, so changing the model means authoring a new mapping rather than
    /// changing gameplay, networking, or shader code.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class PaintableBody : MonoBehaviour
    {
        public const string StandardBodyId = "standard-humanoid-v1";
        public const int EditColliderLayer = 30;
        private const int AtlasPaddingPixels = 6;
        private const float ColliderRefreshInterval = 1f / 30f;
        private const float MaximumEmissionIntensity = 8f;

        [SerializeField]
        private string bodyId = StandardBodyId;

        [SerializeField]
        [Range(256, 1024)]
        private int atlasResolution = 512;

        [SerializeField]
        private PaintableRendererBinding[] paintableRenderers =
            Array.Empty<PaintableRendererBinding>();

        [SerializeField]
        private SolidColorRendererBinding[] accentRenderers =
            Array.Empty<SolidColorRendererBinding>();

        private readonly Dictionary<string, RuntimeBinding> _bindings =
            new Dictionary<string, RuntimeBinding>(StringComparer.Ordinal);
        private readonly List<PaintSurfaceProxy> _proxies =
            new List<PaintSurfaceProxy>();
        private readonly List<Mesh> _bakedMeshes = new List<Mesh>();
        private readonly List<Material> _runtimeMaterials = new List<Material>();

        private RenderTexture _baseAtlas;
        private RenderTexture _materialAtlas;
        private RenderTexture _emissionAtlas;
        private bool _hdrEmission;
        private Material _brushMaterial;
        private int _gridSize;
        private Color _initialBodyColor = Color.white;
        private Color _accentColor = Color.white;
        private Color _displayOverride = Color.white;
        private float _displayOverrideAmount;
        private float _nextColliderRefreshAt;
        private int _appliedStrokeCount;
        private bool _initialized;
        private bool _initializationFailed;
        private bool _editMode;
        private bool _xray;
        private PaintableBody _appearanceSource;
        private bool _ownsAtlases = true;

        public string BodyId => bodyId;
        public int AtlasResolution => atlasResolution;
        public int AppliedStrokeCount =>
            _appearanceSource == null
                ? _appliedStrokeCount
                : _appearanceSource.AppliedStrokeCount;
        public bool SharesAppearance => _appearanceSource != null;
        public Color PresentationOverrideColor => _displayOverride;
        public float PresentationOverrideAmount => _displayOverrideAmount;
        public Color InitialBodyColor => _initialBodyColor;
        public IReadOnlyList<PaintableRendererBinding> RendererBindings =>
            paintableRenderers;

        private sealed class RuntimeBinding
        {
            public PaintableRendererBinding Authoring;
            public RectInt Tile;
            public Material RuntimeMaterial;
        }

        public void ConfigureAuthoring(
            string id,
            PaintableRendererBinding[] rendererBindings,
            SolidColorRendererBinding[] colorBindings,
            int resolution = 512
        )
        {
            if (Application.isPlaying && _initialized)
            {
                throw new InvalidOperationException(
                    "Paintable body authoring cannot change after initialization."
                );
            }
            bodyId = string.IsNullOrWhiteSpace(id) ? StandardBodyId : id;
            paintableRenderers = rendererBindings ?? Array.Empty<PaintableRendererBinding>();
            accentRenderers = colorBindings ?? Array.Empty<SolidColorRendererBinding>();
            atlasResolution = NormalizeResolution(resolution);
        }

        public void SetAtlasResolutionBeforeInitialization(int resolution)
        {
            if (_initialized)
            {
                throw new InvalidOperationException(
                    "Atlas resolution must be selected before the body is initialized."
                );
            }
            atlasResolution = NormalizeResolution(resolution);
        }

        public void SetInitialColors(Color bodyLinear, Color accentLinear)
        {
            _initialBodyColor = PaintColorMath.ClampLinear(bodyLinear);
            _accentColor = PaintColorMath.ClampLinear(accentLinear);
            if (!EnsureInitialized())
            {
                return;
            }
            if (_appearanceSource == null && _appliedStrokeCount == 0)
            {
                ClearRenderTexture(_baseAtlas, _initialBodyColor);
            }
            ApplyAccentColor();
        }

        /// <summary>
        /// Reuses one authoritative atlas set for alternate presentations of the same player
        /// (for example, the hider and hunter role variants). Semantic renderer IDs, rather
        /// than hierarchy or material names, determine the mapping.
        /// </summary>
        public bool ShareAppearanceFrom(PaintableBody source)
        {
            if (source == null || source == this)
            {
                return false;
            }
            if (!EnsureInitialized() || !source.EnsureInitialized())
            {
                return false;
            }
            while (source._appearanceSource != null)
            {
                source = source._appearanceSource;
            }
            if (
                !string.Equals(bodyId, source.bodyId, StringComparison.Ordinal)
                || atlasResolution != source.atlasResolution
                || _bindings.Count != source._bindings.Count
            )
            {
                return false;
            }
            foreach (KeyValuePair<string, RuntimeBinding> pair in _bindings)
            {
                if (!source._bindings.ContainsKey(pair.Key))
                {
                    return false;
                }
            }

            if (_ownsAtlases)
            {
                ReleaseAtlas(_baseAtlas);
                ReleaseAtlas(_materialAtlas);
                ReleaseAtlas(_emissionAtlas);
            }
            _appearanceSource = source;
            _ownsAtlases = false;
            _baseAtlas = source._baseAtlas;
            _materialAtlas = source._materialAtlas;
            _emissionAtlas = source._emissionAtlas;
            _hdrEmission = source._hdrEmission;
            foreach (KeyValuePair<string, RuntimeBinding> pair in _bindings)
            {
                RuntimeBinding binding = pair.Value;
                binding.Tile = source._bindings[pair.Key].Tile;
                BindAtlasesAndTile(binding.RuntimeMaterial, binding.Tile);
            }
            return true;
        }

        public void SetPresentationOverride(Color linearColor, float amount)
        {
            if (!EnsureInitialized())
            {
                return;
            }
            _displayOverride = PaintColorMath.ClampLinear(linearColor);
            _displayOverrideAmount = Mathf.Clamp01(amount);
            ApplyPresentationProperties();
        }

        public void SetXRay(bool enabled)
        {
            if (!EnsureInitialized())
            {
                return;
            }
            _xray = enabled;
            ApplyPresentationProperties();
        }

        public void SetShadowPreview(bool enabled)
        {
            ShadowCastingMode mode =
                enabled ? ShadowCastingMode.On : ShadowCastingMode.Off;
            for (int index = 0; index < paintableRenderers.Length; index++)
            {
                Renderer renderer = paintableRenderers[index]?.Renderer;
                if (renderer != null)
                {
                    renderer.shadowCastingMode = mode;
                }
            }
        }

        public void EnterEditMode()
        {
            if (!EnsureInitialized())
            {
                return;
            }
            if (_editMode)
            {
                return;
            }
            _editMode = true;
            CreateEditProxies();
            RefreshEditColliders(true);
        }

        public void ExitEditMode()
        {
            _editMode = false;
            _xray = false;
            ApplyPresentationProperties();
            DestroyEditProxies();
        }

        public void RefreshEditColliders(bool force = false)
        {
            if (!_editMode || (!force && Time.unscaledTime < _nextColliderRefreshAt))
            {
                return;
            }
            _nextColliderRefreshAt = Time.unscaledTime + ColliderRefreshInterval;
            for (int index = 0; index < _proxies.Count; index++)
            {
                _proxies[index].RefreshCollider();
            }
            // MeshCollider replacement is deferred by PhysX unless transforms are synced.
            // Painting raycasts happen in this same frame, so make the refreshed skin visible
            // immediately instead of requiring the user to hold the brush for another tick.
            Physics.SyncTransforms();
        }

        public bool TryRaycast(
            Ray ray,
            float maximumDistance,
            out PaintBodyHit bodyHit
        )
        {
            bodyHit = default;
            if (!_editMode)
            {
                return false;
            }
            RefreshEditColliders();
            RaycastHit[] hits = Physics.RaycastAll(
                ray,
                maximumDistance,
                Physics.DefaultRaycastLayers,
                QueryTriggerInteraction.Ignore
            );
            Array.Sort(hits, (left, right) => left.distance.CompareTo(right.distance));
            for (int index = 0; index < hits.Length; index++)
            {
                PaintSurfaceProxy proxy = hits[index].collider.GetComponent<PaintSurfaceProxy>();
                if (proxy != null && proxy.Owner == this)
                {
                    bodyHit = new PaintBodyHit(
                        proxy.RendererId,
                        hits[index].textureCoord,
                        hits[index].point,
                        hits[index].normal
                    );
                    return true;
                }

                // The gameplay CharacterController lives on an ancestor of the visual body.
                // It is intentionally still enabled in normal play, but Paint Mode must look
                // through that owner's colliders to reach the temporary UV-aware paint proxy.
                // This remains scoped to this character and therefore cannot bypass map cover.
                Transform hitTransform = hits[index].collider.transform;
                if (
                    hitTransform.IsChildOf(transform)
                    || transform.IsChildOf(hitTransform)
                )
                {
                    continue;
                }

                // An opaque map collider in front of the local body remains authoritative even
                // in x-ray view. X-ray affects presentation only and cannot paint through walls.
                if (hits[index].collider.gameObject.layer != EditColliderLayer)
                {
                    return false;
                }
            }
            return false;
        }

        public bool ApplyStroke(
            string rendererId,
            IReadOnlyList<Vector2> points,
            float radius,
            float hardness,
            float opacity,
            PaintMaterialValues material,
            PaintChannels requestedChannels
        )
        {
            if (!EnsureInitialized())
            {
                return false;
            }
            if (_appearanceSource != null)
            {
                // The source receives replicated commands exactly once; this role variant sees
                // the same RenderTextures immediately.
                return false;
            }
            if (
                string.IsNullOrWhiteSpace(rendererId)
                || points == null
                || points.Count == 0
                || !_bindings.TryGetValue(rendererId, out RuntimeBinding binding)
            )
            {
                return false;
            }

            PaintChannels channels = requestedChannels & binding.Authoring.AllowedChannels;
            if (channels == PaintChannels.None)
            {
                return false;
            }
            PaintMaterialValues safe = material.Clamped();
            float safeRadius = Mathf.Clamp(radius, 0.005f, 0.25f);
            float safeHardness = Mathf.Clamp01(hardness);
            float safeOpacity = Mathf.Clamp01(opacity);
            for (int index = 0; index < points.Count; index++)
            {
                Vector2 uv = new Vector2(
                    Mathf.Clamp01(points[index].x),
                    Mathf.Clamp01(points[index].y)
                );
                DrawStampSet(
                    binding,
                    uv,
                    safeRadius,
                    safeHardness,
                    safeOpacity,
                    safe,
                    channels
                );
            }
            _appliedStrokeCount++;
            return true;
        }

        public void ResetPaint(PaintMaterialValues neutral)
        {
            if (!EnsureInitialized())
            {
                return;
            }
            if (_appearanceSource != null)
            {
                _appearanceSource.ResetPaint(neutral);
                return;
            }
            PaintMaterialValues value = neutral.Clamped();
            ClearRenderTexture(_baseAtlas, value.BaseColorLinear);
            ClearRenderTexture(
                _materialAtlas,
                new Color(value.Metallic, value.Roughness, 0f, 1f)
            );
            Color emission = value.EmissionColorLinear * value.EmissionIntensity;
            ClearRenderTexture(
                _emissionAtlas,
                new Color(emission.r, emission.g, emission.b, 1f)
            );
            _appliedStrokeCount = 0;
        }

        private static int NormalizeResolution(int resolution)
        {
            int normalized = Mathf.NextPowerOfTwo(Mathf.Clamp(resolution, 256, 1024));
            return Mathf.Clamp(normalized, 256, 1024);
        }

        private bool EnsureInitialized()
        {
            if (_initialized)
            {
                return true;
            }
            if (_initializationFailed)
            {
                return false;
            }
            if (paintableRenderers == null || paintableRenderers.Length == 0)
            {
                return FailInitialization(
                    $"Paintable body '{name}' has no authored renderer bindings."
                );
            }
            Shader bodyShader = Shader.Find("HiveChameleon/Painted Body");
            Shader brushShader = Shader.Find("Hidden/HiveChameleon/Paint Brush");
            if (bodyShader == null || brushShader == null)
            {
                return FailInitialization(
                    "Hive Chameleon paint shaders are unavailable."
                );
            }

            atlasResolution = NormalizeResolution(atlasResolution);
            _gridSize = Mathf.CeilToInt(Mathf.Sqrt(paintableRenderers.Length));
            _baseAtlas = CreateAtlas("Base color and mask", RenderTextureFormat.ARGB32);
            _materialAtlas = CreateAtlas("Metallic and roughness", RenderTextureFormat.ARGB32);
            _hdrEmission = SystemInfo.SupportsRenderTextureFormat(
                RenderTextureFormat.ARGBHalf
            );
            _emissionAtlas = CreateAtlas(
                "Emission",
                _hdrEmission ? RenderTextureFormat.ARGBHalf : RenderTextureFormat.ARGB32
            );
            ClearRenderTexture(
                _baseAtlas,
                new Color(
                    _initialBodyColor.r,
                    _initialBodyColor.g,
                    _initialBodyColor.b,
                    0f
                )
            );
            ClearRenderTexture(_materialAtlas, new Color(0f, 0.82f, 0f, 1f));
            ClearRenderTexture(_emissionAtlas, Color.clear);
            _brushMaterial = new Material(brushShader)
            {
                name = "HC Runtime Paint Brush",
                hideFlags = HideFlags.HideAndDontSave,
            };

            int tileSize = atlasResolution / _gridSize;
            _bindings.Clear();
            for (int index = 0; index < paintableRenderers.Length; index++)
            {
                PaintableRendererBinding authoring = paintableRenderers[index];
                ValidateAuthoringBinding(authoring, index);
                int column = index % _gridSize;
                int row = index / _gridSize;
                var tile = new RectInt(
                    column * tileSize,
                    row * tileSize,
                    tileSize,
                    tileSize
                );
                Material runtimeMaterial = new Material(bodyShader)
                {
                    name = $"HC Painted {authoring.RendererId}",
                    hideFlags = HideFlags.HideAndDontSave,
                };
                BindAtlasesAndTile(runtimeMaterial, tile);
                ReplaceMaterial(
                    authoring.Renderer,
                    authoring.MaterialIndex,
                    runtimeMaterial
                );
                _runtimeMaterials.Add(runtimeMaterial);
                _bindings.Add(
                    authoring.RendererId,
                    new RuntimeBinding
                    {
                        Authoring = authoring,
                        Tile = tile,
                        RuntimeMaterial = runtimeMaterial,
                    }
                );
            }
            _initialized = true;
            ApplyAccentColor();
            ApplyPresentationProperties();
            return true;
        }

        private bool FailInitialization(string message)
        {
            _initializationFailed = true;
            enabled = false;
            Debug.LogError($"{message} Painting was disabled for '{name}'.", this);
            return false;
        }

        private void BindAtlasesAndTile(Material runtimeMaterial, RectInt tile)
        {
            runtimeMaterial.SetTexture("_MainTex", _baseAtlas);
            runtimeMaterial.SetTexture("_MaterialMap", _materialAtlas);
            runtimeMaterial.SetTexture("_EmissionMap", _emissionAtlas);
            float usable = tile.width - AtlasPaddingPixels * 2f;
            runtimeMaterial.mainTextureScale = new Vector2(
                usable / atlasResolution,
                usable / atlasResolution
            );
            runtimeMaterial.mainTextureOffset = new Vector2(
                (tile.x + AtlasPaddingPixels) / (float)atlasResolution,
                (tile.y + AtlasPaddingPixels) / (float)atlasResolution
            );
        }

        private void ValidateAuthoringBinding(
            PaintableRendererBinding binding,
            int index
        )
        {
            if (
                binding == null
                || string.IsNullOrWhiteSpace(binding.RendererId)
                || binding.Renderer == null
                || binding.MaterialIndex < 0
                || binding.MaterialIndex >= binding.Renderer.sharedMaterials.Length
                || _bindings.ContainsKey(binding.RendererId)
            )
            {
                throw new InvalidOperationException(
                    $"Paintable renderer binding {index} on '{name}' is invalid."
                );
            }
        }

        private RenderTexture CreateAtlas(string label, RenderTextureFormat format)
        {
            var texture = new RenderTexture(
                atlasResolution,
                atlasResolution,
                0,
                format,
                RenderTextureReadWrite.Linear
            )
            {
                name = $"{name} // {label}",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp,
                useMipMap = false,
                autoGenerateMips = false,
                hideFlags = HideFlags.HideAndDontSave,
            };
            texture.Create();
            return texture;
        }

        private static void ClearRenderTexture(RenderTexture target, Color linearColor)
        {
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = target;
            GL.Clear(false, true, linearColor);
            RenderTexture.active = previous;
        }

        private static void ReplaceMaterial(
            Renderer renderer,
            int materialIndex,
            Material material
        )
        {
            Material[] materials = renderer.sharedMaterials;
            materials[materialIndex] = material;
            renderer.sharedMaterials = materials;
        }

        private void ApplyAccentColor()
        {
            var block = new MaterialPropertyBlock();
            for (int index = 0; index < accentRenderers.Length; index++)
            {
                SolidColorRendererBinding binding = accentRenderers[index];
                if (
                    binding == null
                    || binding.Renderer == null
                    || binding.MaterialIndex < 0
                    || binding.MaterialIndex >= binding.Renderer.sharedMaterials.Length
                )
                {
                    continue;
                }
                binding.Renderer.GetPropertyBlock(block, binding.MaterialIndex);
                block.SetColor("_Color", _accentColor);
                block.SetColor("_BaseColor", _accentColor);
                binding.Renderer.SetPropertyBlock(block, binding.MaterialIndex);
                block.Clear();
            }
        }

        private void ApplyPresentationProperties()
        {
            for (int index = 0; index < _runtimeMaterials.Count; index++)
            {
                Material material = _runtimeMaterials[index];
                material.SetColor("_OverrideColor", _displayOverride);
                material.SetFloat("_OverrideAmount", _displayOverrideAmount);
                material.SetFloat("_ZTest", _xray ? 8f : 4f);
                material.renderQueue = _xray ? 3990 : -1;
            }
        }

        private void DrawStampSet(
            RuntimeBinding binding,
            Vector2 uv,
            float radius,
            float hardness,
            float opacity,
            PaintMaterialValues material,
            PaintChannels channels
        )
        {
            var centers = new List<Vector2>(9) { uv };
            if (binding.Authoring.WrapU)
            {
                if (uv.x < radius)
                {
                    centers.Add(new Vector2(uv.x + 1f, uv.y));
                }
                if (uv.x > 1f - radius)
                {
                    centers.Add(new Vector2(uv.x - 1f, uv.y));
                }
            }
            if (binding.Authoring.WrapV)
            {
                int count = centers.Count;
                for (int index = 0; index < count; index++)
                {
                    Vector2 center = centers[index];
                    if (uv.y < radius)
                    {
                        centers.Add(new Vector2(center.x, center.y + 1f));
                    }
                    if (uv.y > 1f - radius)
                    {
                        centers.Add(new Vector2(center.x, center.y - 1f));
                    }
                }
            }

            for (int index = 0; index < centers.Count; index++)
            {
                Vector2 center = centers[index];
                if ((channels & PaintChannels.BaseColor) != 0)
                {
                    DrawStamp(
                        _baseAtlas,
                        binding.Tile,
                        center,
                        radius,
                        hardness,
                        opacity,
                        new Color(
                            material.BaseColorLinear.r,
                            material.BaseColorLinear.g,
                            material.BaseColorLinear.b,
                            1f
                        ),
                        (int)ColorWriteMask.All
                    );
                }
                PaintChannels materialChannels =
                    channels & (PaintChannels.Metallic | PaintChannels.Roughness);
                if (materialChannels != PaintChannels.None)
                {
                    ColorWriteMask writeMask = (ColorWriteMask)0;
                    if ((materialChannels & PaintChannels.Metallic) != 0)
                    {
                        writeMask |= ColorWriteMask.Red;
                    }
                    if ((materialChannels & PaintChannels.Roughness) != 0)
                    {
                        writeMask |= ColorWriteMask.Green;
                    }
                    DrawStamp(
                        _materialAtlas,
                        binding.Tile,
                        center,
                        radius,
                        hardness,
                        opacity,
                        new Color(material.Metallic, material.Roughness, 0f, 1f),
                        (int)writeMask
                    );
                }
                if ((channels & PaintChannels.Emission) != 0)
                {
                    float intensity = _hdrEmission
                        ? material.EmissionIntensity
                        : Mathf.Min(1f, material.EmissionIntensity);
                    Color emission = material.EmissionColorLinear * intensity;
                    DrawStamp(
                        _emissionAtlas,
                        binding.Tile,
                        center,
                        radius,
                        hardness,
                        opacity,
                        new Color(
                            emission.r,
                            emission.g,
                            emission.b,
                            1f
                        ),
                        (int)ColorWriteMask.All
                    );
                }
            }
        }

        private void DrawStamp(
            RenderTexture target,
            RectInt tile,
            Vector2 uv,
            float radius,
            float hardness,
            float opacity,
            Color value,
            int colorMask
        )
        {
            float usable = tile.width - AtlasPaddingPixels * 2f;
            Vector2 center = new Vector2(
                tile.x + AtlasPaddingPixels + uv.x * usable,
                tile.y + AtlasPaddingPixels + uv.y * usable
            );
            float radiusPixels = Mathf.Max(1f, radius * usable);
            Rect drawRect = new Rect(
                center.x - radiusPixels,
                center.y - radiusPixels,
                radiusPixels * 2f,
                radiusPixels * 2f
            );

            Rect tileRect = new Rect(tile.x, tile.y, tile.width, tile.height);
            Rect clippedRect = new Rect(
                Mathf.Max(drawRect.xMin, tileRect.xMin),
                Mathf.Max(drawRect.yMin, tileRect.yMin),
                Mathf.Min(drawRect.xMax, tileRect.xMax)
                    - Mathf.Max(drawRect.xMin, tileRect.xMin),
                Mathf.Min(drawRect.yMax, tileRect.yMax)
                    - Mathf.Max(drawRect.yMin, tileRect.yMin)
            );
            if (clippedRect.width <= 0f || clippedRect.height <= 0f)
            {
                return;
            }
            Rect brushUv = new Rect(
                (clippedRect.x - drawRect.x) / drawRect.width,
                (clippedRect.y - drawRect.y) / drawRect.height,
                clippedRect.width / drawRect.width,
                clippedRect.height / drawRect.height
            );

            _brushMaterial.SetColor("_BrushValue", value);
            _brushMaterial.SetFloat("_Opacity", opacity);
            _brushMaterial.SetFloat("_Hardness", hardness);
            _brushMaterial.SetInt("_ColorMask", colorMask);
            RenderTexture previous = RenderTexture.active;
            Graphics.SetRenderTarget(target);
            GL.PushMatrix();
            GL.LoadPixelMatrix(0f, target.width, 0f, target.height);
            Graphics.DrawTexture(
                clippedRect,
                Texture2D.whiteTexture,
                brushUv,
                0,
                0,
                0,
                0,
                Color.white,
                _brushMaterial
            );
            GL.PopMatrix();
            RenderTexture.active = previous;
        }

        private void CreateEditProxies()
        {
            DestroyEditProxies();
            for (int index = 0; index < paintableRenderers.Length; index++)
            {
                PaintableRendererBinding binding = paintableRenderers[index];
                var proxyObject = new GameObject($"Paint surface // {binding.RendererId}");
                proxyObject.hideFlags = HideFlags.HideAndDontSave;
                proxyObject.layer = EditColliderLayer;
                proxyObject.transform.SetParent(binding.Renderer.transform, false);
                var proxy = proxyObject.AddComponent<PaintSurfaceProxy>();
                var collider = proxyObject.AddComponent<MeshCollider>();
                collider.convex = false;
                collider.isTrigger = false;
                var bakedMesh = new Mesh
                {
                    name = $"{name} // {binding.RendererId} paint collider",
                    hideFlags = HideFlags.HideAndDontSave,
                };
                proxy.Configure(this, binding.RendererId, binding.Renderer, collider, bakedMesh);
                _proxies.Add(proxy);
                _bakedMeshes.Add(bakedMesh);
            }
        }

        private void DestroyEditProxies()
        {
            for (int index = 0; index < _proxies.Count; index++)
            {
                if (_proxies[index] != null)
                {
                    Destroy(_proxies[index].gameObject);
                }
            }
            for (int index = 0; index < _bakedMeshes.Count; index++)
            {
                if (_bakedMeshes[index] != null)
                {
                    Destroy(_bakedMeshes[index]);
                }
            }
            _proxies.Clear();
            _bakedMeshes.Clear();
        }

        private void OnDestroy()
        {
            DestroyEditProxies();
            for (int index = 0; index < _runtimeMaterials.Count; index++)
            {
                if (_runtimeMaterials[index] != null)
                {
                    Destroy(_runtimeMaterials[index]);
                }
            }
            _runtimeMaterials.Clear();
            if (_brushMaterial != null)
            {
                Destroy(_brushMaterial);
            }
            if (_ownsAtlases)
            {
                ReleaseAtlas(_baseAtlas);
                ReleaseAtlas(_materialAtlas);
                ReleaseAtlas(_emissionAtlas);
            }
        }

        private static void ReleaseAtlas(RenderTexture texture)
        {
            if (texture == null)
            {
                return;
            }
            texture.Release();
            Destroy(texture);
        }
    }

    [DisallowMultipleComponent]
    internal sealed class PaintSurfaceProxy : MonoBehaviour
    {
        private Renderer _source;
        private MeshCollider _collider;
        private Mesh _mesh;

        public PaintableBody Owner { get; private set; }
        public string RendererId { get; private set; } = string.Empty;

        public void Configure(
            PaintableBody owner,
            string rendererId,
            Renderer source,
            MeshCollider targetCollider,
            Mesh mesh
        )
        {
            Owner = owner;
            RendererId = rendererId;
            _source = source;
            _collider = targetCollider;
            _mesh = mesh;
        }

        public void RefreshCollider()
        {
            if (_source == null || _collider == null || _mesh == null)
            {
                return;
            }
            _collider.sharedMesh = null;
            _mesh.Clear();
            if (_source is SkinnedMeshRenderer skinned)
            {
                skinned.BakeMesh(_mesh);
                // BakeMesh outputs vertices in renderer-local space with the renderer's scale
                // already applied. A child MeshCollider would apply that inherited scale again.
                // Cancel only the inherited world scale on the proxy so its surface stays
                // coincident with the visible skin for any imported model hierarchy.
                Vector3 lossyScale = skinned.transform.lossyScale;
                transform.localScale = new Vector3(
                    SafeInverse(lossyScale.x),
                    SafeInverse(lossyScale.y),
                    SafeInverse(lossyScale.z)
                );
            }
            else if (
                _source.TryGetComponent(out MeshFilter filter)
                && filter.sharedMesh != null
            )
            {
                _mesh.vertices = filter.sharedMesh.vertices;
                _mesh.normals = filter.sharedMesh.normals;
                _mesh.uv = filter.sharedMesh.uv;
                _mesh.triangles = filter.sharedMesh.triangles;
            }
            _collider.sharedMesh = _mesh;
        }

        private static float SafeInverse(float value)
        {
            return Mathf.Abs(value) < 0.000001f ? 1f : 1f / value;
        }
    }
}
