using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HiveChameleon.Presentation;
using Nakama;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    [DisallowMultipleComponent]
    public sealed class DevelopmentRealtimeBootstrap : MonoBehaviour
    {
        private readonly CancellationTokenSource _shutdown = new CancellationTokenSource();
        private readonly SemaphoreSlim _connectGate = new SemaphoreSlim(1, 1);
        private DevelopmentLobbyPanel _menu;
        private OfficialArenaExperience _experience;
        private NakamaRealtimeConnection _connection;
        private NakamaRealtimeConnection _experienceConnection;
        private string _applicationPlayerId = string.Empty;
        private string _resolvedApiBaseUrl = string.Empty;
        private string _resolvedServerKey = string.Empty;
        private string _resolvedBearerToken = string.Empty;
        private bool _gameplayActive;

        private void Start()
        {
            _experience = GetComponent<OfficialArenaExperience>();
            if (_experience != null)
            {
                _experience.enabled = false;
            }

            _menu = GetComponent<DevelopmentLobbyPanel>();
            if (_menu == null)
            {
                _menu = gameObject.AddComponent<DevelopmentLobbyPanel>();
            }

            bool configured = AuthoritativeDevelopmentCredentials.TryResolve(
                out AuthoritativeDevelopmentCredential credential
            );
            if (configured)
            {
                _resolvedApiBaseUrl = credential.ApiBaseUrl;
                _resolvedServerKey = credential.NakamaServerKey;
                _resolvedBearerToken = credential.BearerToken;
            }
            _menu.InitializeEntry(
                configured,
                configured
                    ? "Ready to play online."
                    : "Online play is currently unavailable.",
                configured ? ConnectAsync : null,
                _shutdown.Token
            );
            if (configured)
            {
                _ = TryRestoreOnStartupAsync(_shutdown.Token);
            }
        }

        private void Update()
        {
            if (
                _gameplayActive
                && (
                    _connection == null
                    || _connection.State != RealtimeConnectionState.Connected
                )
            )
            {
                DeactivateGameplay();
                _menu?.NotifyConnectionLost();
            }
        }

        private async Task ConnectAsync(CancellationToken cancellationToken)
        {
            await ConnectAsync(null, cancellationToken);
        }

        private async Task ConnectAsync(
            ReconnectDescriptor preferredReconnect,
            CancellationToken cancellationToken
        )
        {
            await _connectGate.WaitAsync(cancellationToken);
            try
            {
                if (
                    _connection != null
                    && _connection.State == RealtimeConnectionState.Connected
                )
                {
                    return;
                }

                string interruptedLobbyId = _connection?.CurrentLobby?.id ?? string.Empty;
                if (await TryReconnectAsync(cancellationToken))
                {
                    return;
                }

                await ReleaseConnectionAsync();
                cancellationToken.ThrowIfCancellationRequested();

                IRealtimeCredentialProvider credentialProvider =
                    new HttpRealtimeCredentialProvider(
                        _resolvedApiBaseUrl,
                        _resolvedBearerToken
                    );
                ReconnectDescriptor reconnect =
                    preferredReconnect
                    ?? await credentialProvider.GetReconnectDescriptorAsync(
                        cancellationToken
                    );
                RealtimeSessionCredential credential =
                    await credentialProvider.GetCredentialAsync(cancellationToken);
                var connection = new NakamaRealtimeConnection(_resolvedServerKey);
                try
                {
                    await connection.ConnectAsync(credential, cancellationToken);
                    cancellationToken.ThrowIfCancellationRequested();

                    _connection = connection;
                    _connection.RoundStateChanged += HandleRoundStateChanged;
                    _connection.LobbyStateChanged += HandleLobbyStateChanged;
                    _applicationPlayerId = ResolveApplicationPlayerId(credential);
                    if (reconnect.Available)
                    {
                        await connection.RestoreLobbyAsync(
                            reconnect.LobbyId,
                            cancellationToken
                        );
                    }
                    _menu.BindConnection(
                        connection,
                        _applicationPlayerId
                    );
                    _menu.PrefillLobbyCode(interruptedLobbyId);

                    if (LobbyMenuRules.IsGameplayRound(connection.CurrentRound))
                    {
                        ActivateGameplay(connection.CurrentRound);
                    }
                }
                catch
                {
                    await connection.CloseAsync();
                    if (ReferenceEquals(_connection, connection))
                    {
                        DetachConnection(connection);
                        _connection = null;
                    }
                    throw;
                }
            }
            finally
            {
                _connectGate.Release();
            }
        }

        private async Task TryRestoreOnStartupAsync(
            CancellationToken cancellationToken
        )
        {
            try
            {
                IRealtimeCredentialProvider credentialProvider =
                    new HttpRealtimeCredentialProvider(
                        _resolvedApiBaseUrl,
                        _resolvedBearerToken
                    );
                ReconnectDescriptor reconnect =
                    await credentialProvider.GetReconnectDescriptorAsync(
                        cancellationToken
                    );
                if (reconnect.Available)
                {
                    await ConnectAsync(reconnect, cancellationToken);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
            catch (Exception exception)
            {
                Debug.LogWarning(
                    $"Could not restore the interrupted online session: {exception.Message}"
                );
            }
        }

        private async Task<bool> TryReconnectAsync(
            CancellationToken cancellationToken
        )
        {
            NakamaRealtimeConnection connection = _connection;
            if (
                connection == null
                || !LobbyMenuRules.CanAttemptReconnect(
                    connection.State,
                    connection.CurrentLobby
                )
            )
            {
                return false;
            }

            try
            {
                await connection.ReconnectAsync(cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                _menu.BindConnection(connection, _applicationPlayerId);
                if (LobbyMenuRules.IsGameplayRound(connection.CurrentRound))
                {
                    ActivateGameplay(connection.CurrentRound);
                }
                return true;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch
            {
                return false;
            }
        }

        private void HandleRoundStateChanged(RoundSnapshot round)
        {
            if (LobbyMenuRules.IsGameplayRound(round))
            {
                ActivateGameplay(round);
            }
            else
            {
                DeactivateGameplay();
            }
        }

        private void HandleLobbyStateChanged(LobbySnapshot lobby)
        {
            if (lobby == null || lobby.closed)
            {
                DeactivateGameplay();
            }
        }

        private void ActivateGameplay(RoundSnapshot round)
        {
            if (
                !LobbyMenuRules.IsGameplayRound(round)
                || _connection == null
                || _connection.State != RealtimeConnectionState.Connected
                || _experience == null
            )
            {
                return;
            }

            if (!ReferenceEquals(_experienceConnection, _connection))
            {
                _experience.Initialize(
                    _connection,
                    _shutdown.Token,
                    LeaveActiveLobbyAsync
                );
                _experienceConnection = _connection;
            }
            _experience.enabled = true;
            _gameplayActive = true;
            _menu?.SetGameplayActive(true);
        }

        private void DeactivateGameplay()
        {
            _gameplayActive = false;
            if (_experience != null)
            {
                _experience.enabled = false;
            }
            _menu?.SetGameplayActive(false);
        }

        private async Task LeaveActiveLobbyAsync(
            CancellationToken cancellationToken
        )
        {
            NakamaRealtimeConnection connection = _connection;
            if (
                connection == null
                || connection.State != RealtimeConnectionState.Connected
                || connection.CurrentLobby == null
            )
            {
                throw new InvalidOperationException(
                    "The lobby connection is no longer available."
                );
            }

            await connection.LeaveLobbyAsync(cancellationToken);
            if (ReferenceEquals(_connection, connection))
            {
                DeactivateGameplay();
            }
        }

        private async Task ReleaseConnectionAsync()
        {
            DeactivateGameplay();
            NakamaRealtimeConnection connection = _connection;
            if (connection == null)
            {
                return;
            }

            DetachConnection(connection);
            _connection = null;
            _applicationPlayerId = string.Empty;
            _menu?.ClearConnection(connection.CurrentLobby?.id ?? string.Empty);
            await connection.CloseAsync();
        }

        private void DetachConnection(NakamaRealtimeConnection connection)
        {
            connection.RoundStateChanged -= HandleRoundStateChanged;
            connection.LobbyStateChanged -= HandleLobbyStateChanged;
        }

        private async void OnDestroy()
        {
            _shutdown.Cancel();
            await ReleaseConnectionAsync();
            _shutdown.Dispose();
        }

        private static string ResolveApplicationPlayerId(
            RealtimeSessionCredential credential
        )
        {
            ISession session = Session.Restore(credential.NakamaToken);
            IDictionary<string, string> variables = session.Vars;
            return variables != null
                && variables.TryGetValue("app_player_id", out string playerId)
                    ? playerId
                    : string.Empty;
        }
    }
}
