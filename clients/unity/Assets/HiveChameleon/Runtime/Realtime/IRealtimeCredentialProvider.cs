using System.Threading;
using System.Threading.Tasks;

namespace HiveChameleon.Realtime
{
    public interface IRealtimeCredentialProvider
    {
        Task<RealtimeSessionCredential> GetCredentialAsync(CancellationToken cancellationToken);

        Task<ReconnectDescriptor> GetReconnectDescriptorAsync(
            CancellationToken cancellationToken
        );
    }
}
