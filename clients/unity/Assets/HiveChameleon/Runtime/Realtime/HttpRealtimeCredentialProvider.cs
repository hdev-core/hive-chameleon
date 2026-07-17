using System;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace HiveChameleon.Realtime
{
    public sealed class HttpRealtimeCredentialProvider : IRealtimeCredentialProvider
    {
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
                throw new ArgumentException("A development bearer token is required.", nameof(bearerToken));
            }

            _sessionEndpoint = new Uri(baseUri, "api/v1/realtime/session");
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

        private static string EnsureTrailingSlash(string value)
        {
            return value.EndsWith("/", StringComparison.Ordinal) ? value : value + "/";
        }
    }
}
