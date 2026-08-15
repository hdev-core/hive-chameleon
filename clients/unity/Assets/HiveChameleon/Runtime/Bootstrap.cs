using HiveChameleon.Realtime;
using HiveChameleon.Presentation;
using UnityEngine;

namespace HiveChameleon
{
    public sealed class Bootstrap : MonoBehaviour
    {
        private void Awake()
        {
            DontDestroyOnLoad(gameObject);
            Debug.Log("Hive Chameleon client started.");

            if (GetComponent<OfficialArenaExperience>() == null)
            {
                gameObject.AddComponent<OfficialArenaExperience>();
            }

            if (GetComponent<DevelopmentRealtimeBootstrap>() == null)
            {
                gameObject.AddComponent<DevelopmentRealtimeBootstrap>();
            }
        }
    }
}
