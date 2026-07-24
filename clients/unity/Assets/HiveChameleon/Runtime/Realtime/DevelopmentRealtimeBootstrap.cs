using System;
using System.Threading;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    [DisallowMultipleComponent]
    public sealed class DevelopmentRealtimeBootstrap : MonoBehaviour
    {
        private const string DefaultApiBaseUrl = "http://127.0.0.1:3000";

        [SerializeField]
        private string apiBaseUrl = DefaultApiBaseUrl;

        [SerializeField]
        private string nakamaServerKey = string.Empty;

        [SerializeField]
        private string developmentBearerToken = string.Empty;

        private readonly CancellationTokenSource _shutdown = new CancellationTokenSource();
        private IRealtimeConnection _connection;

#if UNITY_EDITOR
        public void ConfigureForDevelopmentBuild(
            string configuredApiBaseUrl,
            string configuredServerKey,
            string configuredBearerToken
        )
        {
            apiBaseUrl = configuredApiBaseUrl;
            nakamaServerKey = configuredServerKey;
            developmentBearerToken = configuredBearerToken;
        }
#endif

        private async void Start()
        {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            string resolvedServerKey = ResolveDevelopmentValue(
                nakamaServerKey,
                "NAKAMA_SERVER_KEY"
            );
            string resolvedBearerToken = ResolveDevelopmentValue(
                developmentBearerToken,
                "REALTIME_DEV_BEARER_TOKEN"
            );
            string resolvedApiBaseUrl = ResolveDevelopmentValue(
                apiBaseUrl,
                "HIVE_CHAMELEON_API_URL"
            );

            if (
                string.IsNullOrWhiteSpace(resolvedServerKey)
                || string.IsNullOrWhiteSpace(resolvedBearerToken)
            )
            {
                DevelopmentLobbyPanel previewPanel = GetComponent<DevelopmentLobbyPanel>();
                if (previewPanel == null)
                {
                    previewPanel = gameObject.AddComponent<DevelopmentLobbyPanel>();
                }
                previewPanel.InitializePreview();
                Debug.Log(
                    "Realtime development connection is disabled; showing the credential-free visual preview."
                );
                return;
            }

            try
            {
                IRealtimeCredentialProvider credentialProvider =
                    new HttpRealtimeCredentialProvider(resolvedApiBaseUrl, resolvedBearerToken);
                var nakamaConnection = new NakamaRealtimeConnection(resolvedServerKey);
                _connection = nakamaConnection;
                RealtimeSessionCredential credential = await credentialProvider.GetCredentialAsync(
                    _shutdown.Token
                );
                await _connection.ConnectAsync(credential, _shutdown.Token);

                DevelopmentLobbyPanel panel = GetComponent<DevelopmentLobbyPanel>();
                if (panel == null)
                {
                    panel = gameObject.AddComponent<DevelopmentLobbyPanel>();
                }
                panel.Initialize(nakamaConnection, _shutdown.Token);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
                // Normal object or application shutdown.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Realtime development connection unavailable: {exception.Message}");
            }
#endif
        }

        private async void OnDestroy()
        {
            _shutdown.Cancel();
            if (_connection != null)
            {
                await _connection.CloseAsync();
            }
            _shutdown.Dispose();
        }

        private static string ResolveDevelopmentValue(string serializedValue, string variableName)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            return serializedValue;
#else
            string environmentValue = Environment.GetEnvironmentVariable(variableName);
            return string.IsNullOrWhiteSpace(environmentValue) ? serializedValue : environmentValue;
#endif
        }
    }
}
