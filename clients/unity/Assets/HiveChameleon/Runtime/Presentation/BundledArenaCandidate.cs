using System;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    public enum BundledArenaId
    {
        NeonServiceArcade,
    }

    [DisallowMultipleComponent]
    public sealed class BundledArenaCandidate : MonoBehaviour, IAuthoritativeArenaMap
    {
        [SerializeField]
        private BundledArenaId arenaId;

        [SerializeField]
        private string displayName = string.Empty;

        [SerializeField]
        private int recommendedMinimumPlayers = 2;

        [SerializeField]
        private int recommendedMaximumPlayers = 8;

        [SerializeField]
        private Transform[] hunterSpawns = Array.Empty<Transform>();

        [SerializeField]
        private Transform[] hiderSpawns = Array.Empty<Transform>();

        [SerializeField]
        private Color ambientSky = Color.gray;

        [SerializeField]
        private Color ambientEquator = Color.gray;

        [SerializeField]
        private Color ambientGround = Color.black;

        [SerializeField]
        private Color cameraBackground = Color.black;

        public BundledArenaId ArenaId => arenaId;

        public string DisplayName => displayName;

        public int RecommendedMinimumPlayers => recommendedMinimumPlayers;

        public int RecommendedMaximumPlayers => recommendedMaximumPlayers;

        public int HunterSpawnCount => hunterSpawns?.Length ?? 0;

        public int HiderSpawnCount => hiderSpawns?.Length ?? 0;

        public Vector3 LocalHunterSpawn => HunterSpawn(0);

        public Vector3 LocalHiderSpawn => HiderSpawn(0);

        public Vector3 HunterSpawn(int index)
        {
            return SpawnPosition(hunterSpawns, index);
        }

        public Vector3 HiderSpawn(int index)
        {
            return SpawnPosition(hiderSpawns, index);
        }

        public Vector3 SpawnForPlayer(string playerId, bool hunter)
        {
            int hash = StableHash(playerId);
            return hunter ? HunterSpawn(hash) : HiderSpawn(hash);
        }

        public void ApplyPresentationEnvironment(Camera targetCamera = null)
        {
            RenderSettings.fog = false;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = ambientSky;
            RenderSettings.ambientEquatorColor = ambientEquator;
            RenderSettings.ambientGroundColor = ambientGround;
            RenderSettings.ambientIntensity = 1f;

            Camera camera = targetCamera != null ? targetCamera : Camera.main;
            if (camera != null)
            {
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = cameraBackground;
                camera.farClipPlane = 80f;
                camera.allowHDR = true;
            }
        }

#if UNITY_EDITOR
        public void ConfigureForEditor(
            BundledArenaId value,
            string valueDisplayName,
            int minimumPlayers,
            int maximumPlayers,
            Transform[] valueHunterSpawns,
            Transform[] valueHiderSpawns,
            Color sky,
            Color equator,
            Color ground,
            Color background
        )
        {
            arenaId = value;
            displayName = valueDisplayName ?? string.Empty;
            recommendedMinimumPlayers = Mathf.Max(2, minimumPlayers);
            recommendedMaximumPlayers = Mathf.Max(
                recommendedMinimumPlayers,
                maximumPlayers
            );
            hunterSpawns = valueHunterSpawns ?? Array.Empty<Transform>();
            hiderSpawns = valueHiderSpawns ?? Array.Empty<Transform>();
            ambientSky = sky;
            ambientEquator = equator;
            ambientGround = ground;
            cameraBackground = background;
        }
#endif

        private static Vector3 SpawnPosition(Transform[] spawns, int index)
        {
            if (spawns == null || spawns.Length == 0)
            {
                throw new InvalidOperationException(
                    "The bundled arena does not define the requested spawn type."
                );
            }

            int safeIndex = index == int.MinValue ? 0 : Mathf.Abs(index);
            Transform spawn = spawns[safeIndex % spawns.Length];
            if (spawn == null)
            {
                throw new MissingReferenceException(
                    "A bundled arena spawn reference is missing."
                );
            }
            return spawn.position;
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
