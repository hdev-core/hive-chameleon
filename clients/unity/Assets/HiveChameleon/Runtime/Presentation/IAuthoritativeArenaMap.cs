using UnityEngine;

namespace HiveChameleon.Presentation
{
    public interface IAuthoritativeArenaMap
    {
        Vector3 LocalHunterSpawn { get; }

        Vector3 LocalHiderSpawn { get; }

        Vector3 HiderSpawn(int index);

        Vector3 HunterSpawn(int index);

        Vector3 SpawnForPlayer(string playerId, bool hunter);

        void ApplyPresentationEnvironment(Camera targetCamera = null);
    }
}
