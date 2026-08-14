using System;
using System.IO;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    [Serializable]
    public sealed class AuthoritativeDevelopmentClient
    {
        public int slot;
        public string display_name = string.Empty;
        public string player_id = string.Empty;
        public string bearer_token = string.Empty;
        public string expires_at = string.Empty;
    }

    [Serializable]
    public sealed class AuthoritativeDevelopmentConfiguration
    {
        public int version;
        public string api_base_url = string.Empty;
        public string nakama_server_key = string.Empty;
        public int selected_client = 1;
        public string generated_at = string.Empty;
        public AuthoritativeDevelopmentClient[] clients =
            Array.Empty<AuthoritativeDevelopmentClient>();
    }

    public readonly struct AuthoritativeDevelopmentCredential
    {
        public AuthoritativeDevelopmentCredential(
            string apiBaseUrl,
            string nakamaServerKey,
            string bearerToken,
            int clientSlot
        )
        {
            ApiBaseUrl = apiBaseUrl;
            NakamaServerKey = nakamaServerKey;
            BearerToken = bearerToken;
            ClientSlot = clientSlot;
        }

        public string ApiBaseUrl { get; }

        public string NakamaServerKey { get; }

        public string BearerToken { get; }

        public int ClientSlot { get; }
    }

    public static class AuthoritativeDevelopmentCredentials
    {
        private const string CommandLineMarker =
            "--hc-authoritative-development";
        private const string RuntimeCommandLineMarker =
            "--hc-authoritative-runtime";
        private const string ApiBaseUrlArgument = "--hc-api-base-url";
        private const string ServerKeyArgument = "--hc-nakama-server-key";
        private const string BearerTokenArgument = "--hc-bearer-token";
        private const string ClientSlotArgument = "--hc-client-slot";

        public static string EditorConfigurationPath
        {
            get
            {
                return Path.GetFullPath(
                    Path.Combine(
                        Application.dataPath,
                        "..",
                        "Library",
                        "HiveChameleon",
                        "AuthoritativeDevelopment.json"
                    )
                );
            }
        }

        public static bool TryResolve(
            out AuthoritativeDevelopmentCredential credential
        )
        {
#if !UNITY_EDITOR
            // A published WebGL page obtains one scoped bearer token per browser
            // before starting Unity and supplies it through config.arguments.
            if (TryFromCommandLine(Environment.GetCommandLineArgs(), out credential))
            {
                return true;
            }
#endif
#if UNITY_EDITOR || DEVELOPMENT_BUILD
#if UNITY_EDITOR
            if (
                TryReadEditorConfiguration(
                    out AuthoritativeDevelopmentConfiguration configuration
                )
                && TryFromConfiguration(configuration, out credential)
            )
            {
                return true;
            }
#endif

#if !UNITY_WEBGL || UNITY_EDITOR
            string environmentApiBaseUrl =
                Environment.GetEnvironmentVariable("HIVE_CHAMELEON_API_URL");
            string environmentServerKey =
                Environment.GetEnvironmentVariable("NAKAMA_SERVER_KEY");
            string environmentBearerToken =
                Environment.GetEnvironmentVariable("REALTIME_DEV_BEARER_TOKEN");
            if (
                TryCreate(
                    environmentApiBaseUrl,
                    environmentServerKey,
                    environmentBearerToken,
                    0,
                    out credential
                )
            )
            {
                return true;
            }
#endif

#endif
            credential = default;
            return false;
        }

        public static bool TryReadEditorConfiguration(
            out AuthoritativeDevelopmentConfiguration configuration
        )
        {
            configuration = null;
            try
            {
                if (!File.Exists(EditorConfigurationPath))
                {
                    return false;
                }

                configuration = JsonUtility.FromJson<AuthoritativeDevelopmentConfiguration>(
                    File.ReadAllText(EditorConfigurationPath)
                );
                return configuration != null
                    && configuration.version == 1
                    && configuration.clients != null;
            }
            catch (Exception)
            {
                configuration = null;
                return false;
            }
        }

        public static bool TryGetConfiguredClient(
            AuthoritativeDevelopmentConfiguration configuration,
            int slot,
            out AuthoritativeDevelopmentClient client
        )
        {
            client = null;
            if (configuration?.clients == null || slot < 1 || slot > 10)
            {
                return false;
            }

            foreach (AuthoritativeDevelopmentClient candidate in configuration.clients)
            {
                if (candidate != null && candidate.slot == slot)
                {
                    client = candidate;
                    return true;
                }
            }

            return false;
        }

        private static bool TryFromConfiguration(
            AuthoritativeDevelopmentConfiguration configuration,
            out AuthoritativeDevelopmentCredential credential
        )
        {
            if (
                !TryGetConfiguredClient(
                    configuration,
                    configuration.selected_client,
                    out AuthoritativeDevelopmentClient client
                )
                || !DateTimeOffset.TryParse(
                    client.expires_at,
                    out DateTimeOffset expiresAt
                )
                || expiresAt <= DateTimeOffset.UtcNow.AddSeconds(15)
            )
            {
                credential = default;
                return false;
            }

            return TryCreate(
                configuration.api_base_url,
                configuration.nakama_server_key,
                client.bearer_token,
                client.slot,
                out credential
            );
        }

        private static bool TryFromCommandLine(
            string[] arguments,
            out AuthoritativeDevelopmentCredential credential
        )
        {
            credential = default;
            if (
                arguments == null
                || (
                    Array.IndexOf(arguments, CommandLineMarker) < 0
                    && Array.IndexOf(arguments, RuntimeCommandLineMarker) < 0
                )
            )
            {
                return false;
            }

            string apiBaseUrl = ReadArgument(arguments, ApiBaseUrlArgument);
            string serverKey = ReadArgument(arguments, ServerKeyArgument);
            string bearerToken = ReadArgument(arguments, BearerTokenArgument);
            int.TryParse(
                ReadArgument(arguments, ClientSlotArgument),
                out int clientSlot
            );
            return TryCreate(
                apiBaseUrl,
                serverKey,
                bearerToken,
                clientSlot,
                out credential
            );
        }

        private static string ReadArgument(string[] arguments, string name)
        {
            string prefix = name + "=";
            for (int index = 0; index < arguments.Length; index++)
            {
                string argument = arguments[index];
                if (
                    argument.StartsWith(
                        prefix,
                        StringComparison.Ordinal
                    )
                )
                {
                    return argument.Substring(prefix.Length);
                }
                if (
                    string.Equals(argument, name, StringComparison.Ordinal)
                    && index + 1 < arguments.Length
                )
                {
                    return arguments[index + 1];
                }
            }

            return string.Empty;
        }

        private static bool TryCreate(
            string apiBaseUrl,
            string serverKey,
            string bearerToken,
            int clientSlot,
            out AuthoritativeDevelopmentCredential credential
        )
        {
            credential = default;
            string resolvedApiBaseUrl = apiBaseUrl?.Trim().TrimEnd('/');
            string resolvedServerKey = serverKey?.Trim();
            string resolvedBearerToken = bearerToken?.Trim();
            if (
                !Uri.TryCreate(
                    resolvedApiBaseUrl,
                    UriKind.Absolute,
                    out Uri parsedApiBaseUrl
                )
                || (
                    parsedApiBaseUrl.Scheme != Uri.UriSchemeHttp
                    && parsedApiBaseUrl.Scheme != Uri.UriSchemeHttps
                )
                || string.IsNullOrWhiteSpace(resolvedServerKey)
                || string.IsNullOrWhiteSpace(resolvedBearerToken)
                || resolvedBearerToken.Length < 32
                || clientSlot < 0
                || clientSlot > 10
            )
            {
                return false;
            }

            credential = new AuthoritativeDevelopmentCredential(
                resolvedApiBaseUrl,
                resolvedServerKey,
                resolvedBearerToken,
                clientSlot
            );
            return true;
        }
    }
}
