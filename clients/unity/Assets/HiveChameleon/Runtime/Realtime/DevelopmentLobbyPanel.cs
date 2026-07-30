#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    [DisallowMultipleComponent]
    public sealed class DevelopmentLobbyPanel : MonoBehaviour
    {
        private NakamaRealtimeConnection _connection;
        private CancellationTokenSource _lifetime;
        private string _lobbyName = "Development Lobby";
        private string _joinLobbyId = string.Empty;
        private string _password = string.Empty;
        private string _regionCode = "local";
        private string _maxPlayers = "10";
        private string _mapVersionId = string.Empty;
        private string _status = "Connected. Create or join a lobby.";
        private bool _nominated;
        private bool _busy;
        private bool _previewMode;
        private Vector2 _scrollPosition;

        public void Initialize(
            NakamaRealtimeConnection connection,
            CancellationToken shutdownToken
        )
        {
            if (connection == null)
            {
                throw new ArgumentNullException(nameof(connection));
            }
            if (_connection != null)
            {
                _connection.LobbyStateChanged -= HandleLobbyStateChanged;
                _connection.RoundStateChanged -= HandleRoundStateChanged;
                _connection.RoundRoleAssigned -= HandleRoundRoleAssigned;
                _connection.RoundPlayerStateChanged -= HandleRoundPlayerStateChanged;
                _connection.RoundDiscoveryReceived -= HandleRoundDiscovery;
                _connection.HunterFireResolved -= HandleHunterFireResolved;
                _lifetime?.Dispose();
            }
            _connection = connection;
            _connection.LobbyStateChanged += HandleLobbyStateChanged;
            _connection.RoundStateChanged += HandleRoundStateChanged;
            _connection.RoundRoleAssigned += HandleRoundRoleAssigned;
            _connection.RoundPlayerStateChanged += HandleRoundPlayerStateChanged;
            _connection.RoundDiscoveryReceived += HandleRoundDiscovery;
            _connection.HunterFireResolved += HandleHunterFireResolved;
            _lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            _previewMode = false;
        }

        public void InitializePreview()
        {
            _previewMode = true;
            _status = "Credential-free visual preview · realtime actions are disabled.";
        }

        private void OnGUI()
        {
            if (_connection == null && !_previewMode)
            {
                return;
            }

            Matrix4x4 previousMatrix = GUI.matrix;
            float uiScale = Mathf.Clamp(Screen.width / 960f, 1f, 2f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(uiScale, uiScale, 1f));
            float logicalWidth = Screen.width / uiScale;
            float logicalHeight = Screen.height / uiScale;
            float panelWidth = Mathf.Clamp(logicalWidth - 24f, 280f, 520f);

            GUILayout.BeginArea(
                new Rect(12, 12, panelWidth, Mathf.Max(260, logicalHeight - 24))
            );
            _scrollPosition = GUILayout.BeginScrollView(_scrollPosition);
            GUILayout.BeginVertical(GUI.skin.box);
            GUILayout.Label("Hive Chameleon · Lobby & Round Development");
            GUILayout.Label(
                _previewMode ? "Realtime: offline visual preview" : $"Realtime: {_connection.State}"
            );
            GUILayout.Label(_status);

            if (_previewMode)
            {
                DrawPreview();
            }
            else
            {
                LobbySnapshot lobby = _connection.CurrentLobby;
                if (lobby == null || string.IsNullOrWhiteSpace(lobby.id) || lobby.closed)
                {
                    DrawCreateAndJoin();
                }
                else
                {
                    DrawLobby(lobby);
                }
            }

            GUILayout.EndVertical();
            GUILayout.EndScrollView();
            GUILayout.EndArea();
            GUI.matrix = previousMatrix;
        }

        private static void DrawPreview()
        {
            GUILayout.Space(8);
            GUILayout.Label("Lobby: M4 Visual Review");
            GUILayout.Label("ID: preview-lobby-32");
            GUILayout.Label("Host: player-farhat");
            GUILayout.Label("Version: 8");
            GUILayout.Label("Members: 4/10");
            GUILayout.Label("Mode: casual · Hunters: 1");
            GUILayout.Label("Hide/Hunt: 10s/30s · Shells: 6");
            GUILayout.Label("Map version: map-preview-v1");
            GUILayout.Label("Hunter nominations: 2");
            GUILayout.Label("  • player-farhat");
            GUILayout.Label("  • player-mohammad");

            bool enabled = GUI.enabled;
            GUI.enabled = false;
            GUILayout.Button("Copy Lobby ID");

            GUILayout.Space(8);
            GUILayout.Label("Round #1: hunting (preview-round-32)");
            GUILayout.Label("Phase deadline: 00:24");
            GUILayout.Label("Hiders remaining: 2/3");
            GUILayout.Label("Own role: hunter (volunteered)");
            GUILayout.Label("Shells: 4 · reload ready");
            GUILayout.Label("Aim slots are intents; Nakama resolves every hit.");
            DrawPreviewAimSlots(5);
            GUILayout.Label("Last fire: HIT slot 2 · 4 shells remain");
            GUILayout.Label("Discovery #1: player-mohammad found by player-farhat");
            GUILayout.Button("Leave");
            GUI.enabled = enabled;

            GUILayout.Space(8);
            GUILayout.Label(
                "This representative state is for visual review only. "
                    + "Run the local realtime stack to exercise lobby and round actions."
            );
        }

        private static void DrawPreviewAimSlots(int targetSlotCount)
        {
            for (int firstSlot = 1; firstSlot <= targetSlotCount; firstSlot += 3)
            {
                GUILayout.BeginHorizontal();
                for (
                    int slot = firstSlot;
                    slot < firstSlot + 3 && slot <= targetSlotCount;
                    slot++
                )
                {
                    GUILayout.Button($"Fire slot {slot}");
                }
                GUILayout.EndHorizontal();
            }
        }

        private void DrawCreateAndJoin()
        {
            GUILayout.Space(8);
            GUILayout.Label("Create public lobby");
            _lobbyName = GUILayout.TextField(_lobbyName);
            _regionCode = GUILayout.TextField(_regionCode);
            _maxPlayers = GUILayout.TextField(_maxPlayers);
            GUI.enabled = !_busy && _connection.State == RealtimeConnectionState.Connected;
            if (GUILayout.Button("Create"))
            {
                if (
                    !int.TryParse(_maxPlayers, out int maxPlayers)
                    || maxPlayers < 2
                    || maxPlayers > 10
                )
                {
                    _status = "Max players must be between 2 and 10.";
                }
                else
                {
                    Execute(
                        () =>
                            _connection.CreateLobbyAsync(
                                _lobbyName,
                                "public",
                                string.Empty,
                                maxPlayers,
                                _regionCode,
                                _lifetime.Token
                            ),
                        "Lobby created and authoritative match joined."
                    );
                }
            }

            GUILayout.Space(8);
            GUILayout.Label("Join lobby ID");
            _joinLobbyId = GUILayout.TextField(_joinLobbyId);
            GUILayout.Label("Password (private lobbies only)");
            _password = GUILayout.PasswordField(_password, '*');
            if (GUILayout.Button("Join"))
            {
                Execute(
                    () =>
                        _connection.JoinLobbyAsync(
                            _joinLobbyId,
                            _password,
                            _lifetime.Token
                        ),
                    "Persistent lobby and authoritative match joined."
                );
            }
            GUI.enabled = true;
        }

        private void DrawLobby(LobbySnapshot lobby)
        {
            GUILayout.Space(8);
            GUILayout.Label($"Lobby: {lobby.name}");
            GUILayout.Label($"ID: {lobby.id}");
            GUILayout.Label($"Host: {lobby.current_host_player_id}");
            GUILayout.Label($"Version: {lobby.row_version}");
            GUILayout.Label($"Members: {lobby.members.Length}/{lobby.max_players}");
            GUILayout.Label(
                $"Mode: {lobby.configuration.mode} · Hunters: {lobby.configuration.hunter_count}"
            );
            GUILayout.Label(
                $"Hide/Hunt: {lobby.configuration.hiding_duration_seconds}s/"
                    + $"{lobby.configuration.hunting_duration_seconds}s · "
                    + $"Shells: {lobby.configuration.shell_limit}"
            );
            GUILayout.Label($"Map version: {lobby.configuration.map_version_id}");
            GUILayout.Label($"Hunter nominations: {lobby.hunter_nominee_player_ids.Length}");
            foreach (string nomineePlayerId in lobby.hunter_nominee_player_ids)
            {
                GUILayout.Label($"  • {nomineePlayerId}");
            }

            if (GUILayout.Button("Copy Lobby ID"))
            {
                GUIUtility.systemCopyBuffer = lobby.id;
                _status = "Lobby ID copied. Paste it into a second client.";
            }

            GUI.enabled = !_busy && _connection.State == RealtimeConnectionState.Connected;
            RoundSnapshot round = _connection.CurrentRound;
            if (round == null)
            {
                if (GUILayout.Button(_nominated ? "Withdraw Hunter nomination" : "Nominate me as Hunter"))
                {
                    bool nextNomination = !_nominated;
                    Execute(
                        () =>
                            _connection.NominateHunterAsync(
                                nextNomination,
                                _lifetime.Token
                            ),
                        nextNomination
                            ? "Hunter nomination accepted."
                            : "Hunter nomination withdrawn.",
                        () => _nominated = nextNomination
                    );
                }

                GUILayout.Label("Published map version ID");
                _mapVersionId = GUILayout.TextField(_mapVersionId);
                if (GUILayout.Button("Configure Casual demo: 10s hide / 30s hunt"))
                {
                    LobbyConfigurationDraft configuration =
                        LobbyConfigurationDraft.FromSnapshot(lobby.configuration);
                    configuration.Mode = "casual";
                    configuration.MapVersionId = _mapVersionId.Trim();
                    configuration.HidingDurationSeconds = 10;
                    configuration.HuntingDurationSeconds = 30;
                    configuration.ShellLimit = Mathf.Max(6, configuration.ShellLimit);
                    configuration.ReloadDurationMilliseconds = 1000;
                    Execute(
                        () =>
                            _connection.UpdateLobbyConfigurationAsync(
                                configuration,
                                _lifetime.Token
                            ),
                        "Host configuration accepted."
                    );
                }
                if (GUILayout.Button("Start authoritative round"))
                {
                    Execute(
                        () => _connection.StartLobbyAsync(_lifetime.Token),
                        "Round created; the server assigned private roles."
                    );
                }
            }
            else
            {
                DrawRound(round);
            }
            if (GUILayout.Button("Leave"))
            {
                Execute(
                    () => _connection.LeaveLobbyAsync(_lifetime.Token),
                    "Lobby left."
                );
            }
            GUI.enabled = true;

            GUILayout.Space(8);
            GUILayout.Label(
                "Migration test: run a second client, join with the copied ID, "
                    + "then stop/close the host client. The Host and Version fields "
                    + "must update on the remaining client."
            );
        }

        private void DrawRound(RoundSnapshot round)
        {
            GUILayout.Space(8);
            GUILayout.Label(
                $"Round #{round.sequence_number}: {round.status} ({round.id})"
            );
            GUILayout.Label($"Mode: {round.mode}");
            GUILayout.Label($"Phase deadline: {FormatPhaseCountdown(round)}");
            GUILayout.Label(
                $"Hiders remaining: {round.hiders_remaining}/{round.hiders_total}"
            );

            RoundRoleAssignment assignment = _connection.CurrentRoleAssignment;
            GUILayout.Label(
                assignment == null
                    ? "Own role: waiting for private server assignment"
                    : $"Own role: {assignment.role}"
                        + (assignment.hunter_volunteer ? " (volunteered)" : "")
            );

            RoundPlayerState playerState = _connection.CurrentRoundPlayerState;
            if (playerState != null)
            {
                GUILayout.Label($"Own state: {playerState.status}");
                if (playerState.role == "hider" && playerState.hiding_slot > 0)
                {
                    GUILayout.Label(
                        $"Private hiding slot: {playerState.hiding_slot} "
                            + "(never included in the public round snapshot)"
                    );
                }
                if (playerState.role == "hunter")
                {
                    DrawHunterControls(round, playerState);
                }
            }

            HunterFireResult fireResult = _connection.LastFireResult;
            if (fireResult != null && fireResult.round_id == round.id)
            {
                GUILayout.Label(FormatFireResult(fireResult));
            }
            RoundDiscoverySnapshot discovery = _connection.LastDiscovery;
            if (discovery != null && discovery.round_id == round.id)
            {
                GUILayout.Label(
                    $"Discovery #{discovery.sequence}: {discovery.hider_player_id} "
                        + $"found by {discovery.hunter_player_id} at slot {discovery.aim_slot}"
                );
            }

            if (round.status == "terminal")
            {
                GUILayout.Space(8);
                GUILayout.Label(
                    $"Authoritative outcome: {round.winning_side} win "
                        + $"({round.completion_reason})"
                );
                GUILayout.Label(
                    "The simulation is terminal. Card #33 will add the durable "
                        + "result transaction and publication handoff."
                );
            }
        }

        private void DrawHunterControls(
            RoundSnapshot round,
            RoundPlayerState playerState
        )
        {
            bool reloading = TryGetRemaining(
                playerState.reload_until,
                out TimeSpan reloadRemaining
            );
            GUILayout.Label(
                reloading
                    ? $"Shells: {playerState.shells_remaining} · reload {reloadRemaining.TotalSeconds:0.0}s"
                    : $"Shells: {playerState.shells_remaining} · reload ready"
            );
            GUILayout.Label(
                "Choose an aim slot. The client sends intent only; Nakama owns hit resolution."
            );

            bool enabled = GUI.enabled;
            GUI.enabled =
                enabled
                && !_busy
                && round.status == "hunting"
                && playerState.shells_remaining > 0
                && !reloading;
            for (int firstSlot = 1; firstSlot <= round.target_slot_count; firstSlot += 3)
            {
                GUILayout.BeginHorizontal();
                for (
                    int slot = firstSlot;
                    slot < firstSlot + 3 && slot <= round.target_slot_count;
                    slot++
                )
                {
                    if (GUILayout.Button($"Fire slot {slot}"))
                    {
                        ExecuteFire(slot);
                    }
                }
                GUILayout.EndHorizontal();
            }
            GUI.enabled = enabled;
        }

        private async void ExecuteFire(int aimSlot)
        {
            if (_busy || _lifetime == null)
            {
                return;
            }
            _busy = true;
            _status = $"Sending Hunter fire intent for slot {aimSlot}...";
            try
            {
                string commandId = await _connection.FireHunterAsync(
                    aimSlot,
                    _lifetime.Token
                );
                _status =
                    $"Fire intent {commandId.Substring(0, 8)} sent; "
                    + "waiting for the authoritative result.";
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                _status = "Fire intent cancelled.";
            }
            catch (Exception exception)
            {
                _status = exception.Message;
                Debug.LogWarning($"Hunter fire intent failed: {exception.Message}");
            }
            finally
            {
                _busy = false;
            }
        }

        private static string FormatPhaseCountdown(RoundSnapshot round)
        {
            if (round.status == "terminal")
            {
                return "terminal";
            }
            if (!TryGetRemaining(round.phase_deadline, out TimeSpan remaining))
            {
                return "transition pending";
            }
            int seconds = Mathf.Max(0, Mathf.CeilToInt((float)remaining.TotalSeconds));
            return $"{seconds / 60:00}:{seconds % 60:00}";
        }

        private static bool TryGetRemaining(
            string timestamp,
            out TimeSpan remaining
        )
        {
            remaining = TimeSpan.Zero;
            if (
                string.IsNullOrWhiteSpace(timestamp)
                || !DateTimeOffset.TryParse(
                    timestamp,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out DateTimeOffset deadline
                )
            )
            {
                return false;
            }
            remaining = deadline - DateTimeOffset.UtcNow;
            return remaining > TimeSpan.Zero;
        }

        private static string FormatFireResult(HunterFireResult result)
        {
            if (result.accepted)
            {
                return result.hit
                    ? $"Last fire: HIT slot {result.aim_slot} · "
                        + $"{result.shells_remaining} shells remain"
                    : $"Last fire: miss at slot {result.aim_slot} · "
                        + $"{result.shells_remaining} shells remain";
            }
            return $"Last fire rejected by server: {result.reason}";
        }

        private async void Execute(
            Func<Task<LobbyRpcResponse>> operation,
            string successMessage,
            Action onSuccess = null
        )
        {
            if (_busy || _lifetime == null)
            {
                return;
            }
            _busy = true;
            _status = "Working...";
            try
            {
                LobbyRpcResponse response = await operation();
                _joinLobbyId = response.lobby.id;
                onSuccess?.Invoke();
                _status = successMessage;
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                _status = "Operation cancelled.";
            }
            catch (Exception exception)
            {
                _status = exception.Message;
                Debug.LogWarning($"Lobby development action failed: {exception.Message}");
            }
            finally
            {
                _busy = false;
            }
        }

        private void HandleLobbyStateChanged(LobbySnapshot lobby)
        {
            _joinLobbyId = lobby.id;
            if (!string.IsNullOrWhiteSpace(lobby.configuration.map_version_id))
            {
                _mapVersionId = lobby.configuration.map_version_id;
            }
            _status = lobby.closed
                ? "Lobby closed."
                : $"Lobby state updated to version {lobby.row_version}.";
        }

        private void HandleRoundStateChanged(RoundSnapshot round)
        {
            _status = $"Round {round.sequence_number} entered {round.status}.";
        }

        private void HandleRoundRoleAssigned(RoundRoleAssignment assignment)
        {
            _status = $"Private server role assigned: {assignment.role}.";
        }

        private void HandleRoundPlayerStateChanged(RoundPlayerState playerState)
        {
            _status =
                playerState.role == "hunter"
                    ? $"Private Hunter state updated: {playerState.shells_remaining} shells."
                    : $"Private Hider state updated: {playerState.status}.";
        }

        private void HandleRoundDiscovery(RoundDiscoverySnapshot discovery)
        {
            _status =
                $"Authoritative discovery #{discovery.sequence}: "
                + $"{discovery.hider_player_id} was found.";
        }

        private void HandleHunterFireResolved(HunterFireResult result)
        {
            _status = FormatFireResult(result);
        }

        private void OnDestroy()
        {
            if (_connection != null)
            {
                _connection.LobbyStateChanged -= HandleLobbyStateChanged;
                _connection.RoundStateChanged -= HandleRoundStateChanged;
                _connection.RoundRoleAssigned -= HandleRoundRoleAssigned;
                _connection.RoundPlayerStateChanged -= HandleRoundPlayerStateChanged;
                _connection.RoundDiscoveryReceived -= HandleRoundDiscovery;
                _connection.HunterFireResolved -= HandleHunterFireResolved;
            }
            _lifetime?.Cancel();
            _lifetime?.Dispose();
        }
    }
}
#endif
