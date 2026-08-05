using System;
using System.Text;
using HiveChameleon.Presentation;

namespace HiveChameleon.Realtime
{
    public static class LobbyMenuRules
    {
        public const string SupportedGameServerBuildVersion =
            "hive-chameleon-m4-dev";
        public const string SupportedProtocolVersion = "m4-v2";

        public static bool IsGameplayRound(RoundSnapshot round)
        {
            if (
                round == null
                || string.IsNullOrWhiteSpace(round.id)
                || !HasCompatibleMap(round)
            )
            {
                return false;
            }

            switch (round.status)
            {
                case "preparing":
                case "hiding":
                case "hunting":
                case "answer_check":
                    return true;
                default:
                    return false;
            }
        }

        public static bool HasCompatibleMap(RoundSnapshot round)
        {
            return round != null
                && IsUuidV7(round.map_version_id)
                && string.Equals(
                    round.map_content_version,
                    CityDistrictMap.ContentVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.game_server_build_version,
                    SupportedGameServerBuildVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.protocol_version,
                    SupportedProtocolVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.authority_geometry_version,
                    CityDistrictMap.AuthorityGeometryVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.authority_geometry_digest,
                    CityDistrictMap.AuthorityGeometryDigest,
                    StringComparison.Ordinal
                );
        }

        public static bool IsEligibleSpectator(
            RoundSnapshot round,
            SpectatorStateSnapshot spectator
        )
        {
            return round != null
                && spectator != null
                && spectator.eligible
                && !string.IsNullOrWhiteSpace(round.id)
                && string.Equals(
                    spectator.round_id,
                    round.id,
                    StringComparison.Ordinal
                );
        }

        public static bool HasPlayerControlAuthority(
            RoundSnapshot round,
            RoundPlayerState playerState,
            SpectatorStateSnapshot spectator
        )
        {
            if (
                round == null
                || playerState == null
                || IsEligibleSpectator(round, spectator)
                || !string.Equals(
                    playerState.round_id,
                    round.id,
                    StringComparison.Ordinal
                )
                || (
                    playerState.role != "hunter"
                    && playerState.role != "hider"
                )
                || (
                    playerState.status != "active"
                    && playerState.status != "converted"
                )
            )
            {
                return false;
            }

            switch (round.status)
            {
                case "preparing":
                case "hiding":
                case "hunting":
                    return true;
                case "answer_check":
                    return playerState.role == "hunter";
                default:
                    return false;
            }
        }

        public static bool CanAttemptReconnect(
            RealtimeConnectionState state,
            LobbySnapshot lobby
        )
        {
            return (
                    state == RealtimeConnectionState.Disconnected
                    || state == RealtimeConnectionState.Faulted
                )
                && lobby != null
                && !lobby.closed
                && !string.IsNullOrWhiteSpace(lobby.id);
        }

        public static bool IsHost(LobbySnapshot lobby, string playerId)
        {
            return lobby != null
                && !string.IsNullOrWhiteSpace(playerId)
                && string.Equals(
                    lobby.current_host_player_id,
                    playerId,
                    StringComparison.Ordinal
                );
        }

        public static bool IsNominated(LobbySnapshot lobby, string playerId)
        {
            if (
                lobby?.hunter_nominee_player_ids == null
                || string.IsNullOrWhiteSpace(playerId)
            )
            {
                return false;
            }

            for (int index = 0; index < lobby.hunter_nominee_player_ids.Length; index++)
            {
                if (
                    string.Equals(
                        lobby.hunter_nominee_player_ids[index],
                        playerId,
                        StringComparison.Ordinal
                    )
                )
                {
                    return true;
                }
            }
            return false;
        }

        public static bool CanStartRound(
            LobbySnapshot lobby,
            RoundSnapshot round,
            string playerId,
            out string reason
        )
        {
            if (!IsHost(lobby, playerId))
            {
                reason = "Only the lobby host can start the match.";
                return false;
            }
            if (round != null && round.status != "completed" && round.status != "aborted")
            {
                reason = "A match is already in progress.";
                return false;
            }
            if (!IsUuidV7(lobby.configuration?.map_version_id))
            {
                reason = "Chroma District is not available for this lobby.";
                return false;
            }

            int hunterCount = Math.Max(1, lobby.configuration.hunter_count);
            int memberCount = lobby.members?.Length ?? 0;
            if (memberCount < hunterCount + 1)
            {
                reason = $"Waiting for {hunterCount + 1 - memberCount} more player"
                    + (hunterCount + 1 - memberCount == 1 ? "." : "s.");
                return false;
            }

            reason = string.Empty;
            return true;
        }

        public static bool ValidateCreateLobby(
            string name,
            bool privateLobby,
            string password,
            int maxPlayers,
            string regionCode,
            out string reason
        )
        {
            string trimmedName = name?.Trim() ?? string.Empty;
            if (
                trimmedName.Length == 0
                || Encoding.UTF8.GetByteCount(trimmedName) > 128
            )
            {
                reason = "Lobby name must contain between 1 and 128 UTF-8 bytes.";
                return false;
            }
            if (maxPlayers < 2 || maxPlayers > 10)
            {
                reason = "Lobby capacity must be between 2 and 10 players.";
                return false;
            }
            if (!IsRegionCode(regionCode))
            {
                reason = "Region must use lowercase letters, numbers, or hyphens.";
                return false;
            }
            if (privateLobby)
            {
                int passwordBytes = Encoding.UTF8.GetByteCount(password ?? string.Empty);
                if (passwordBytes < 8 || passwordBytes > 72)
                {
                    reason = "Private lobby passwords must contain 8 to 72 UTF-8 bytes.";
                    return false;
                }
            }

            reason = string.Empty;
            return true;
        }

        public static bool ValidateJoinLobby(string lobbyId, out string reason)
        {
            if (!IsUuidV7(lobbyId))
            {
                reason = "Enter a valid lobby code.";
                return false;
            }

            reason = string.Empty;
            return true;
        }

        public static bool IsUuidV7(string value)
        {
            string candidate = value?.Trim() ?? string.Empty;
            if (candidate.Length != 36 || !Guid.TryParseExact(candidate, "D", out _))
            {
                return false;
            }

            char variant = char.ToLowerInvariant(candidate[19]);
            return candidate[14] == '7'
                && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b');
        }

        public static string PlayerDisplayLabel(
            string displayName,
            int ordinal = 0
        )
        {
            if (TryPlayerDisplayName(displayName, out string candidate))
            {
                return candidate;
            }

            return ordinal > 0 ? $"Player {ordinal:00}" : "Player";
        }

        public static bool TryPlayerDisplayName(
            string displayName,
            out string resolved
        )
        {
            string source = displayName?.Trim() ?? string.Empty;
            if (LooksLikeOpaquePlayerIdentifier(source))
            {
                resolved = string.Empty;
                return false;
            }

            resolved = NormalizeDisplayName(displayName);
            if (
                resolved.Length == 0
                || LooksLikeOpaquePlayerIdentifier(resolved)
            )
            {
                resolved = string.Empty;
                return false;
            }
            return true;
        }

        public static string ProductErrorMessage(Exception exception)
        {
            string message = exception?.Message?.Trim().ToLowerInvariant() ?? string.Empty;
            if (
                ContainsAny(
                    message,
                    "unauthorized",
                    "forbidden",
                    "credential",
                    "access token",
                    "session expired",
                    "http 401",
                    "http 403"
                )
            )
            {
                return "Your session has expired. Reconnect and try again.";
            }
            if (ContainsAny(message, "password"))
            {
                return "The lobby password was not accepted.";
            }
            if (
                ContainsAny(
                    message,
                    "lobby full",
                    "lobby is full",
                    "capacity",
                    "maximum players"
                )
            )
            {
                return "That lobby is full.";
            }
            if (
                ContainsAny(
                    message,
                    "lobby not found",
                    "lobby closed",
                    "no longer exists"
                )
            )
            {
                return "That lobby is no longer available.";
            }
            if (
                ContainsAny(
                    message,
                    "version conflict",
                    "row version",
                    "stale",
                    "conflict",
                    "changed since"
                )
            )
            {
                return "The lobby changed. Please try again.";
            }
            if (
                ContainsAny(
                    message,
                    "timeout",
                    "timed out",
                    "unavailable",
                    "unreachable",
                    "connection",
                    "socket",
                    "http 0",
                    "http 5"
                )
            )
            {
                return "Online services could not be reached. Please try again.";
            }
            if (
                ContainsAny(
                    message,
                    "not host",
                    "host only",
                    "permission",
                    "not allowed"
                )
            )
            {
                return "Only the lobby host can do that.";
            }
            if (
                ContainsAny(
                    message,
                    "invalid lobby",
                    "invalid argument",
                    "failed precondition"
                )
            )
            {
                return "That lobby request was not accepted.";
            }

            return "Online services could not complete the request. Please try again.";
        }

        private static bool IsRegionCode(string value)
        {
            string region = value?.Trim() ?? string.Empty;
            if (region.Length == 0 || region.Length > 32)
            {
                return false;
            }
            if (!IsAsciiAlphaNumeric(region[0]) || !IsAsciiAlphaNumeric(region[region.Length - 1]))
            {
                return false;
            }

            for (int index = 0; index < region.Length; index++)
            {
                char character = region[index];
                if (!IsAsciiAlphaNumeric(character) && character != '-')
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9');
        }

        private static string NormalizeDisplayName(string value)
        {
            string source = value?.Trim() ?? string.Empty;
            if (source.Length == 0)
            {
                return string.Empty;
            }

            var builder = new StringBuilder(Math.Min(source.Length, 32));
            bool previousWhitespace = false;
            for (int index = 0; index < source.Length && builder.Length < 32; index++)
            {
                char character = source[index];
                if (char.IsWhiteSpace(character))
                {
                    if (builder.Length > 0 && !previousWhitespace)
                    {
                        builder.Append(' ');
                    }
                    previousWhitespace = true;
                    continue;
                }
                if (char.IsControl(character))
                {
                    continue;
                }

                builder.Append(character);
                previousWhitespace = false;
            }
            return builder.ToString().TrimEnd();
        }

        private static bool LooksLikeOpaquePlayerIdentifier(string value)
        {
            if (Guid.TryParse(value, out _))
            {
                return true;
            }
            if (
                value.StartsWith("hc_", StringComparison.OrdinalIgnoreCase)
                && value.Length == 35
                && IsHex(value, 3, 32)
            )
            {
                return true;
            }
            if (value.Length == 32 && IsHex(value, 0, value.Length))
            {
                return true;
            }
            if (value.Length == 8 && IsHex(value, 0, value.Length))
            {
                return true;
            }
            return value.Length == 13
                && value[8] == '…'
                && IsHex(value, 0, 8)
                && IsHex(value, 9, 4);
        }

        private static bool IsHex(string value, int offset, int length)
        {
            if (offset < 0 || length < 1 || offset + length > value.Length)
            {
                return false;
            }
            for (int index = offset; index < offset + length; index++)
            {
                char character = value[index];
                bool hex =
                    (character >= '0' && character <= '9')
                    || (character >= 'a' && character <= 'f')
                    || (character >= 'A' && character <= 'F');
                if (!hex)
                {
                    return false;
                }
            }
            return true;
        }

        private static bool ContainsAny(string value, params string[] candidates)
        {
            for (int index = 0; index < candidates.Length; index++)
            {
                if (
                    value.IndexOf(
                        candidates[index],
                        StringComparison.Ordinal
                    ) >= 0
                )
                {
                    return true;
                }
            }
            return false;
        }
    }
}
