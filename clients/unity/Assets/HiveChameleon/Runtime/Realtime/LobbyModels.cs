using System;

namespace HiveChameleon.Realtime
{
    [Serializable]
    public sealed class LobbyMemberSnapshot
    {
        public string player_id = string.Empty;
        public string joined_at = string.Empty;
    }

    [Serializable]
    public sealed class LobbyConfigurationSnapshot
    {
        public string mode = "casual";
        public string map_version_id = string.Empty;
        public int hunter_count = 1;
        public int hiding_duration_seconds = 60;
        public int hunting_duration_seconds = 180;
        public bool taunt_enabled = true;
        public int taunt_interval_seconds = 30;
        public int shell_limit = 6;
        public int reload_duration_ms = 2000;
        public bool auto_start_enabled = true;
        public int auto_start_threshold = 7;
        public long row_version = 1;
    }

    [Serializable]
    public sealed class LobbySnapshot
    {
        public string id = string.Empty;
        public string name = string.Empty;
        public string visibility = string.Empty;
        public int max_players;
        public string region_code = string.Empty;
        public string current_host_player_id = string.Empty;
        public long row_version;
        public bool closed;
        public LobbyMemberSnapshot[] members = Array.Empty<LobbyMemberSnapshot>();
        public LobbyConfigurationSnapshot configuration = new LobbyConfigurationSnapshot();
    }

    [Serializable]
    public sealed class LobbyRpcResponse
    {
        public string match_id = string.Empty;
        public LobbySnapshot lobby = new LobbySnapshot();
        public bool start_accepted;
    }

    public sealed class LobbyConfigurationDraft
    {
        public string Mode { get; set; } = "casual";
        public string MapVersionId { get; set; } = string.Empty;
        public int HunterCount { get; set; } = 1;
        public int HidingDurationSeconds { get; set; } = 60;
        public int HuntingDurationSeconds { get; set; } = 180;
        public bool TauntEnabled { get; set; } = true;
        public int TauntIntervalSeconds { get; set; } = 30;
        public int ShellLimit { get; set; } = 6;
        public int ReloadDurationMilliseconds { get; set; } = 2000;
        public bool AutoStartEnabled { get; set; } = true;
        public int AutoStartThreshold { get; set; } = 7;

        public static LobbyConfigurationDraft FromSnapshot(
            LobbyConfigurationSnapshot snapshot
        )
        {
            if (snapshot == null)
            {
                throw new ArgumentNullException(nameof(snapshot));
            }
            return new LobbyConfigurationDraft
            {
                Mode = snapshot.mode,
                MapVersionId = snapshot.map_version_id,
                HunterCount = snapshot.hunter_count,
                HidingDurationSeconds = snapshot.hiding_duration_seconds,
                HuntingDurationSeconds = snapshot.hunting_duration_seconds,
                TauntEnabled = snapshot.taunt_enabled,
                TauntIntervalSeconds = snapshot.taunt_interval_seconds,
                ShellLimit = snapshot.shell_limit,
                ReloadDurationMilliseconds = snapshot.reload_duration_ms,
                AutoStartEnabled = snapshot.auto_start_enabled,
                AutoStartThreshold = snapshot.auto_start_threshold,
            };
        }
    }

    [Serializable]
    internal sealed class CreateLobbyCommand
    {
        public string name = string.Empty;
        public string visibility = "public";
        public string password = string.Empty;
        public int max_players = 10;
        public string region_code = "local";
    }

    [Serializable]
    internal sealed class JoinLobbyCommand
    {
        public string lobby_id = string.Empty;
        public string password = string.Empty;
        public string join_source = "server_browser";
    }

    [Serializable]
    internal sealed class LeaveLobbyCommand
    {
        public string lobby_id = string.Empty;
    }

    [Serializable]
    internal sealed class StartLobbyCommand
    {
        public string lobby_id = string.Empty;
        public long expected_lobby_version;
    }

    [Serializable]
    internal sealed class UpdateLobbyConfigurationCommand
    {
        public string lobby_id = string.Empty;
        public long expected_lobby_version;
        public string mode = "casual";
        public string map_version_id = string.Empty;
        public int hunter_count = 1;
        public int hiding_duration_seconds = 60;
        public int hunting_duration_seconds = 180;
        public bool taunt_enabled = true;
        public int taunt_interval_seconds = 30;
        public int shell_limit = 6;
        public int reload_duration_ms = 2000;
        public bool auto_start_enabled = true;
        public int auto_start_threshold = 7;
    }
}
