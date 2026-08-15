using System;
using System.Collections.Generic;
using System.Text;
using HiveChameleon.Painting;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    public static class HumanoidPlayerFactory
    {
        private const string HiderResource = "Characters/HC_Hider";
        private const string HunterResource = "Characters/HC_Hunter";
        private const string FirstPersonRifleResource = "Characters/HC_FirstPersonRifle";

        public static GameObject CreateHider(
            string name,
            Transform parent,
            Color bodyColor,
            Color accentColor
        )
        {
            GameObject avatar = Create(HiderResource, name, parent);
            ConfigurePresentation(avatar);
            ApplyColors(avatar, bodyColor, accentColor);
            RemoveArtColliders(avatar);
            return avatar;
        }

        public static GameObject CreateHunter(
            string name,
            Transform parent,
            Color bodyColor,
            Color accentColor
        )
        {
            GameObject avatar = Create(HunterResource, name, parent);
            ConfigurePresentation(avatar);
            ApplyColors(avatar, bodyColor, accentColor);
            RemoveArtColliders(avatar);
            return avatar;
        }

        public static GameObject CreateFirstPersonRifle(string name, Transform parent)
        {
            GameObject rifle = Create(FirstPersonRifleResource, name, parent);
            RemoveArtColliders(rifle);
            return rifle;
        }

        private static GameObject Create(string resourcePath, string name, Transform parent)
        {
            GameObject prefab = Resources.Load<GameObject>(resourcePath);
            if (prefab == null)
            {
                throw new MissingReferenceException(
                    $"Required presentation prefab is missing at Resources/{resourcePath}."
                );
            }

            GameObject instance = UnityEngine.Object.Instantiate(prefab, parent, false);
            instance.name = name;
            return instance;
        }

        public static void ApplyColors(
            GameObject avatar,
            Color bodyColor,
            Color accentColor
        )
        {
            if (avatar == null)
            {
                return;
            }

            PaintableBody paintableBody = avatar.GetComponent<PaintableBody>();
            if (paintableBody != null)
            {
                paintableBody.SetInitialColors(bodyColor, accentColor);
                return;
            }

            var block = new MaterialPropertyBlock();
            Renderer[] renderers = avatar.GetComponentsInChildren<Renderer>(true);
            for (int rendererIndex = 0; rendererIndex < renderers.Length; rendererIndex++)
            {
                Renderer renderer = renderers[rendererIndex];
                Material[] materials = renderer.sharedMaterials;
                for (int materialIndex = 0; materialIndex < materials.Length; materialIndex++)
                {
                    Material material = materials[materialIndex];
                    if (material == null)
                    {
                        continue;
                    }

                    Color color;
                    if (material.name.Contains("HC Body White"))
                    {
                        color = bodyColor;
                    }
                    else if (material.name.Contains("HC Player Color"))
                    {
                        color = accentColor;
                    }
                    else
                    {
                        continue;
                    }

                    renderer.GetPropertyBlock(block, materialIndex);
                    block.SetColor("_Color", color);
                    block.SetColor("_BaseColor", color);
                    renderer.SetPropertyBlock(block, materialIndex);
                    block.Clear();
                }
            }
        }

        public static PaintableBody PaintableBodyFor(GameObject avatar)
        {
            return avatar == null ? null : avatar.GetComponent<PaintableBody>();
        }

        public static bool SharePaintAppearance(
            GameObject sourceAvatar,
            GameObject roleVariant
        )
        {
            PaintableBody source = PaintableBodyFor(sourceAvatar);
            PaintableBody variant = PaintableBodyFor(roleVariant);
            return source != null
                && variant != null
                && variant.ShareAppearanceFrom(source);
        }

        public static HumanoidPresentationRig PresentationRigFor(GameObject avatar)
        {
            return avatar == null ? null : HumanoidPresentationRig.Bind(avatar);
        }

        public static void SetPresentationOverride(
            GameObject avatar,
            Color color,
            float amount
        )
        {
            PaintableBodyFor(avatar)?.SetPresentationOverride(color, amount);
        }

        private static void ConfigurePresentation(GameObject avatar)
        {
            HumanoidPresentationRig rig = HumanoidPresentationRig.Bind(avatar);
            PaintableBody existing = avatar.GetComponent<PaintableBody>();
            if (existing != null && existing.RendererBindings.Count > 0)
            {
                return;
            }

            var paintable = new List<PaintableRendererBinding>();
            var usedIds = new HashSet<string>(StringComparer.Ordinal);
            Renderer[] renderers = avatar.GetComponentsInChildren<Renderer>(true);
            for (int rendererIndex = 0; rendererIndex < renderers.Length; rendererIndex++)
            {
                Renderer renderer = renderers[rendererIndex];
                if (
                    !(renderer is SkinnedMeshRenderer)
                    || IsEquippedWeaponRenderer(renderer, rig)
                )
                {
                    continue;
                }
                Material[] materials = renderer.sharedMaterials;
                for (int materialIndex = 0; materialIndex < materials.Length; materialIndex++)
                {
                    Material material = materials[materialIndex];
                    if (material == null)
                    {
                        continue;
                    }
                    // A generated fallback maps every skinned humanoid surface, irrespective
                    // of material names. Replacement models can provide an authored
                    // PaintableBody mapping; equipped weapons remain deliberately excluded.
                    string rendererId = UniqueRendererId(renderer.name, usedIds);
                    paintable.Add(
                        new PaintableRendererBinding(
                            rendererId,
                            renderer,
                            materialIndex,
                            PaintChannels.All,
                            true,
                            false
                        )
                    );
                }
            }
            if (paintable.Count == 0)
            {
                throw new InvalidOperationException(
                    $"Character prefab '{avatar.name}' has no PaintableBody definition. "
                        + "Author a semantic renderer mapping before replacing the humanoid model."
                );
            }
            PaintableBody body = existing ?? avatar.AddComponent<PaintableBody>();
            body.ConfigureAuthoring(
                PaintableBody.StandardBodyId,
                paintable.ToArray(),
                Array.Empty<SolidColorRendererBinding>()
            );

            if (rig.EquippedWeapon != null)
            {
                rig.SetEquippedWeapon(rig.EquippedWeapon);
            }
        }

        private static bool IsEquippedWeaponRenderer(
            Renderer renderer,
            HumanoidPresentationRig rig
        )
        {
            if (renderer == null || rig?.EquippedWeapon == null)
            {
                return false;
            }
            Transform weapon = rig.EquippedWeapon;
            return renderer.transform == weapon || renderer.transform.IsChildOf(weapon);
        }

        private static string UniqueRendererId(
            string rendererName,
            HashSet<string> used
        )
        {
            var builder = new StringBuilder("body.");
            string source = rendererName ?? "surface";
            bool dash = false;
            for (int index = 0; index < source.Length; index++)
            {
                char value = char.ToLowerInvariant(source[index]);
                if (char.IsLetterOrDigit(value))
                {
                    builder.Append(value);
                    dash = false;
                }
                else if (!dash)
                {
                    builder.Append('-');
                    dash = true;
                }
            }
            string candidate = builder.ToString().TrimEnd('-');
            if (candidate.Length > 48)
            {
                candidate = candidate.Substring(0, 48).TrimEnd('-');
            }
            string unique = candidate;
            int suffix = 2;
            while (!used.Add(unique))
            {
                unique = $"{candidate}-{suffix++}";
            }
            return unique;
        }

        private static void RemoveArtColliders(GameObject instance)
        {
            if (instance == null)
            {
                return;
            }

            Collider[] colliders = instance.GetComponentsInChildren<Collider>(true);
            for (int index = 0; index < colliders.Length; index++)
            {
                UnityEngine.Object.Destroy(colliders[index]);
            }
        }
    }
}
