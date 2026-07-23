#if UNITY_EDITOR || DEVELOPMENT_BUILD
using System;
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
                _lifetime?.Dispose();
            }
            _connection = connection;
            _connection.LobbyStateChanged += HandleLobbyStateChanged;
            _connection.RoundStateChanged += HandleRoundStateChanged;
            _connection.RoundRoleAssigned += HandleRoundRoleAssigned;
            _lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
        }

        private void OnGUI()
        {
            if (_connection == null)
            {
                return;
            }

            GUILayout.BeginArea(new Rect(12, 12, 430, Mathf.Max(260, Screen.height - 24)));
            GUILayout.BeginVertical(GUI.skin.box);
            GUILayout.Label("Hive Chameleon · Lobby & Round Development");
            GUILayout.Label($"Realtime: {_connection.State}");
            GUILayout.Label(_status);

            LobbySnapshot lobby = _connection.CurrentLobby;
            if (lobby == null || string.IsNullOrWhiteSpace(lobby.id) || lobby.closed)
            {
                DrawCreateAndJoin();
            }
            else
            {
                DrawLobby(lobby);
            }

            GUILayout.EndVertical();
            GUILayout.EndArea();
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
                if (GUILayout.Button("Configure: use map + add one shell"))
                {
                    LobbyConfigurationDraft configuration =
                        LobbyConfigurationDraft.FromSnapshot(lobby.configuration);
                    configuration.MapVersionId = _mapVersionId.Trim();
                    configuration.ShellLimit = Mathf.Min(100, configuration.ShellLimit + 1);
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
                GUILayout.Space(8);
                GUILayout.Label(
                    $"Round #{round.sequence_number}: {round.status} ({round.id})"
                );
                RoundRoleAssignment assignment = _connection.CurrentRoleAssignment;
                GUILayout.Label(
                    assignment == null
                        ? "Own role: waiting for private server assignment"
                        : $"Own role: {assignment.role}"
                            + (assignment.hunter_volunteer ? " (volunteered)" : "")
                );
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

        private void OnDestroy()
        {
            if (_connection != null)
            {
                _connection.LobbyStateChanged -= HandleLobbyStateChanged;
                _connection.RoundStateChanged -= HandleRoundStateChanged;
                _connection.RoundRoleAssigned -= HandleRoundRoleAssigned;
            }
            _lifetime?.Cancel();
            _lifetime?.Dispose();
        }
    }
}
#endif
