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

            GameObject instance = Object.Instantiate(prefab, parent, false);
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

        private static void RemoveArtColliders(GameObject instance)
        {
            if (instance == null)
            {
                return;
            }

            Collider[] colliders = instance.GetComponentsInChildren<Collider>(true);
            for (int index = 0; index < colliders.Length; index++)
            {
                Object.Destroy(colliders[index]);
            }
        }
    }
}
