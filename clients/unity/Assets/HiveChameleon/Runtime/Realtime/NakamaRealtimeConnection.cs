using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    public sealed class NakamaRealtimeConnection : IRealtimeConnection
    {
        private readonly string _serverKey;
        private IClient _client;
        private ISession _session;
        private ISocket _socket;
        private IMatch _match;

        public NakamaRealtimeConnection(string serverKey)
        {
            if (string.IsNullOrWhiteSpace(serverKey))
            {
                throw new ArgumentException("Nakama server key is required.", nameof(serverKey));
            }
            _serverKey = serverKey;
        }

        public RealtimeConnectionState State { get; private set; } =
            RealtimeConnectionState.Disconnected;

        public LobbySnapshot CurrentLobby { get; private set; }

        public event Action<LobbySnapshot> LobbyStateChanged;

        public async Task ConnectAsync(
            RealtimeSessionCredential credential,
            CancellationToken cancellationToken
        )
        {
            if (State != RealtimeConnectionState.Disconnected)
            {
                throw new InvalidOperationException($"Cannot connect while realtime state is {State}.");
            }
            if (credential.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                throw new InvalidOperationException("Nakama session expired before socket connection.");
            }

            cancellationToken.ThrowIfCancellationRequested();
            State = RealtimeConnectionState.Connecting;

            string httpScheme = credential.SocketUri.Scheme == "wss" ? "https" : "http";
            int port = credential.SocketUri.IsDefaultPort
                ? (credential.SocketUri.Scheme == "wss" ? 443 : 80)
                : credential.SocketUri.Port;
            _client = new Client(
                httpScheme,
                credential.SocketUri.Host,
                port,
                _serverKey,
                UnityWebRequestAdapter.Instance
            );
            _session = Session.Restore(credential.NakamaToken);
            if (_session.IsExpired)
            {
                State = RealtimeConnectionState.Faulted;
                throw new InvalidOperationException("Nakama session token is expired.");
            }

            _socket = _client.NewSocket(useMainThread: true);
            _socket.Connected += HandleConnected;
            _socket.Closed += HandleClosed;
            _socket.ReceivedError += HandleError;
            _socket.ReceivedMatchState += HandleMatchState;

            try
            {
                await _socket.ConnectAsync(_session, appearOnline: true);
                cancellationToken.ThrowIfCancellationRequested();
                State = RealtimeConnectionState.Connected;
                Debug.Log($"Nakama socket connected for user {_session.UserId}.");
            }
            catch
            {
                State = RealtimeConnectionState.Faulted;
                await CloseSocketIgnoringErrorsAsync();
                throw;
            }
        }

        public async Task CloseAsync()
        {
            if (_socket == null)
            {
                State = RealtimeConnectionState.Disconnected;
                return;
            }

            State = RealtimeConnectionState.Closing;
            await CloseSocketIgnoringErrorsAsync();
            State = RealtimeConnectionState.Disconnected;
        }

        public async Task<LobbyRpcResponse> CreateLobbyAsync(
            string name,
            string visibility,
            string password,
            int maxPlayers,
            string regionCode,
            CancellationToken cancellationToken
        )
        {
            var command = new CreateLobbyCommand
            {
                name = name,
                visibility = visibility,
                password = password,
                max_players = maxPlayers,
                region_code = regionCode,
            };
            LobbyRpcResponse response = await CallLobbyRpcAsync(
                "lobby.create",
                command,
                cancellationToken
            );
            await JoinAuthoritativeLobbyAsync(response.match_id, cancellationToken);
            return response;
        }

        public async Task<LobbyRpcResponse> JoinLobbyAsync(
            string lobbyId,
            string password,
            CancellationToken cancellationToken
        )
        {
            var command = new JoinLobbyCommand
            {
                lobby_id = lobbyId,
                password = password,
            };
            LobbyRpcResponse response = await CallLobbyRpcAsync(
                "lobby.join",
                command,
                cancellationToken
            );
            await JoinAuthoritativeLobbyAsync(response.match_id, cancellationToken);
            return response;
        }

        public Task<LobbyRpcResponse> UpdateLobbyConfigurationAsync(
            LobbyConfigurationDraft configuration,
            CancellationToken cancellationToken
        )
        {
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }
            LobbySnapshot lobby = RequireCurrentLobby();
            var command = new UpdateLobbyConfigurationCommand
            {
                lobby_id = lobby.id,
                expected_lobby_version = lobby.row_version,
                mode = configuration.Mode,
                map_version_id = configuration.MapVersionId,
                hunter_count = configuration.HunterCount,
                hiding_duration_seconds = configuration.HidingDurationSeconds,
                hunting_duration_seconds = configuration.HuntingDurationSeconds,
                taunt_enabled = configuration.TauntEnabled,
                taunt_interval_seconds = configuration.TauntIntervalSeconds,
                shell_limit = configuration.ShellLimit,
                reload_duration_ms = configuration.ReloadDurationMilliseconds,
                auto_start_enabled = configuration.AutoStartEnabled,
                auto_start_threshold = configuration.AutoStartThreshold,
            };
            return CallLobbyRpcAsync(
                "lobby.update_configuration",
                command,
                cancellationToken
            );
        }

        public Task<LobbyRpcResponse> StartLobbyAsync(CancellationToken cancellationToken)
        {
            LobbySnapshot lobby = RequireCurrentLobby();
            return CallLobbyRpcAsync(
                "lobby.start",
                new StartLobbyCommand
                {
                    lobby_id = lobby.id,
                    expected_lobby_version = lobby.row_version,
                },
                cancellationToken
            );
        }

        public async Task<LobbyRpcResponse> LeaveLobbyAsync(
            CancellationToken cancellationToken
        )
        {
            LobbySnapshot lobby = RequireCurrentLobby();
            LobbyRpcResponse response = await CallLobbyRpcAsync(
                "lobby.leave",
                new LeaveLobbyCommand { lobby_id = lobby.id },
                cancellationToken
            );
            _match = null;
            return response;
        }

        private async Task<LobbyRpcResponse> CallLobbyRpcAsync(
            string id,
            object command,
            CancellationToken cancellationToken
        )
        {
            RequireConnected();
            cancellationToken.ThrowIfCancellationRequested();
            string payload = JsonUtility.ToJson(command);
            IApiRpc rpc = await _client.RpcAsync(
                _session,
                id,
                payload,
                canceller: cancellationToken
            );
            cancellationToken.ThrowIfCancellationRequested();
            LobbyRpcResponse response = JsonUtility.FromJson<LobbyRpcResponse>(rpc.Payload);
            if (response == null || response.lobby == null || string.IsNullOrWhiteSpace(response.lobby.id))
            {
                throw new InvalidOperationException($"{id} returned an invalid lobby response.");
            }
            PublishLobby(response.lobby);
            return response;
        }

        private async Task JoinAuthoritativeLobbyAsync(
            string matchId,
            CancellationToken cancellationToken
        )
        {
            if (string.IsNullOrWhiteSpace(matchId))
            {
                throw new InvalidOperationException("Lobby response has no authoritative match ID.");
            }
            cancellationToken.ThrowIfCancellationRequested();
            _match = await _socket.JoinMatchAsync(matchId);
            cancellationToken.ThrowIfCancellationRequested();
        }

        private LobbySnapshot RequireCurrentLobby()
        {
            RequireConnected();
            if (CurrentLobby == null || string.IsNullOrWhiteSpace(CurrentLobby.id))
            {
                throw new InvalidOperationException("Join or create a lobby first.");
            }
            return CurrentLobby;
        }

        private void RequireConnected()
        {
            if (
                State != RealtimeConnectionState.Connected
                || _client == null
                || _session == null
                || _socket == null
            )
            {
                throw new InvalidOperationException("Nakama realtime connection is not ready.");
            }
        }

        private async Task CloseSocketIgnoringErrorsAsync()
        {
            ISocket socket = _socket;
            _socket = null;
            if (socket == null)
            {
                return;
            }

            socket.Connected -= HandleConnected;
            socket.Closed -= HandleClosed;
            socket.ReceivedError -= HandleError;
            socket.ReceivedMatchState -= HandleMatchState;
            try
            {
                await socket.CloseAsync();
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Nakama socket cleanup failed: {exception.Message}");
            }
            _match = null;
            _session = null;
            _client = null;
        }

        private void HandleConnected()
        {
            State = RealtimeConnectionState.Connected;
        }

        private void HandleClosed(string reason)
        {
            State = RealtimeConnectionState.Disconnected;
            _match = null;
            Debug.LogWarning($"Nakama socket closed: {reason}");
        }

        private void HandleError(Exception exception)
        {
            State = RealtimeConnectionState.Faulted;
            Debug.LogWarning($"Nakama socket error: {exception.Message}");
        }

        private void HandleMatchState(IMatchState matchState)
        {
            if (matchState == null || matchState.OpCode != 1 || matchState.State == null)
            {
                return;
            }
            try
            {
                string payload = Encoding.UTF8.GetString(matchState.State);
                LobbySnapshot lobby = JsonUtility.FromJson<LobbySnapshot>(payload);
                if (lobby == null || string.IsNullOrWhiteSpace(lobby.id))
                {
                    throw new InvalidOperationException("Lobby state payload is invalid.");
                }
                PublishLobby(lobby);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Could not apply lobby state: {exception.Message}");
            }
        }

        private void PublishLobby(LobbySnapshot lobby)
        {
            CurrentLobby = lobby;
            LobbyStateChanged?.Invoke(lobby);
        }
    }
}
