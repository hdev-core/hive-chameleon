using System.Threading;
using System.Threading.Tasks;

namespace HiveChameleon.Realtime
{
    public enum RealtimeConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
        Closing,
        Faulted,
    }

    public interface IRealtimeConnection
    {
        RealtimeConnectionState State { get; }

        Task ConnectAsync(
            RealtimeSessionCredential credential,
            CancellationToken cancellationToken
        );

        Task CloseAsync();
    }
}
