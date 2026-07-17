using System;
using System.Globalization;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    public sealed class RealtimeSessionCredential
    {
        public RealtimeSessionCredential(
            string nakamaToken,
            Uri socketUri,
            DateTimeOffset expiresAt
        )
        {
            NakamaToken = nakamaToken;
            SocketUri = socketUri;
            ExpiresAt = expiresAt;
        }

        public string NakamaToken { get; }

        public Uri SocketUri { get; }

        public DateTimeOffset ExpiresAt { get; }
    }

    [Serializable]
    internal sealed class RealtimeSessionResponseDto
    {
        [SerializeField]
        private string nakamaToken = string.Empty;

        [SerializeField]
        private string socketUrl = string.Empty;

        [SerializeField]
        private string expiresAt = string.Empty;

        public RealtimeSessionCredential ToCredential()
        {
            if (string.IsNullOrWhiteSpace(nakamaToken))
            {
                throw new InvalidOperationException("Realtime session response has no Nakama token.");
            }
            if (
                !Uri.TryCreate(socketUrl, UriKind.Absolute, out Uri socketUri)
                || (socketUri.Scheme != "ws" && socketUri.Scheme != "wss")
            )
            {
                throw new InvalidOperationException("Realtime session response has an invalid socket URL.");
            }
            if (
                !DateTimeOffset.TryParse(
                    expiresAt,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out DateTimeOffset expiration
                )
            )
            {
                throw new InvalidOperationException("Realtime session response has an invalid expiry.");
            }

            return new RealtimeSessionCredential(nakamaToken, socketUri, expiration);
        }
    }
}
