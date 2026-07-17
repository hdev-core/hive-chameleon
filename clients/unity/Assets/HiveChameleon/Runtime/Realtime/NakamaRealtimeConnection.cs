using System;
using System.Threading;
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    public sealed class NakamaRealtimeConnection : IRealtimeConnection
    {
        private readonly string _serverKey;
        private ISocket _socket;

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
            IClient client = new Client(
                httpScheme,
                credential.SocketUri.Host,
                port,
                _serverKey,
                UnityWebRequestAdapter.Instance
            );
            ISession session = Session.Restore(credential.NakamaToken);
            if (session.IsExpired)
            {
                State = RealtimeConnectionState.Faulted;
                throw new InvalidOperationException("Nakama session token is expired.");
            }

            _socket = client.NewSocket(useMainThread: true);
            _socket.Connected += HandleConnected;
            _socket.Closed += HandleClosed;
            _socket.ReceivedError += HandleError;

            try
            {
                await _socket.ConnectAsync(session, appearOnline: true);
                cancellationToken.ThrowIfCancellationRequested();
                State = RealtimeConnectionState.Connected;
                Debug.Log($"Nakama socket connected for user {session.UserId}.");
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
            try
            {
                await socket.CloseAsync();
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Nakama socket cleanup failed: {exception.Message}");
            }
        }

        private void HandleConnected()
        {
            State = RealtimeConnectionState.Connected;
        }

        private void HandleClosed(string reason)
        {
            State = RealtimeConnectionState.Disconnected;
            Debug.LogWarning($"Nakama socket closed: {reason}");
        }

        private void HandleError(Exception exception)
        {
            State = RealtimeConnectionState.Faulted;
            Debug.LogWarning($"Nakama socket error: {exception.Message}");
        }
    }
}
