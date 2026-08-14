using System;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace HiveChameleon.Realtime
{
    /// <summary>
    /// Writes text to the host clipboard.
    /// </summary>
    /// <remarks>
    /// On WebGL <see cref="GUIUtility.systemCopyBuffer"/> writes to the player's own
    /// buffer and never reaches the browser clipboard, and it reports no error when it
    /// fails, so callers cannot tell the copy did nothing. WebGL builds therefore route
    /// through a jslib bridge that drives the real browser clipboard and returns whether
    /// the write landed. Every other platform keeps the built-in path, which works.
    /// </remarks>
    internal static class ClipboardBridge
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        private static extern int HiveChameleonCopyText(string text);
#endif

        /// <summary>
        /// Copies <paramref name="text"/> to the clipboard, returning whether it landed.
        /// </summary>
        public static bool TryCopy(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

#if UNITY_WEBGL && !UNITY_EDITOR
            try
            {
                return HiveChameleonCopyText(text) != 0;
            }
            catch (EntryPointNotFoundException)
            {
                // The jslib plugin was excluded from the build. Fall through to the
                // built-in buffer so the player keeps working, and report the failure
                // rather than claiming a copy that did not happen.
                GUIUtility.systemCopyBuffer = text;
                return false;
            }
#else
            GUIUtility.systemCopyBuffer = text;
            return true;
#endif
        }
    }
}
