using System;
using System.IO;
using HiveChameleon.Realtime;
using UnityEditor;
using UnityEngine;

namespace HiveChameleon.Editor
{
    public static class AuthoritativeDevelopmentClientMenu
    {
        private const string MenuRoot =
            "Hive Chameleon/Local Multiplayer/Use Client ";

        [MenuItem(MenuRoot + "1", false, 101)]
        private static void UseClient1() => SelectClient(1);

        [MenuItem(MenuRoot + "2", false, 102)]
        private static void UseClient2() => SelectClient(2);

        [MenuItem(MenuRoot + "3", false, 103)]
        private static void UseClient3() => SelectClient(3);

        [MenuItem(MenuRoot + "4", false, 104)]
        private static void UseClient4() => SelectClient(4);

        [MenuItem(MenuRoot + "5", false, 105)]
        private static void UseClient5() => SelectClient(5);

        [MenuItem(MenuRoot + "6", false, 106)]
        private static void UseClient6() => SelectClient(6);

        [MenuItem(MenuRoot + "7", false, 107)]
        private static void UseClient7() => SelectClient(7);

        [MenuItem(MenuRoot + "8", false, 108)]
        private static void UseClient8() => SelectClient(8);

        [MenuItem(MenuRoot + "9", false, 109)]
        private static void UseClient9() => SelectClient(9);

        [MenuItem(MenuRoot + "10", false, 110)]
        private static void UseClient10() => SelectClient(10);

        [MenuItem(MenuRoot + "1", true)]
        private static bool ValidateClient1() => ValidateClient(1);

        [MenuItem(MenuRoot + "2", true)]
        private static bool ValidateClient2() => ValidateClient(2);

        [MenuItem(MenuRoot + "3", true)]
        private static bool ValidateClient3() => ValidateClient(3);

        [MenuItem(MenuRoot + "4", true)]
        private static bool ValidateClient4() => ValidateClient(4);

        [MenuItem(MenuRoot + "5", true)]
        private static bool ValidateClient5() => ValidateClient(5);

        [MenuItem(MenuRoot + "6", true)]
        private static bool ValidateClient6() => ValidateClient(6);

        [MenuItem(MenuRoot + "7", true)]
        private static bool ValidateClient7() => ValidateClient(7);

        [MenuItem(MenuRoot + "8", true)]
        private static bool ValidateClient8() => ValidateClient(8);

        [MenuItem(MenuRoot + "9", true)]
        private static bool ValidateClient9() => ValidateClient(9);

        [MenuItem(MenuRoot + "10", true)]
        private static bool ValidateClient10() => ValidateClient(10);

        private static void SelectClient(int slot)
        {
            if (
                !AuthoritativeDevelopmentCredentials.TryReadEditorConfiguration(
                    out AuthoritativeDevelopmentConfiguration configuration
                )
                || !AuthoritativeDevelopmentCredentials.TryGetConfiguredClient(
                    configuration,
                    slot,
                    out AuthoritativeDevelopmentClient client
                )
            )
            {
                Debug.LogError(
                    $"Client {slot} is not provisioned. Run "
                        + $"`npm run authoritative:clients -- --count {slot}` first."
                );
                return;
            }

            if (
                !DateTimeOffset.TryParse(
                    client.expires_at,
                    out DateTimeOffset expiresAt
                )
                || expiresAt <= DateTimeOffset.UtcNow.AddSeconds(15)
            )
            {
                Debug.LogError(
                    $"Client {slot}'s local session has expired. Run "
                        + "`npm run authoritative:start` to refresh it."
                );
                return;
            }

            configuration.selected_client = slot;
            File.WriteAllText(
                AuthoritativeDevelopmentCredentials.EditorConfigurationPath,
                JsonUtility.ToJson(configuration, true) + "\n"
            );
            Debug.Log(
                $"Unity Editor will use Client {slot} when Play mode starts."
            );
        }

        private static bool ValidateClient(int slot)
        {
            bool configured =
                AuthoritativeDevelopmentCredentials.TryReadEditorConfiguration(
                    out AuthoritativeDevelopmentConfiguration configuration
                )
                && AuthoritativeDevelopmentCredentials.TryGetConfiguredClient(
                    configuration,
                    slot,
                    out _
                );
            Menu.SetChecked(
                MenuRoot + slot,
                configured && configuration.selected_client == slot
            );
            return configured;
        }
    }
}
