using HiveChameleon.Realtime;
using UnityEngine;

namespace HiveChameleon
{
    public sealed class Bootstrap : MonoBehaviour
    {
        private void Awake()
        {
            DontDestroyOnLoad(gameObject);
            Debug.Log("Hive Chameleon development client started.");

#if UNITY_EDITOR || DEVELOPMENT_BUILD
            if (GetComponent<DevelopmentRealtimeBootstrap>() == null)
            {
                gameObject.AddComponent<DevelopmentRealtimeBootstrap>();
            }
#endif
        }
    }
}
