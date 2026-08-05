using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    public sealed class NakamaRealtimeConnection : IRealtimeConnection
    {
        private const long LobbyStateOpcode = 1;
        private const long RoundRoleAssignedOpcode = 2;
        private const long RoundPhaseChangedOpcode = 3;
        private const long RoundDiscoveryOpcode = 4;
        private const long RoundPlayerStateOpcode = 5;
        private const long HunterFireResultOpcode = 6;
        private const long RoundSpectatorOpcode = 7;
        private const long RoundScoreOpcode = 8;
        private const long RoundAnswerCheckOpcode = 9;
        private const long HunterFireCommandOpcode = 10;
        private const long AnswerCheckLikeOpcode = 11;
        private const long AnswerCheckLikeResultOpcode = 12;
        private const long RoundReconnectOpcode = 13;
        private const long AvatarStateCommandOpcode = 14;
        private const long AvatarStateSnapshotOpcode = 15;
        private const float MinimumAvatarPitch = -58f;
        private const float MaximumAvatarPitch = 62f;

        private readonly string _serverKey;
        private IClient _client;
        private ISession _session;
        private ISocket _socket;
        private IMatch _match;
        private string _expectedJoiningMatchId = string.Empty;
        private readonly Dictionary<string, int> _avatarSequenceByPlayer =
            new Dictionary<string, int>();

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

        public RoundSnapshot CurrentRound { get; private set; }

        public RoundRoleAssignment CurrentRoleAssignment { get; private set; }

        public RoundPlayerState CurrentRoundPlayerState { get; private set; }

        public RoundDiscoverySnapshot LastDiscovery { get; private set; }

        public HunterFireResult LastFireResult { get; private set; }

        public SpectatorStateSnapshot CurrentSpectatorState { get; private set; }

        public AnswerCheckSnapshot CurrentAnswerCheck { get; private set; }

        public RoundScoreSnapshot CurrentScores { get; private set; }

        public AnswerCheckLikeResult LastLikeResult { get; private set; }

        public RoundReconnectSnapshot CurrentReconnectState { get; private set; }

        public event Action<LobbySnapshot> LobbyStateChanged;

        public event Action<RoundSnapshot> RoundStateChanged;

        public event Action<RoundRoleAssignment> RoundRoleAssigned;

        public event Action<RoundPlayerState> RoundPlayerStateChanged;

        public event Action<RoundDiscoverySnapshot> RoundDiscoveryReceived;

        public event Action<HunterFireResult> HunterFireResolved;

        public event Action<SpectatorStateSnapshot> SpectatorStateChanged;

        public event Action<AnswerCheckSnapshot> AnswerCheckChanged;

        public event Action<RoundScoreSnapshot> RoundScoresChanged;

        public event Action<AnswerCheckLikeResult> AnswerCheckLikeResolved;

        public event Action<RoundReconnectSnapshot> RoundReconnectChanged;

        public event Action<AvatarStateSnapshot> AvatarStateReceived;

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
            AttachSocketHandlers(_socket);

            try
            {
                await _socket.ConnectAsync(_session, appearOnline: true);
                cancellationToken.ThrowIfCancellationRequested();
                State = RealtimeConnectionState.Connected;
                Debug.Log("Nakama socket connected.");
            }
            catch
            {
                State = RealtimeConnectionState.Faulted;
                await CloseSocketIgnoringErrorsAsync();
                throw;
            }
        }

        public async Task<LobbyRpcResponse> ReconnectAsync(
            CancellationToken cancellationToken
        )
        {
            if (
                State != RealtimeConnectionState.Disconnected
                && State != RealtimeConnectionState.Faulted
            )
            {
                throw new InvalidOperationException(
                    $"Cannot reconnect while realtime state is {State}."
                );
            }
            if (
                _client == null
                || _session == null
                || CurrentLobby == null
                || string.IsNullOrWhiteSpace(CurrentLobby.id)
            )
            {
                throw new InvalidOperationException(
                    "No interrupted lobby session is available to reconnect."
                );
            }
            if (_session.IsExpired)
            {
                throw new InvalidOperationException(
                    "Nakama session expired before the reconnect attempt."
                );
            }

            cancellationToken.ThrowIfCancellationRequested();
            State = RealtimeConnectionState.Connecting;
            await CloseSocketForReconnectIgnoringErrorsAsync();
            try
            {
                IApiRpc rpc = await _client.RpcAsync(
                    _session,
                    "match.reconnect",
                    JsonUtility.ToJson(
                        new MatchReconnectCommand { lobby_id = CurrentLobby.id }
                    ),
                    canceller: cancellationToken
                );
                cancellationToken.ThrowIfCancellationRequested();
                LobbyRpcResponse response =
                    JsonUtility.FromJson<LobbyRpcResponse>(rpc.Payload);
                ValidateReconnectResponse(response, CurrentLobby.id);
                PublishLobby(response.lobby);
                if (response.round != null && !string.IsNullOrWhiteSpace(response.round.id))
                {
                    PublishRound(response.round);
                }
                CurrentReconnectState = response.reconnect;
                RoundReconnectChanged?.Invoke(response.reconnect);

                _socket = _client.NewSocket(useMainThread: true);
                AttachSocketHandlers(_socket);
                await _socket.ConnectAsync(_session, appearOnline: true);
                cancellationToken.ThrowIfCancellationRequested();
                await JoinAuthoritativeLobbyAsync(response.match_id, cancellationToken);
                State = RealtimeConnectionState.Connected;
                return response;
            }
            catch
            {
                await CloseSocketForReconnectIgnoringErrorsAsync();
                State = RealtimeConnectionState.Faulted;
                throw;
            }
        }

        public async Task<LobbyRpcResponse> RestoreLobbyAsync(
            string lobbyId,
            CancellationToken cancellationToken
        )
        {
            RequireConnected();
            if (!LobbyMenuRules.IsUuidV7(lobbyId))
            {
                throw new ArgumentException(
                    "A valid reconnect lobby ID is required.",
                    nameof(lobbyId)
                );
            }
            if (CurrentLobby != null || _match != null)
            {
                throw new InvalidOperationException(
                    "Leave the current lobby before restoring another one."
                );
            }

            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                IApiRpc rpc = await _client.RpcAsync(
                    _session,
                    "match.reconnect",
                    JsonUtility.ToJson(
                        new MatchReconnectCommand { lobby_id = lobbyId.Trim() }
                    ),
                    canceller: cancellationToken
                );
                cancellationToken.ThrowIfCancellationRequested();
                LobbyRpcResponse response =
                    JsonUtility.FromJson<LobbyRpcResponse>(rpc.Payload);
                ValidateReconnectResponse(response, lobbyId.Trim());

                PublishLobby(response.lobby);
                if (response.round != null && !string.IsNullOrWhiteSpace(response.round.id))
                {
                    PublishRound(response.round);
                }
                CurrentReconnectState = response.reconnect;
                RoundReconnectChanged?.Invoke(response.reconnect);
                await JoinAuthoritativeLobbyAsync(response.match_id, cancellationToken);
                return response;
            }
            catch
            {
                ClearLobbyState();
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
            await JoinLobbyMatchOrRollbackAsync(response, cancellationToken);
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
            await JoinLobbyMatchOrRollbackAsync(response, cancellationToken);
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

        public Task<LobbyRpcResponse> NominateHunterAsync(
            bool nominated,
            CancellationToken cancellationToken
        )
        {
            LobbySnapshot lobby = RequireCurrentLobby();
            return CallLobbyRpcAsync(
                "lobby.nominate_hunter",
                new NominateHunterCommand
                {
                    lobby_id = lobby.id,
                    expected_lobby_version = lobby.row_version,
                    nominated = nominated,
                },
                cancellationToken
            );
        }

        public async Task<string> FireHunterAsync(
            string targetPlayerId,
            float aimYaw,
            float aimPitch,
            CancellationToken cancellationToken
        )
        {
            RequireConnected();
            if (_match == null || string.IsNullOrWhiteSpace(_match.Id))
            {
                throw new InvalidOperationException("Join an authoritative lobby match first.");
            }
            if (
                CurrentRound == null
                || string.IsNullOrWhiteSpace(CurrentRound.id)
                || CurrentRound.status != "hunting"
            )
            {
                throw new InvalidOperationException(
                    "Hunter fire is available only during the hunting phase."
                );
            }
            string currentRole = CurrentRoundPlayerState?.role
                ?? CurrentRoleAssignment?.role;
            if (currentRole != "hunter")
            {
                throw new InvalidOperationException(
                    "Only a server-assigned Hunter can send a fire intent."
                );
            }
            if (
                !IsFinite(aimYaw)
                || !IsFinite(aimPitch)
                || aimPitch < MinimumAvatarPitch
                || aimPitch > MaximumAvatarPitch
            )
            {
                throw new ArgumentOutOfRangeException(
                    nameof(aimPitch),
                    "Hunter aim is outside the authoritative range."
                );
            }
            cancellationToken.ThrowIfCancellationRequested();
            var command = new HunterFireCommand
            {
                command_id = Guid.NewGuid().ToString("N"),
                target_player_id = targetPlayerId?.Trim() ?? string.Empty,
                aim_yaw = Mathf.Repeat(aimYaw, 360f),
                aim_pitch = aimPitch,
            };
            await _socket.SendMatchStateAsync(
                _match.Id,
                HunterFireCommandOpcode,
                JsonUtility.ToJson(command)
            );
            cancellationToken.ThrowIfCancellationRequested();
            return command.command_id;
        }

        public async Task SendAvatarStateAsync(
            AvatarStateCommand command,
            CancellationToken cancellationToken
        )
        {
            RequireConnected();
            if (command == null)
            {
                throw new ArgumentNullException(nameof(command));
            }
            if (_match == null || string.IsNullOrWhiteSpace(_match.Id))
            {
                throw new InvalidOperationException("Join an authoritative lobby match first.");
            }
            if (
                CurrentRound == null
                || string.IsNullOrWhiteSpace(CurrentRound.id)
                || (
                    CurrentRound.status != "preparing"
                    && CurrentRound.status != "hiding"
                    && CurrentRound.status != "hunting"
                    && CurrentRound.status != "answer_check"
                )
            )
            {
                return;
            }

            cancellationToken.ThrowIfCancellationRequested();
            await _socket.SendMatchStateAsync(
                _match.Id,
                AvatarStateCommandOpcode,
                JsonUtility.ToJson(command)
            );
            cancellationToken.ThrowIfCancellationRequested();
        }

        public async Task<string> LikeDisguiseAsync(
            string targetHiderPlayerId,
            CancellationToken cancellationToken
        )
        {
            RequireConnected();
            if (_match == null || string.IsNullOrWhiteSpace(_match.Id))
            {
                throw new InvalidOperationException("Join an authoritative lobby match first.");
            }
            if (
                CurrentRound == null
                || CurrentRound.status != "answer_check"
                || CurrentAnswerCheck == null
            )
            {
                throw new InvalidOperationException(
                    "Disguise likes are available only during Answer Check."
                );
            }
            if (string.IsNullOrWhiteSpace(targetHiderPlayerId))
            {
                throw new ArgumentException(
                    "A revealed Hider player ID is required.",
                    nameof(targetHiderPlayerId)
                );
            }

            cancellationToken.ThrowIfCancellationRequested();
            var command = new AnswerCheckLikeCommand
            {
                command_id = Guid.NewGuid().ToString("N"),
                target_hider_player_id = targetHiderPlayerId,
            };
            await _socket.SendMatchStateAsync(
                _match.Id,
                AnswerCheckLikeOpcode,
                JsonUtility.ToJson(command)
            );
            cancellationToken.ThrowIfCancellationRequested();
            return command.command_id;
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
            CurrentLobby = null;
            CurrentRound = null;
            ClearPerRoundState();
            LobbyStateChanged?.Invoke(null);
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
            if (response.round != null && !string.IsNullOrWhiteSpace(response.round.id))
            {
                PublishRound(response.round);
            }
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
            _expectedJoiningMatchId = matchId;
            try
            {
                IMatch joinedMatch = await _socket.JoinMatchAsync(matchId);
                if (
                    joinedMatch == null
                    || !string.Equals(
                        joinedMatch.Id,
                        matchId,
                        StringComparison.Ordinal
                    )
                )
                {
                    throw new InvalidOperationException(
                        "Nakama joined an unexpected authoritative match."
                    );
                }
                _match = joinedMatch;
                cancellationToken.ThrowIfCancellationRequested();
            }
            finally
            {
                _expectedJoiningMatchId = string.Empty;
            }
        }

        private async Task JoinLobbyMatchOrRollbackAsync(
            LobbyRpcResponse response,
            CancellationToken cancellationToken
        )
        {
            try
            {
                await JoinAuthoritativeLobbyAsync(
                    response.match_id,
                    cancellationToken
                );
            }
            catch
            {
                await RollbackFailedLobbyJoinAsync(response.lobby?.id);
                throw;
            }
        }

        private async Task RollbackFailedLobbyJoinAsync(string lobbyId)
        {
            if (
                !string.IsNullOrWhiteSpace(lobbyId)
                && _client != null
                && _session != null
                && !_session.IsExpired
            )
            {
                try
                {
                    await _client.RpcAsync(
                        _session,
                        "lobby.leave",
                        JsonUtility.ToJson(
                            new LeaveLobbyCommand { lobby_id = lobbyId }
                        ),
                        canceller: CancellationToken.None
                    );
                }
                catch (Exception exception)
                {
                    Debug.LogWarning(
                        $"Could not roll back failed lobby join: {exception.Message}"
                    );
                }
            }

            _match = null;
            _expectedJoiningMatchId = string.Empty;
            CurrentLobby = null;
            CurrentRound = null;
            ClearPerRoundState();
            LobbyStateChanged?.Invoke(null);
        }

        private void ClearLobbyState()
        {
            _match = null;
            _expectedJoiningMatchId = string.Empty;
            CurrentLobby = null;
            CurrentRound = null;
            ClearPerRoundState();
            LobbyStateChanged?.Invoke(null);
        }

        private static void ValidateReconnectResponse(
            LobbyRpcResponse response,
            string expectedLobbyId
        )
        {
            if (
                response == null
                || response.lobby == null
                || !string.Equals(
                    response.lobby.id,
                    expectedLobbyId,
                    StringComparison.Ordinal
                )
                || string.IsNullOrWhiteSpace(response.match_id)
                || response.reconnect == null
                || !response.reconnect.outcome_preserved
            )
            {
                throw new InvalidOperationException(
                    "match.reconnect returned an invalid reservation."
                );
            }
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

            DetachSocketHandlers(socket);
            try
            {
                await socket.CloseAsync();
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Nakama socket cleanup failed: {exception.Message}");
            }
            _match = null;
            _expectedJoiningMatchId = string.Empty;
            _session = null;
            _client = null;
            CurrentLobby = null;
            CurrentRound = null;
            ClearPerRoundState();
        }

        private async Task CloseSocketForReconnectIgnoringErrorsAsync()
        {
            ISocket socket = _socket;
            _socket = null;
            _match = null;
            _expectedJoiningMatchId = string.Empty;
            if (socket == null)
            {
                return;
            }
            DetachSocketHandlers(socket);
            try
            {
                await socket.CloseAsync();
            }
            catch (Exception exception)
            {
                Debug.LogWarning(
                    $"Interrupted Nakama socket cleanup failed: {exception.Message}"
                );
            }
        }

        private void AttachSocketHandlers(ISocket socket)
        {
            socket.Connected += HandleConnected;
            socket.Closed += HandleClosed;
            socket.ReceivedError += HandleError;
            socket.ReceivedMatchState += HandleMatchState;
        }

        private void DetachSocketHandlers(ISocket socket)
        {
            socket.Connected -= HandleConnected;
            socket.Closed -= HandleClosed;
            socket.ReceivedError -= HandleError;
            socket.ReceivedMatchState -= HandleMatchState;
        }

        private void HandleConnected()
        {
            State = RealtimeConnectionState.Connected;
        }

        private void HandleClosed(string reason)
        {
            State = RealtimeConnectionState.Disconnected;
            _match = null;
            _expectedJoiningMatchId = string.Empty;
            Debug.LogWarning($"Nakama socket closed: {reason}");
        }

        private void HandleError(Exception exception)
        {
            State = RealtimeConnectionState.Faulted;
            Debug.LogWarning($"Nakama socket error: {exception.Message}");
        }

        private void HandleMatchState(IMatchState matchState)
        {
            if (
                matchState == null
                || matchState.State == null
                || !IsExpectedMatch(matchState.MatchId)
            )
            {
                return;
            }
            try
            {
                string payload = Encoding.UTF8.GetString(matchState.State);
                switch (matchState.OpCode)
                {
                    case LobbyStateOpcode:
                        LobbySnapshot lobby = JsonUtility.FromJson<LobbySnapshot>(payload);
                        if (lobby == null || string.IsNullOrWhiteSpace(lobby.id))
                        {
                            throw new InvalidOperationException("Lobby state payload is invalid.");
                        }
                        PublishLobby(lobby);
                        break;
                    case RoundRoleAssignedOpcode:
                        RoundRoleAssignment assignment =
                            JsonUtility.FromJson<RoundRoleAssignment>(payload);
                        if (
                            assignment == null
                            || string.IsNullOrWhiteSpace(assignment.round_id)
                            || string.IsNullOrWhiteSpace(assignment.player_id)
                            || (assignment.role != "hunter" && assignment.role != "hider")
                        )
                        {
                            throw new InvalidOperationException(
                                "Private round role payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(assignment.round_id))
                        {
                            return;
                        }
                        CurrentRoleAssignment = assignment;
                        RoundRoleAssigned?.Invoke(assignment);
                        break;
                    case RoundPhaseChangedOpcode:
                        RoundSnapshot round = JsonUtility.FromJson<RoundSnapshot>(payload);
                        if (round == null || string.IsNullOrWhiteSpace(round.id))
                        {
                            throw new InvalidOperationException("Round phase payload is invalid.");
                        }
                        PublishRound(round);
                        break;
                    case RoundDiscoveryOpcode:
                        RoundDiscoverySnapshot discovery =
                            JsonUtility.FromJson<RoundDiscoverySnapshot>(payload);
                        if (
                            discovery == null
                            || string.IsNullOrWhiteSpace(discovery.round_id)
                            || string.IsNullOrWhiteSpace(discovery.hunter_player_id)
                            || string.IsNullOrWhiteSpace(discovery.hider_player_id)
                            || discovery.sequence < 1
                        )
                        {
                            throw new InvalidOperationException(
                                "Authoritative discovery payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(discovery.round_id))
                        {
                            return;
                        }
                        LastDiscovery = discovery;
                        RoundDiscoveryReceived?.Invoke(discovery);
                        break;
                    case RoundPlayerStateOpcode:
                        RoundPlayerState playerState =
                            JsonUtility.FromJson<RoundPlayerState>(payload);
                        if (
                            playerState == null
                            || string.IsNullOrWhiteSpace(playerState.round_id)
                            || string.IsNullOrWhiteSpace(playerState.player_id)
                            || (playerState.role != "hunter" && playerState.role != "hider")
                            || (
                                playerState.status != "active"
                                && playerState.status != "found"
                                && playerState.status != "converted"
                            )
                            || playerState.shells_remaining < 0
                        )
                        {
                            throw new InvalidOperationException(
                                "Private round player-state payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(playerState.round_id))
                        {
                            return;
                        }
                        CurrentRoundPlayerState = playerState;
                        RoundPlayerStateChanged?.Invoke(playerState);
                        break;
                    case HunterFireResultOpcode:
                        HunterFireResult fireResult =
                            JsonUtility.FromJson<HunterFireResult>(payload);
                        if (
                            fireResult == null
                            || string.IsNullOrWhiteSpace(fireResult.round_id)
                            || string.IsNullOrWhiteSpace(fireResult.reason)
                            || fireResult.shells_remaining < 0
                        )
                        {
                            throw new InvalidOperationException(
                                "Private Hunter fire-result payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(fireResult.round_id))
                        {
                            return;
                        }
                        LastFireResult = fireResult;
                        HunterFireResolved?.Invoke(fireResult);
                        break;
                    case RoundSpectatorOpcode:
                        SpectatorStateSnapshot spectator =
                            JsonUtility.FromJson<SpectatorStateSnapshot>(payload);
                        if (
                            spectator == null
                            || string.IsNullOrWhiteSpace(spectator.round_id)
                        )
                        {
                            throw new InvalidOperationException(
                                "Private spectator-state payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(spectator.round_id))
                        {
                            return;
                        }
                        CurrentSpectatorState = spectator;
                        SpectatorStateChanged?.Invoke(spectator);
                        break;
                    case RoundScoreOpcode:
                        RoundScoreSnapshot scores =
                            JsonUtility.FromJson<RoundScoreSnapshot>(payload);
                        if (
                            scores == null
                            || string.IsNullOrWhiteSpace(scores.round_id)
                            || string.IsNullOrWhiteSpace(scores.scoring_rule_version)
                            || scores.batch_sequence < 1
                        )
                        {
                            throw new InvalidOperationException(
                                "Round score payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(scores.round_id))
                        {
                            return;
                        }
                        if (
                            CurrentScores == null
                            || CurrentScores.round_id != scores.round_id
                            || scores.batch_sequence
                                > CurrentScores.batch_sequence
                        )
                        {
                            CurrentScores = scores;
                            RoundScoresChanged?.Invoke(scores);
                        }
                        break;
                    case RoundAnswerCheckOpcode:
                        AnswerCheckSnapshot answerCheck =
                            JsonUtility.FromJson<AnswerCheckSnapshot>(payload);
                        if (
                            answerCheck == null
                            || string.IsNullOrWhiteSpace(answerCheck.round_id)
                            || string.IsNullOrWhiteSpace(answerCheck.deadline)
                        )
                        {
                            throw new InvalidOperationException(
                                "Answer Check payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(answerCheck.round_id))
                        {
                            return;
                        }
                        CurrentAnswerCheck = answerCheck;
                        AnswerCheckChanged?.Invoke(answerCheck);
                        break;
                    case AnswerCheckLikeResultOpcode:
                        AnswerCheckLikeResult likeResult =
                            JsonUtility.FromJson<AnswerCheckLikeResult>(payload);
                        if (
                            likeResult == null
                            || string.IsNullOrWhiteSpace(likeResult.round_id)
                            || string.IsNullOrWhiteSpace(likeResult.reason)
                        )
                        {
                            throw new InvalidOperationException(
                                "Answer Check like-result payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(likeResult.round_id))
                        {
                            return;
                        }
                        LastLikeResult = likeResult;
                        AnswerCheckLikeResolved?.Invoke(likeResult);
                        break;
                    case RoundReconnectOpcode:
                        RoundReconnectSnapshot reconnect =
                            JsonUtility.FromJson<RoundReconnectSnapshot>(payload);
                        if (
                            reconnect == null
                            || string.IsNullOrWhiteSpace(reconnect.round_id)
                            || string.IsNullOrWhiteSpace(reconnect.player_id)
                            || reconnect.status != "restored"
                            || !reconnect.outcome_preserved
                        )
                        {
                            throw new InvalidOperationException(
                                "Private reconnect-state payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(reconnect.round_id))
                        {
                            return;
                        }
                        CurrentReconnectState = reconnect;
                        RoundReconnectChanged?.Invoke(reconnect);
                        break;
                    case AvatarStateSnapshotOpcode:
                        AvatarStateSnapshot avatar =
                            JsonUtility.FromJson<AvatarStateSnapshot>(payload);
                        if (
                            avatar == null
                            || string.IsNullOrWhiteSpace(avatar.round_id)
                            || string.IsNullOrWhiteSpace(avatar.player_id)
                            || (avatar.role != "hunter" && avatar.role != "hider")
                            || !IsFinite(avatar.pitch)
                            || avatar.pitch < MinimumAvatarPitch
                            || avatar.pitch > MaximumAvatarPitch
                            || avatar.sequence < 1
                        )
                        {
                            throw new InvalidOperationException(
                                "Avatar-state payload is invalid."
                            );
                        }
                        if (!IsCurrentRound(avatar.round_id))
                        {
                            return;
                        }
                        bool isLocalAvatar =
                            string.Equals(
                                avatar.player_id,
                                CurrentRoundPlayerState?.player_id,
                                StringComparison.Ordinal
                            )
                            || string.Equals(
                                avatar.player_id,
                                CurrentRoleAssignment?.player_id,
                                StringComparison.Ordinal
                            );
                        bool missingLastSequence =
                            !_avatarSequenceByPlayer.TryGetValue(
                                avatar.player_id,
                                out int lastSequence
                            );
                        if (
                            missingLastSequence
                            || avatar.sequence > lastSequence
                            || (
                                avatar.correction
                                && isLocalAvatar
                                && avatar.sequence == lastSequence
                            )
                        )
                        {
                            if (missingLastSequence || avatar.sequence > lastSequence)
                            {
                                _avatarSequenceByPlayer[avatar.player_id] =
                                    avatar.sequence;
                            }
                            AvatarStateReceived?.Invoke(avatar);
                        }
                        break;
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Could not apply authoritative match state: {exception.Message}");
            }
        }

        private void PublishLobby(LobbySnapshot lobby)
        {
            CurrentLobby = lobby;
            LobbyStateChanged?.Invoke(lobby);
        }

        private void PublishRound(RoundSnapshot round)
        {
            if (
                CurrentRound != null
                && !string.Equals(
                    CurrentRound.id,
                    round.id,
                    StringComparison.Ordinal
                )
                && round.sequence_number <= CurrentRound.sequence_number
            )
            {
                return;
            }
            if (CurrentRound == null || CurrentRound.id != round.id)
            {
                ClearPerRoundState();
            }
            CurrentRound = round;
            RoundStateChanged?.Invoke(round);
        }

        private bool IsExpectedMatch(string matchId)
        {
            if (string.IsNullOrWhiteSpace(matchId))
            {
                return false;
            }
            if (!string.IsNullOrWhiteSpace(_expectedJoiningMatchId))
            {
                return string.Equals(
                    matchId,
                    _expectedJoiningMatchId,
                    StringComparison.Ordinal
                );
            }
            return _match != null
                && !string.IsNullOrWhiteSpace(_match.Id)
                && string.Equals(
                    matchId,
                    _match.Id,
                    StringComparison.Ordinal
                );
        }

        private bool IsCurrentRound(string roundId)
        {
            return CurrentRound != null
                && !string.IsNullOrWhiteSpace(CurrentRound.id)
                && string.Equals(
                    roundId,
                    CurrentRound.id,
                    StringComparison.Ordinal
                );
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private void ClearPerRoundState()
        {
            CurrentRoleAssignment = null;
            CurrentRoundPlayerState = null;
            LastDiscovery = null;
            LastFireResult = null;
            CurrentSpectatorState = null;
            CurrentAnswerCheck = null;
            CurrentScores = null;
            LastLikeResult = null;
            CurrentReconnectState = null;
            _avatarSequenceByPlayer.Clear();
        }
    }
}
