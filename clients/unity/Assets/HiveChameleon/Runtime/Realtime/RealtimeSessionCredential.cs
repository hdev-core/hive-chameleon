using System;
using System.Globalization;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    public sealed class ReconnectDescriptor
    {
        private ReconnectDescriptor(
            bool available,
            string lobbyId,
            DateTimeOffset expiresAt,
            string restorationMode
        )
        {
            Available = available;
            LobbyId = lobbyId;
            ExpiresAt = expiresAt;
            RestorationMode = restorationMode;
        }

        public bool Available { get; }

        public string LobbyId { get; }

        public DateTimeOffset ExpiresAt { get; }

        public string RestorationMode { get; }

        public static ReconnectDescriptor FromJson(
            string json,
            DateTimeOffset checkedAt
        )
        {
            ReconnectDescriptorResponseDto response =
                JsonUtility.FromJson<ReconnectDescriptorResponseDto>(json);
            if (response == null)
            {
                throw new InvalidOperationException(
                    "Reconnect descriptor response was not valid JSON."
                );
            }
            return response.ToDescriptor(checkedAt);
        }

        internal static ReconnectDescriptor Unavailable()
        {
            return new ReconnectDescriptor(
                false,
                string.Empty,
                default,
                string.Empty
            );
        }

        internal static ReconnectDescriptor AvailableUntil(
            string lobbyId,
            DateTimeOffset expiresAt,
            string restorationMode
        )
        {
            return new ReconnectDescriptor(
                true,
                lobbyId,
                expiresAt,
                restorationMode
            );
        }
    }

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

    [Serializable]
    internal sealed class ReconnectDescriptorResponseDto
    {
        [SerializeField]
        private bool available;

        [SerializeField]
        private string lobbyId = string.Empty;

        [SerializeField]
        private string expiresAt = string.Empty;

        [SerializeField]
        private string restorationMode = string.Empty;

        public ReconnectDescriptor ToDescriptor(DateTimeOffset checkedAt)
        {
            if (!available)
            {
                return ReconnectDescriptor.Unavailable();
            }
            if (!LobbyMenuRules.IsUuidV7(lobbyId))
            {
                throw new InvalidOperationException(
                    "Reconnect descriptor has an invalid lobby ID."
                );
            }
            if (
                !DateTimeOffset.TryParse(
                    expiresAt,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out DateTimeOffset expiration
                )
                || expiration <= checkedAt
            )
            {
                throw new InvalidOperationException(
                    "Reconnect descriptor is expired or has an invalid expiry."
                );
            }
            if (
                restorationMode != "same_role"
                && restorationMode != "spectate"
                && restorationMode != "next_round"
            )
            {
                throw new InvalidOperationException(
                    "Reconnect descriptor has an unsupported restoration mode."
                );
            }

            return ReconnectDescriptor.AvailableUntil(
                lobbyId.Trim(),
                expiration,
                restorationMode
            );
        }
    }
}
