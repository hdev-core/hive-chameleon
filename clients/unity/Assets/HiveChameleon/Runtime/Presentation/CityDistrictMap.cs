using System;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    [DisallowMultipleComponent]
    public sealed class CityDistrictMap : MonoBehaviour
    {
        // The backend map catalog still knows the first official map by this slug.
        public const string OfficialSlug = "prism-foundry";
        public const string DisplayName = "Chroma District";
        public const string ContentVersion = "m4-5";
        public const string AuthorityGeometryVersion =
            "chroma-district-authority-proxy-1";
        public const string AuthorityGeometryDigest =
            "sha256:6f98a71c09aa8b66aaa6ae3d107e82d2fa09a666d71516221a3af6e07383fd72";

        private const string CityArenaResource = "City/HC_CityArena";

        private static readonly Vector3[] HiderSpawns =
        {
            new Vector3(-12.4f, 0.05f, -7.4f),
            new Vector3(5.7f, 0.05f, -7.8f),
            new Vector3(12.7f, 0.05f, 11.6f),
            new Vector3(-12.8f, 0.05f, 9.8f),
            new Vector3(19.2f, 0.05f, 5.2f),
            new Vector3(-19.1f, 0.05f, 5.4f),
            new Vector3(8.2f, 0.05f, -18.7f),
            new Vector3(-8.1f, 0.05f, -18.4f),
        };

        private static readonly Vector3[] HunterSpawns =
        {
            new Vector3(0f, 0.15f, 6f),
            new Vector3(2.4f, 0.15f, 7.2f),
        };

        private Transform _environment;

        public Vector3 LocalHunterSpawn => HunterSpawns[0];

        public Vector3 LocalHiderSpawn => HiderSpawns[0];

        private void Awake()
        {
            Build();
        }

        public Vector3 HiderSpawn(int index)
        {
            return HiderSpawns[Mathf.Abs(index) % HiderSpawns.Length];
        }

        public Vector3 HunterSpawn(int index)
        {
            return HunterSpawns[Mathf.Abs(index) % HunterSpawns.Length];
        }

        public Vector3 SpawnForPlayer(string playerId, bool hunter)
        {
            int hash = StableHash(playerId);
            return hunter ? HunterSpawn(hash) : HiderSpawn(hash);
        }

        private void Build()
        {
            if (_environment != null)
            {
                return;
            }

            gameObject.name = $"{DisplayName} // Official Arena";
            _environment = new GameObject("Chroma District Environment").transform;
            _environment.SetParent(transform, false);

            ConfigureWorld();
            InstantiateCity();
            BuildBoundaries();
        }

        private void ConfigureWorld()
        {
            RenderSettings.fog = false;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.48f, 0.62f, 0.78f);
            RenderSettings.ambientEquatorColor = new Color(0.32f, 0.38f, 0.45f);
            RenderSettings.ambientGroundColor = new Color(0.13f, 0.14f, 0.16f);
            RenderSettings.ambientIntensity = 1.05f;

            Camera camera = Camera.main;
            if (camera != null)
            {
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(0.22f, 0.36f, 0.55f);
                camera.farClipPlane = 120f;
                camera.allowHDR = true;
            }

            Light mainLight = FindFirstObjectByType<Light>();
            if (mainLight != null)
            {
                mainLight.type = LightType.Directional;
                mainLight.color = new Color(1f, 0.92f, 0.8f);
                mainLight.intensity = 1.15f;
                mainLight.shadows = LightShadows.Soft;
                mainLight.transform.rotation = Quaternion.Euler(48f, -35f, 0f);
            }
        }

        private void InstantiateCity()
        {
            GameObject cityPrefab = Resources.Load<GameObject>(CityArenaResource);
            if (cityPrefab == null)
            {
                throw new MissingReferenceException(
                    $"Required city prefab is missing at Resources/{CityArenaResource}."
                );
            }

            GameObject city = Instantiate(cityPrefab, _environment, false);
            city.name = "Low Poly City Starter Pack Arena";
            city.transform.localPosition = Vector3.zero;
            city.transform.localRotation = Quaternion.identity;
            city.transform.localScale = Vector3.one;
        }

        private void BuildBoundaries()
        {
            CreateInvisibleBoundary(
                "North city boundary",
                new Vector3(0f, 3f, 27.2f),
                new Vector3(55f, 6f, 1f)
            );
            CreateInvisibleBoundary(
                "South city boundary",
                new Vector3(0f, 3f, -27.2f),
                new Vector3(55f, 6f, 1f)
            );
            CreateInvisibleBoundary(
                "West city boundary",
                new Vector3(-27.2f, 3f, 0f),
                new Vector3(1f, 6f, 55f)
            );
            CreateInvisibleBoundary(
                "East city boundary",
                new Vector3(27.2f, 3f, 0f),
                new Vector3(1f, 6f, 55f)
            );
        }

        private void CreateInvisibleBoundary(
            string name,
            Vector3 position,
            Vector3 scale
        )
        {
            GameObject value = GameObject.CreatePrimitive(PrimitiveType.Cube);
            value.name = name;
            value.transform.SetParent(_environment, false);
            value.transform.localPosition = position;
            value.transform.localScale = scale;
            value.GetComponent<Renderer>().enabled = false;
        }

        private static int StableHash(string value)
        {
            unchecked
            {
                int hash = 17;
                string source = value ?? string.Empty;
                for (int index = 0; index < source.Length; index++)
                {
                    hash = hash * 31 + source[index];
                }
                return hash == int.MinValue ? 0 : Mathf.Abs(hash);
            }
        }
    }
}
