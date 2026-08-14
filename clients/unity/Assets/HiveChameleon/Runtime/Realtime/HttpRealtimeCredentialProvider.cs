using System;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace HiveChameleon.Realtime
{
    public sealed class HttpRealtimeCredentialProvider : IRealtimeCredentialProvider
    {
        private readonly Uri _reconnectEndpoint;
        private readonly Uri _sessionEndpoint;
        private readonly string _bearerToken;

        public HttpRealtimeCredentialProvider(string apiBaseUrl, string bearerToken)
        {
            if (!Uri.TryCreate(EnsureTrailingSlash(apiBaseUrl), UriKind.Absolute, out Uri baseUri))
            {
                throw new ArgumentException("API base URL must be absolute.", nameof(apiBaseUrl));
            }
            if (string.IsNullOrWhiteSpace(bearerToken))
            {
                throw new ArgumentException("A bearer token is required.", nameof(bearerToken));
            }

            _sessionEndpoint = new Uri(baseUri, "api/v1/realtime/session");
            _reconnectEndpoint = new Uri(baseUri, "api/v1/me/reconnect");
            _bearerToken = bearerToken;
        }

        public async Task<RealtimeSessionCredential> GetCredentialAsync(
            CancellationToken cancellationToken
        )
        {
            using UnityWebRequest request = new UnityWebRequest(
                _sessionEndpoint,
                UnityWebRequest.kHttpVerbPOST
            );
            request.uploadHandler = new UploadHandlerRaw(Array.Empty<byte>());
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Accept", "application/json");
            request.SetRequestHeader("Authorization", "Bearer " + _bearerToken);
            request.SetRequestHeader("Content-Type", "application/json");

            UnityWebRequestAsyncOperation operation = request.SendWebRequest();
            try
            {
                while (!operation.isDone)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    await Task.Yield();
                }
            }
            catch (OperationCanceledException)
            {
                request.Abort();
                throw;
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                throw new InvalidOperationException(
                    $"Realtime credential request failed with HTTP {request.responseCode}."
                );
            }

            string responseBody = request.downloadHandler.text;
            RealtimeSessionResponseDto response = JsonUtility.FromJson<RealtimeSessionResponseDto>(
                responseBody
            );
            if (response == null)
            {
                throw new InvalidOperationException("Realtime credential response was not valid JSON.");
            }
            return response.ToCredential();
        }

        public async Task<ReconnectDescriptor> GetReconnectDescriptorAsync(
            CancellationToken cancellationToken
        )
        {
            using UnityWebRequest request = UnityWebRequest.Get(_reconnectEndpoint);
            request.SetRequestHeader("Accept", "application/json");
            request.SetRequestHeader("Authorization", "Bearer " + _bearerToken);

            UnityWebRequestAsyncOperation operation = request.SendWebRequest();
            try
            {
                while (!operation.isDone)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    await Task.Yield();
                }
            }
            catch (OperationCanceledException)
            {
                request.Abort();
                throw;
            }

            if (request.result != UnityWebRequest.Result.Success)
            {
                throw new InvalidOperationException(
                    $"Reconnect discovery request failed with HTTP {request.responseCode}."
                );
            }

            return ReconnectDescriptor.FromJson(
                request.downloadHandler.text,
                DateTimeOffset.UtcNow
            );
        }

        private static string EnsureTrailingSlash(string value)
        {
            return value.EndsWith("/", StringComparison.Ordinal) ? value : value + "/";
        }
    }
}
