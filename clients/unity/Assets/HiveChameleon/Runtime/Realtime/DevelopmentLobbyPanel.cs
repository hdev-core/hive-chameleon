using System;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HiveChameleon.Realtime
{
    [DisallowMultipleComponent]
    public sealed class DevelopmentLobbyPanel : MonoBehaviour
    {
        private enum MenuPage
        {
            Entry,
            Home,
            Lobby,
        }

        private static readonly string[] VisibilityOptions = { "OPEN", "PRIVATE" };
        private static readonly string[] ModeOptions = { "CASUAL", "INFECTION" };

        private readonly Color _background = new Color(0.018f, 0.027f, 0.043f);
        private readonly Color _surface = new Color(0.035f, 0.051f, 0.074f, 0.98f);
        private readonly Color _surfaceRaised = new Color(0.055f, 0.075f, 0.102f, 0.98f);
        private readonly Color _line = new Color(0.14f, 0.19f, 0.25f, 0.9f);
        private readonly Color _primary = new Color(0.22f, 0.91f, 0.76f);
        private readonly Color _primaryDark = new Color(0.06f, 0.42f, 0.37f);
        private readonly Color _accent = new Color(0.94f, 0.48f, 0.19f);
        private readonly Color _text = new Color(0.94f, 0.97f, 1f);
        private readonly Color _muted = new Color(0.57f, 0.65f, 0.73f);
        private readonly Color _error = new Color(1f, 0.35f, 0.4f);

        private NakamaRealtimeConnection _connection;
        private CancellationTokenSource _lifetime;
        private Func<CancellationToken, Task> _requestConnection;
        private MenuPage _page = MenuPage.Entry;
        private string _playerId = string.Empty;
        private string _status = string.Empty;
        private bool _statusIsError;
        private bool _entryConfigured;
        private bool _entryInitialized;
        private bool _busy;
        private bool _gameplayActive;
        private Vector2 _scrollPosition;

        private string _createName = "Hive Match";
        private string _createRegion = "local";
        private string _createPassword = string.Empty;
        private int _createCapacity = 8;
        private int _visibilityIndex;
        private string _joinLobbyId = string.Empty;
        private string _joinPassword = string.Empty;

        private long _loadedConfigurationVersion = -1;
        private int _modeIndex;
        private string _mapVersionId = string.Empty;
        private int _hunterCount = 1;
        private int _hidingSeconds = 60;
        private int _huntingSeconds = 180;
        private int _shellLimit = 6;
        private int _reloadMilliseconds = 2000;

        private bool _stylesReady;
        private Texture2D _surfaceTexture;
        private Texture2D _raisedTexture;
        private Texture2D _primaryTexture;
        private Texture2D _primaryHoverTexture;
        private Texture2D _secondaryTexture;
        private Texture2D _inputTexture;
        private GUIStyle _panelStyle;
        private GUIStyle _cardStyle;
        private GUIStyle _brandStyle;
        private GUIStyle _heroStyle;
        private GUIStyle _pageTitleStyle;
        private GUIStyle _sectionStyle;
        private GUIStyle _bodyStyle;
        private GUIStyle _mutedStyle;
        private GUIStyle _captionStyle;
        private GUIStyle _fieldLabelStyle;
        private GUIStyle _inputStyle;
        private GUIStyle _primaryButtonStyle;
        private GUIStyle _secondaryButtonStyle;
        private GUIStyle _dangerButtonStyle;
        private GUIStyle _choiceStyle;
        private GUIStyle _statusStyle;
        private GUIStyle _rosterStyle;

        public void InitializeEntry(
            bool configured,
            string status,
            Func<CancellationToken, Task> requestConnection,
            CancellationToken shutdownToken
        )
        {
            UnbindConnection();
            _lifetime?.Cancel();
            _lifetime?.Dispose();
            _lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            _requestConnection = requestConnection;
            _entryConfigured = configured;
            _entryInitialized = true;
            _gameplayActive = false;
            _page = MenuPage.Entry;
            SetStatus(status, !configured);
            UnlockCursor();
        }

        public void BindConnection(
            NakamaRealtimeConnection connection,
            string playerId
        )
        {
            if (connection == null)
            {
                throw new ArgumentNullException(nameof(connection));
            }

            UnbindConnection();
            _connection = connection;
            _playerId = playerId ?? string.Empty;
            _connection.LobbyStateChanged += HandleLobbyStateChanged;
            _connection.RoundStateChanged += HandleRoundStateChanged;
            _connection.RoundRoleAssigned += HandleRoundRoleAssigned;

            LobbySnapshot lobby = _connection.CurrentLobby;
            if (lobby != null && !string.IsNullOrWhiteSpace(lobby.id) && !lobby.closed)
            {
                LoadConfiguration(lobby, true);
                _page = MenuPage.Lobby;
            }
            else
            {
                _page = MenuPage.Home;
            }
            SetStatus("You're online.", false);
        }

        public void SetGameplayActive(bool active)
        {
            _gameplayActive = active;
            if (active)
            {
                return;
            }

            LobbySnapshot lobby = _connection?.CurrentLobby;
            _page =
                lobby != null && !string.IsNullOrWhiteSpace(lobby.id) && !lobby.closed
                    ? MenuPage.Lobby
                    : _connection?.State == RealtimeConnectionState.Connected
                        ? MenuPage.Home
                        : MenuPage.Entry;
            UnlockCursor();
        }

        public void PrefillLobbyCode(string lobbyId)
        {
            if (LobbyMenuRules.IsUuidV7(lobbyId))
            {
                _joinLobbyId = lobbyId.Trim();
            }
        }

        public void ClearConnection(string interruptedLobbyId)
        {
            UnbindConnection();
            PrefillLobbyCode(interruptedLobbyId);
            _gameplayActive = false;
            _page = MenuPage.Entry;
            UnlockCursor();
        }

        public void NotifyConnectionLost()
        {
            _gameplayActive = false;
            _page = MenuPage.Entry;
            SetStatus("The connection was interrupted. Reconnect to continue.", true);
            UnlockCursor();
        }

        private void Update()
        {
            if (!_entryInitialized || _gameplayActive)
            {
                return;
            }
            if (
                _connection != null
                && _connection.State != RealtimeConnectionState.Connected
                && _page != MenuPage.Entry
                && !_busy
            )
            {
                NotifyConnectionLost();
            }
            UnlockCursor();
        }

        private void OnGUI()
        {
            if (!_entryInitialized || _gameplayActive)
            {
                return;
            }

            EnsureStyles();
            Matrix4x4 previousMatrix = GUI.matrix;
            float scale = Mathf.Clamp(
                Mathf.Min(Screen.width / 1280f, Screen.height / 720f),
                0.72f,
                1.5f
            );
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            float width = Screen.width / scale;
            float height = Screen.height / scale;

            DrawBackground(width, height);
            DrawHeader(width);

            switch (_page)
            {
                case MenuPage.Home:
                    DrawHome(width, height);
                    break;
                case MenuPage.Lobby:
                    DrawLobby(width, height);
                    break;
                default:
                    DrawEntry(width, height);
                    break;
            }

            GUI.matrix = previousMatrix;
        }

        private void DrawBackground(float width, float height)
        {
            DrawRect(new Rect(0f, 0f, width, height), _background);
            DrawRect(
                new Rect(0f, 0f, width * 0.36f, height),
                new Color(0.02f, 0.18f, 0.17f, 0.17f)
            );
            DrawRect(
                new Rect(width * 0.72f, 0f, width * 0.28f, height),
                new Color(0.28f, 0.08f, 0.03f, 0.12f)
            );
            DrawRect(new Rect(0f, 72f, width, 1f), _line);
        }

        private void DrawHeader(float width)
        {
            GUI.Label(new Rect(42f, 18f, 430f, 44f), "HIVE // CHAMELEON", _brandStyle);

            bool connected =
                _connection != null
                && _connection.State == RealtimeConnectionState.Connected;
            Color dot = connected ? _primary : _muted;
            DrawRect(new Rect(width - 206f, 32f, 8f, 8f), dot);
            GUI.Label(
                new Rect(width - 188f, 21f, 148f, 30f),
                connected ? "ONLINE" : "OFFLINE",
                _captionStyle
            );
        }

        private void DrawEntry(float width, float height)
        {
            const float panelWidth = 620f;
            const float panelHeight = 500f;
            Rect panel = new Rect(
                (width - panelWidth) * 0.5f,
                Mathf.Max(92f, (height - panelHeight) * 0.5f + 18f),
                panelWidth,
                panelHeight
            );

            GUILayout.BeginArea(panel, _panelStyle);
            GUILayout.Space(22f);
            GUILayout.Label("ONLINE MULTIPLAYER", _sectionStyle);
            GUILayout.Space(14f);
            GUILayout.Label("BLEND IN.\nSTAND OUT.", _heroStyle);
            GUILayout.Space(16f);
            GUILayout.Label(
                "Enter an online match of camouflage, observation, and pursuit.",
                _bodyStyle
            );
            GUILayout.Space(26f);
            DrawStatus();
            GUILayout.FlexibleSpace();

            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && _entryConfigured
                && _requestConnection != null
                && !_busy;
            bool reconnecting =
                _connection != null
                && LobbyMenuRules.CanAttemptReconnect(
                    _connection.State,
                    _connection.CurrentLobby
                );
            if (
                GUILayout.Button(
                    _busy
                        ? reconnecting
                            ? "RECONNECTING…"
                            : "CONNECTING…"
                        : reconnecting
                            ? "RECONNECT"
                            : "CONNECT",
                    _primaryButtonStyle,
                    GUILayout.Height(54f)
                )
            )
            {
                Connect();
            }
            GUI.enabled = previousEnabled;
            GUILayout.Space(12f);
            GUILayout.Label(
                "Secure online play  •  Private role assignment",
                _captionStyle
            );
            GUILayout.Space(12f);
            GUILayout.EndArea();
        }

        private void DrawHome(float width, float height)
        {
            Rect content = new Rect(
                Mathf.Max(34f, (width - 1110f) * 0.5f),
                98f,
                Mathf.Min(1110f, width - 68f),
                height - 124f
            );

            GUILayout.BeginArea(content);
            _scrollPosition = GUILayout.BeginScrollView(_scrollPosition);
            GUILayout.Label("FIND YOUR MATCH", _pageTitleStyle);
            GUILayout.Label(
                "Create a room for your group or join with a lobby code.",
                _bodyStyle
            );
            GUILayout.Space(16f);
            DrawStatus();
            GUILayout.Space(18f);

            GUILayout.BeginHorizontal();
            DrawCreateCard();
            GUILayout.Space(20f);
            DrawJoinCard();
            GUILayout.EndHorizontal();

            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        private void DrawCreateCard()
        {
            GUILayout.BeginVertical(
                _cardStyle,
                GUILayout.MinHeight(476f),
                GUILayout.ExpandWidth(true)
            );
            GUILayout.Label("CREATE MATCH", _sectionStyle);
            GUILayout.Space(6f);
            GUILayout.Label(
                "Open a new lobby and invite up to ten players.",
                _mutedStyle
            );
            GUILayout.Space(18f);

            DrawFieldLabel("LOBBY NAME");
            _createName = GUILayout.TextField(
                _createName,
                128,
                _inputStyle,
                GUILayout.Height(42f)
            );
            GUILayout.Space(12f);

            DrawFieldLabel("ACCESS");
            _visibilityIndex = GUILayout.SelectionGrid(
                _visibilityIndex,
                VisibilityOptions,
                2,
                _choiceStyle,
                GUILayout.Height(40f)
            );
            if (_visibilityIndex == 1)
            {
                GUILayout.Space(10f);
                DrawFieldLabel("PASSWORD");
                _createPassword = GUILayout.PasswordField(
                    _createPassword,
                    '•',
                    72,
                    _inputStyle,
                    GUILayout.Height(42f)
                );
            }

            GUILayout.Space(12f);
            DrawValueLabel("PLAYERS", _createCapacity.ToString());
            _createCapacity = Mathf.RoundToInt(
                GUILayout.HorizontalSlider(_createCapacity, 2f, 10f)
            );
            GUILayout.Space(12f);

            DrawFieldLabel("REGION");
            _createRegion = GUILayout.TextField(
                _createRegion,
                32,
                _inputStyle,
                GUILayout.Height(42f)
            );

            GUILayout.FlexibleSpace();
            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && !_busy
                && _connection?.State == RealtimeConnectionState.Connected;
            if (
                GUILayout.Button(
                    "CREATE LOBBY",
                    _primaryButtonStyle,
                    GUILayout.Height(48f)
                )
            )
            {
                CreateLobby();
            }
            GUI.enabled = previousEnabled;
            GUILayout.EndVertical();
        }

        private void DrawJoinCard()
        {
            GUILayout.BeginVertical(
                _cardStyle,
                GUILayout.MinHeight(476f),
                GUILayout.ExpandWidth(true)
            );
            GUILayout.Label("JOIN MATCH", _sectionStyle);
            GUILayout.Space(6f);
            GUILayout.Label(
                "Use the lobby code shared by the host.",
                _mutedStyle
            );
            GUILayout.Space(18f);

            DrawFieldLabel("LOBBY CODE");
            _joinLobbyId = GUILayout.TextField(
                _joinLobbyId,
                36,
                _inputStyle,
                GUILayout.Height(42f)
            );
            GUILayout.Space(12f);

            DrawFieldLabel("PASSWORD  (OPTIONAL)");
            _joinPassword = GUILayout.PasswordField(
                _joinPassword,
                '•',
                72,
                _inputStyle,
                GUILayout.Height(42f)
            );

            GUILayout.Space(22f);
            GUILayout.Label(
                "The host controls mode, map, timers, and match start. "
                    + "The game assigns your role privately when the round begins.",
                _bodyStyle
            );

            GUILayout.FlexibleSpace();
            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && !_busy
                && _connection?.State == RealtimeConnectionState.Connected;
            if (
                GUILayout.Button(
                    "JOIN LOBBY",
                    _secondaryButtonStyle,
                    GUILayout.Height(48f)
                )
            )
            {
                JoinLobby();
            }
            GUI.enabled = previousEnabled;
            GUILayout.EndVertical();
        }

        private void DrawLobby(float width, float height)
        {
            LobbySnapshot lobby = _connection?.CurrentLobby;
            if (
                lobby == null
                || string.IsNullOrWhiteSpace(lobby.id)
                || lobby.closed
            )
            {
                _page = MenuPage.Home;
                return;
            }

            LoadConfiguration(lobby, false);
            bool isHost = LobbyMenuRules.IsHost(lobby, _playerId);
            Rect content = new Rect(
                Mathf.Max(30f, (width - 1160f) * 0.5f),
                94f,
                Mathf.Min(1160f, width - 60f),
                height - 116f
            );

            GUILayout.BeginArea(content);
            _scrollPosition = GUILayout.BeginScrollView(_scrollPosition);
            GUILayout.BeginHorizontal();
            GUILayout.BeginVertical();
            GUILayout.Label(lobby.name.ToUpperInvariant(), _pageTitleStyle);
            GUILayout.Label(
                $"{lobby.members.Length}/{lobby.max_players} PLAYERS  •  "
                    + $"{lobby.region_code.ToUpperInvariant()}  •  "
                    + (isHost ? "YOU ARE HOST" : "WAITING FOR HOST"),
                _captionStyle
            );
            GUILayout.EndVertical();
            GUILayout.FlexibleSpace();
            if (
                GUILayout.Button(
                    "COPY LOBBY CODE",
                    _secondaryButtonStyle,
                    GUILayout.Width(184f),
                    GUILayout.Height(40f)
                )
            )
            {
                GUIUtility.systemCopyBuffer = lobby.id;
                SetStatus("Lobby code copied.", false);
            }
            GUILayout.Space(10f);
            if (
                GUILayout.Button(
                    "LEAVE",
                    _dangerButtonStyle,
                    GUILayout.Width(94f),
                    GUILayout.Height(40f)
                )
            )
            {
                LeaveLobby();
            }
            GUILayout.EndHorizontal();
            GUILayout.Space(12f);
            DrawStatus();
            GUILayout.Space(14f);

            GUILayout.BeginHorizontal();
            DrawRosterCard(lobby);
            GUILayout.Space(18f);
            DrawConfigurationCard(lobby, isHost);
            GUILayout.EndHorizontal();

            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        private void DrawRosterCard(LobbySnapshot lobby)
        {
            GUILayout.BeginVertical(
                _cardStyle,
                GUILayout.Width(330f),
                GUILayout.MinHeight(550f)
            );
            GUILayout.Label("ROSTER", _sectionStyle);
            GUILayout.Space(10f);

            LobbyMemberSnapshot[] members =
                lobby.members ?? Array.Empty<LobbyMemberSnapshot>();
            for (int index = 0; index < members.Length; index++)
            {
                LobbyMemberSnapshot member = members[index];
                bool host = member.player_id == lobby.current_host_player_id;
                bool own = member.player_id == _playerId;
                string badges =
                    (host ? "  HOST" : string.Empty)
                    + (own ? "  YOU" : string.Empty);
                GUILayout.Label(
                    $"{index + 1:00}   "
                        + $"{LobbyMenuRules.PlayerDisplayLabel(member.display_name, index + 1)}"
                        + badges,
                    _rosterStyle,
                    GUILayout.Height(34f)
                );
            }

            GUILayout.Space(16f);
            DrawRect(
                GUILayoutUtility.GetRect(1f, 1f, GUILayout.ExpandWidth(true)),
                _line
            );
            GUILayout.Space(14f);

            bool nominated = LobbyMenuRules.IsNominated(lobby, _playerId);
            GUILayout.Label("HUNTER PREFERENCE", _fieldLabelStyle);
            GUILayout.Label(
                nominated
                    ? "You volunteered for Hunter selection."
                    : "The game assigns every role privately.",
                _mutedStyle
            );
            GUILayout.Space(10f);

            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && !_busy
                && !HasActiveRound(_connection.CurrentRound);
            if (
                GUILayout.Button(
                    nominated ? "WITHDRAW NOMINATION" : "VOLUNTEER AS HUNTER",
                    _secondaryButtonStyle,
                    GUILayout.Height(42f)
                )
            )
            {
                SetHunterNomination(!nominated);
            }
            GUI.enabled = previousEnabled;

            GUILayout.FlexibleSpace();
            GUILayout.Label("LOBBY CODE", _fieldLabelStyle);
            GUILayout.Label(lobby.id, _captionStyle);
            GUILayout.EndVertical();
        }

        private void DrawConfigurationCard(
            LobbySnapshot lobby,
            bool isHost
        )
        {
            GUILayout.BeginVertical(
                _cardStyle,
                GUILayout.MinWidth(670f),
                GUILayout.MinHeight(550f),
                GUILayout.ExpandWidth(true)
            );
            GUILayout.BeginHorizontal();
            GUILayout.Label("MATCH SETTINGS", _sectionStyle);
            GUILayout.FlexibleSpace();
            GUILayout.Label(
                isHost ? "HOST CONTROLS" : "READ ONLY",
                _captionStyle
            );
            GUILayout.EndHorizontal();
            GUILayout.Space(12f);

            bool configurationLocked = HasActiveRound(_connection.CurrentRound);
            bool previousEnabled = GUI.enabled;
            GUI.enabled = previousEnabled && isHost && !_busy && !configurationLocked;

            DrawFieldLabel("MODE");
            _modeIndex = GUILayout.SelectionGrid(
                _modeIndex,
                ModeOptions,
                2,
                _choiceStyle,
                GUILayout.Height(42f)
            );
            GUILayout.Label(
                _modeIndex == 0
                    ? "Found Hiders leave the active hunt."
                    : "Found Hiders convert and join the Hunters.",
                _mutedStyle
            );
            GUILayout.Space(12f);

            DrawFieldLabel("MAP");
            GUILayout.Label(
                "CHROMA DISTRICT",
                _choiceStyle,
                GUILayout.Height(42f)
            );
            GUILayout.Label(
                "Neon streets, tight alleys, and plenty of places to disappear.",
                _mutedStyle
            );
            GUILayout.Space(12f);

            GUILayout.BeginHorizontal();
            GUILayout.BeginVertical(GUILayout.ExpandWidth(true));
            DrawSlider(
                "HUNTERS",
                ref _hunterCount,
                1,
                Mathf.Min(2, Mathf.Max(1, lobby.max_players - 1)),
                string.Empty
            );
            DrawSlider("HIDING TIME", ref _hidingSeconds, 10, 600, " SEC");
            DrawSlider("HUNT TIME", ref _huntingSeconds, 30, 1800, " SEC");
            GUILayout.EndVertical();
            GUILayout.Space(18f);
            GUILayout.BeginVertical(GUILayout.ExpandWidth(true));
            DrawSlider("SHELLS", ref _shellLimit, 1, 100, string.Empty);
            DrawSlider(
                "RELOAD",
                ref _reloadMilliseconds,
                100,
                30000,
                " MS"
            );
            GUILayout.EndVertical();
            GUILayout.EndHorizontal();

            GUILayout.Space(14f);
            if (
                GUILayout.Button(
                    "SAVE SETTINGS",
                    _secondaryButtonStyle,
                    GUILayout.Height(42f)
                )
            )
            {
                SaveConfiguration(lobby);
            }
            GUI.enabled = previousEnabled;

            GUILayout.Space(14f);
            DrawRect(
                GUILayoutUtility.GetRect(1f, 1f, GUILayout.ExpandWidth(true)),
                _line
            );
            GUILayout.Space(14f);

            bool canStart = LobbyMenuRules.CanStartRound(
                lobby,
                _connection.CurrentRound,
                _playerId,
                out string startReason
            );
            if (canStart && IsConfigurationDirty(lobby))
            {
                canStart = false;
                startReason = "Save the changed match settings before starting.";
            }
            GUI.enabled =
                previousEnabled
                && canStart
                && !_busy
                && _connection.State == RealtimeConnectionState.Connected;
            if (
                GUILayout.Button(
                    _busy ? "PLEASE WAIT…" : "START MATCH",
                    _primaryButtonStyle,
                    GUILayout.Height(50f)
                )
            )
            {
                StartRound();
            }
            GUI.enabled = previousEnabled;
            if (!canStart)
            {
                GUILayout.Space(6f);
                GUILayout.Label(startReason, _mutedStyle);
            }
            GUILayout.EndVertical();
        }

        private void DrawSlider(
            string label,
            ref int value,
            int minimum,
            int maximum,
            string suffix
        )
        {
            value = Mathf.Clamp(value, minimum, maximum);
            DrawValueLabel(label, value + suffix);
            if (minimum < maximum)
            {
                value = Mathf.RoundToInt(
                    GUILayout.HorizontalSlider(value, minimum, maximum)
                );
            }
            GUILayout.Space(9f);
        }

        private void DrawStatus()
        {
            if (string.IsNullOrWhiteSpace(_status))
            {
                return;
            }

            Color previous = GUI.color;
            GUI.color = _statusIsError ? _error : _primary;
            GUILayout.Label(
                _status,
                _statusStyle,
                GUILayout.MinHeight(38f)
            );
            GUI.color = previous;
        }

        private void DrawFieldLabel(string label)
        {
            GUILayout.Label(label, _fieldLabelStyle);
        }

        private void DrawValueLabel(string label, string value)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label(label, _fieldLabelStyle);
            GUILayout.FlexibleSpace();
            GUILayout.Label(value, _captionStyle);
            GUILayout.EndHorizontal();
        }

        private async void Connect()
        {
            if (_busy || _requestConnection == null || _lifetime == null)
            {
                return;
            }

            _busy = true;
            bool reconnecting =
                _connection != null
                && LobbyMenuRules.CanAttemptReconnect(
                    _connection.State,
                    _connection.CurrentLobby
                );
            SetStatus(
                reconnecting
                    ? "Restoring your place in the match…"
                    : "Connecting to online services…",
                false
            );
            try
            {
                await _requestConnection(_lifetime.Token);
                if (
                    _connection == null
                    || _connection.State != RealtimeConnectionState.Connected
                )
                {
                    throw new InvalidOperationException(
                        "Could not connect. Please try again."
                    );
                }
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                SetStatus("Connection cancelled.", true);
            }
            catch (Exception exception)
            {
                SetStatus(LobbyMenuRules.ProductErrorMessage(exception), true);
            }
            finally
            {
                _busy = false;
            }
        }

        private void CreateLobby()
        {
            bool privateLobby = _visibilityIndex == 1;
            if (
                !LobbyMenuRules.ValidateCreateLobby(
                    _createName,
                    privateLobby,
                    _createPassword,
                    _createCapacity,
                    _createRegion,
                    out string reason
                )
            )
            {
                SetStatus(reason, true);
                return;
            }

            ExecuteLobbyAction(
                token =>
                    _connection.CreateLobbyAsync(
                        _createName.Trim(),
                        privateLobby ? "private" : "public",
                        privateLobby ? _createPassword : string.Empty,
                        _createCapacity,
                        _createRegion.Trim().ToLowerInvariant(),
                        token
                    ),
                "Creating lobby…",
                "Lobby created."
            );
        }

        private void JoinLobby()
        {
            if (
                !LobbyMenuRules.ValidateJoinLobby(
                    _joinLobbyId,
                    out string reason
                )
            )
            {
                SetStatus(reason, true);
                return;
            }

            ExecuteLobbyAction(
                token =>
                    _connection.JoinLobbyAsync(
                        _joinLobbyId.Trim(),
                        _joinPassword,
                        token
                    ),
                "Joining lobby…",
                "Lobby joined."
            );
        }

        private void LeaveLobby()
        {
            ExecuteLobbyAction(
                token => _connection.LeaveLobbyAsync(token),
                "Leaving lobby…",
                "Lobby left.",
                _ =>
                {
                    _loadedConfigurationVersion = -1;
                    _page = MenuPage.Home;
                }
            );
        }

        private void SetHunterNomination(bool nominated)
        {
            ExecuteLobbyAction(
                token => _connection.NominateHunterAsync(nominated, token),
                nominated
                    ? "Submitting Hunter preference…"
                    : "Withdrawing Hunter preference…",
                nominated
                    ? "Hunter preference saved."
                    : "Hunter preference withdrawn."
            );
        }

        private void SaveConfiguration(LobbySnapshot lobby)
        {
            LobbyConfigurationDraft draft =
                LobbyConfigurationDraft.FromSnapshot(lobby.configuration);
            draft.Mode = _modeIndex == 0 ? "casual" : "infection";
            draft.MapVersionId = _mapVersionId.Trim();
            draft.HunterCount = _hunterCount;
            draft.HidingDurationSeconds = _hidingSeconds;
            draft.HuntingDurationSeconds = _huntingSeconds;
            draft.ShellLimit = _shellLimit;
            draft.ReloadDurationMilliseconds = _reloadMilliseconds;

            ExecuteLobbyAction(
                token =>
                    _connection.UpdateLobbyConfigurationAsync(
                        draft,
                        token
                    ),
                "Saving match settings…",
                "Match settings saved."
            );
        }

        private void StartRound()
        {
            LobbySnapshot lobby = _connection.CurrentLobby;
            if (
                !LobbyMenuRules.CanStartRound(
                    lobby,
                    _connection.CurrentRound,
                    _playerId,
                    out string reason
                )
            )
            {
                SetStatus(reason, true);
                return;
            }

            ExecuteLobbyAction(
                token => _connection.StartLobbyAsync(token),
                "Starting match…",
                "Match started."
            );
        }

        private async void ExecuteLobbyAction(
            Func<CancellationToken, Task<LobbyRpcResponse>> operation,
            string pendingMessage,
            string successMessage,
            Action<LobbyRpcResponse> onSuccess = null
        )
        {
            if (
                _busy
                || _lifetime == null
                || _connection == null
                || _connection.State != RealtimeConnectionState.Connected
            )
            {
                return;
            }

            _busy = true;
            SetStatus(pendingMessage, false);
            try
            {
                LobbyRpcResponse response = await operation(_lifetime.Token);
                if (response?.lobby == null)
                {
                    throw new InvalidOperationException(
                        "The lobby could not be opened. Please try again."
                    );
                }
                onSuccess?.Invoke(response);
                SetStatus(successMessage, false);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                SetStatus("Action cancelled.", true);
            }
            catch (Exception exception)
            {
                SetStatus(LobbyMenuRules.ProductErrorMessage(exception), true);
            }
            finally
            {
                _busy = false;
            }
        }

        private void HandleLobbyStateChanged(LobbySnapshot lobby)
        {
            if (
                lobby == null
                || string.IsNullOrWhiteSpace(lobby.id)
                || lobby.closed
            )
            {
                _loadedConfigurationVersion = -1;
                _page = MenuPage.Home;
                SetStatus("Lobby closed.", false);
                return;
            }

            LoadConfiguration(lobby, false);
            _page = MenuPage.Lobby;
        }

        private void HandleRoundStateChanged(RoundSnapshot round)
        {
            if (LobbyMenuRules.IsGameplayRound(round))
            {
                SetStatus("The match is starting.", false);
            }
        }

        private void HandleRoundRoleAssigned(RoundRoleAssignment assignment)
        {
            if (assignment != null && assignment.player_id == _playerId)
            {
                SetStatus("Your role is ready.", false);
            }
        }

        private void LoadConfiguration(
            LobbySnapshot lobby,
            bool force
        )
        {
            LobbyConfigurationSnapshot configuration = lobby?.configuration;
            if (
                configuration == null
                || (
                    !force
                    && configuration.row_version == _loadedConfigurationVersion
                )
            )
            {
                return;
            }

            _loadedConfigurationVersion = configuration.row_version;
            _modeIndex = configuration.mode == "infection" ? 1 : 0;
            _mapVersionId = configuration.map_version_id ?? string.Empty;
            _hunterCount = Mathf.Clamp(configuration.hunter_count, 1, 2);
            _hidingSeconds = Mathf.Clamp(
                configuration.hiding_duration_seconds,
                10,
                600
            );
            _huntingSeconds = Mathf.Clamp(
                configuration.hunting_duration_seconds,
                30,
                1800
            );
            _shellLimit = Mathf.Clamp(configuration.shell_limit, 1, 100);
            _reloadMilliseconds = Mathf.Clamp(
                configuration.reload_duration_ms,
                100,
                30000
            );
        }

        private void SetStatus(string value, bool error)
        {
            _status = value ?? string.Empty;
            _statusIsError = error;
        }

        private bool IsConfigurationDirty(LobbySnapshot lobby)
        {
            LobbyConfigurationSnapshot current = lobby?.configuration;
            if (current == null)
            {
                return false;
            }

            return current.mode != (_modeIndex == 0 ? "casual" : "infection")
                || (current.map_version_id ?? string.Empty) != _mapVersionId.Trim()
                || current.hunter_count != _hunterCount
                || current.hiding_duration_seconds != _hidingSeconds
                || current.hunting_duration_seconds != _huntingSeconds
                || current.shell_limit != _shellLimit
                || current.reload_duration_ms != _reloadMilliseconds;
        }

        private static bool HasActiveRound(RoundSnapshot round)
        {
            return round != null
                && round.status != "completed"
                && round.status != "aborted";
        }

        private void UnbindConnection()
        {
            if (_connection == null)
            {
                return;
            }
            _connection.LobbyStateChanged -= HandleLobbyStateChanged;
            _connection.RoundStateChanged -= HandleRoundStateChanged;
            _connection.RoundRoleAssigned -= HandleRoundRoleAssigned;
            _connection = null;
            _playerId = string.Empty;
        }

        private static void UnlockCursor()
        {
            if (Cursor.lockState != CursorLockMode.None)
            {
                Cursor.lockState = CursorLockMode.None;
            }
            Cursor.visible = true;
        }

        private void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }

            _surfaceTexture = CreateTexture(_surface);
            _raisedTexture = CreateTexture(_surfaceRaised);
            _primaryTexture = CreateTexture(_primaryDark);
            _primaryHoverTexture = CreateTexture(new Color(0.08f, 0.58f, 0.49f));
            _secondaryTexture = CreateTexture(new Color(0.08f, 0.11f, 0.15f));
            _inputTexture = CreateTexture(new Color(0.018f, 0.028f, 0.041f));

            _panelStyle = new GUIStyle(GUI.skin.box)
            {
                padding = new RectOffset(36, 36, 28, 28),
            };
            _panelStyle.normal.background = _surfaceTexture;

            _cardStyle = new GUIStyle(GUI.skin.box)
            {
                padding = new RectOffset(24, 24, 22, 22),
                margin = new RectOffset(0, 0, 0, 0),
            };
            _cardStyle.normal.background = _raisedTexture;

            _brandStyle = CreateLabelStyle(
                22,
                FontStyle.Bold,
                _text,
                TextAnchor.MiddleLeft
            );
            _heroStyle = CreateLabelStyle(
                52,
                FontStyle.Bold,
                _text,
                TextAnchor.MiddleLeft
            );
            _heroStyle.wordWrap = true;
            _pageTitleStyle = CreateLabelStyle(
                30,
                FontStyle.Bold,
                _text,
                TextAnchor.MiddleLeft
            );
            _sectionStyle = CreateLabelStyle(
                16,
                FontStyle.Bold,
                _primary,
                TextAnchor.MiddleLeft
            );
            _bodyStyle = CreateLabelStyle(
                15,
                FontStyle.Normal,
                _text,
                TextAnchor.MiddleLeft
            );
            _bodyStyle.wordWrap = true;
            _mutedStyle = CreateLabelStyle(
                13,
                FontStyle.Normal,
                _muted,
                TextAnchor.MiddleLeft
            );
            _mutedStyle.wordWrap = true;
            _captionStyle = CreateLabelStyle(
                11,
                FontStyle.Bold,
                _muted,
                TextAnchor.MiddleLeft
            );
            _fieldLabelStyle = CreateLabelStyle(
                11,
                FontStyle.Bold,
                _muted,
                TextAnchor.MiddleLeft
            );
            _statusStyle = CreateLabelStyle(
                13,
                FontStyle.Bold,
                Color.white,
                TextAnchor.MiddleLeft
            );
            _statusStyle.wordWrap = true;
            _statusStyle.padding = new RectOffset(14, 14, 9, 9);
            _statusStyle.normal.background = _secondaryTexture;
            _rosterStyle = CreateLabelStyle(
                13,
                FontStyle.Bold,
                _text,
                TextAnchor.MiddleLeft
            );
            _rosterStyle.padding = new RectOffset(10, 10, 4, 4);
            _rosterStyle.normal.background = _secondaryTexture;

            _inputStyle = new GUIStyle(GUI.skin.textField)
            {
                fontSize = 14,
                padding = new RectOffset(13, 13, 10, 10),
                normal = { textColor = _text, background = _inputTexture },
                focused = { textColor = _text, background = _inputTexture },
            };
            _primaryButtonStyle = CreateButtonStyle(
                _primaryTexture,
                _primaryHoverTexture,
                _text
            );
            _secondaryButtonStyle = CreateButtonStyle(
                _secondaryTexture,
                _raisedTexture,
                _text
            );
            _dangerButtonStyle = CreateButtonStyle(
                _secondaryTexture,
                _raisedTexture,
                _error
            );
            _choiceStyle = CreateButtonStyle(
                _secondaryTexture,
                _primaryTexture,
                _text
            );
            _choiceStyle.onNormal.background = _primaryTexture;
            _choiceStyle.onHover.background = _primaryHoverTexture;
            _choiceStyle.onActive.background = _primaryHoverTexture;
            _choiceStyle.onNormal.textColor = _text;
            _choiceStyle.onHover.textColor = _text;
            _choiceStyle.onActive.textColor = _text;

            _stylesReady = true;
        }

        private static GUIStyle CreateLabelStyle(
            int fontSize,
            FontStyle fontStyle,
            Color color,
            TextAnchor alignment
        )
        {
            var style = new GUIStyle(GUI.skin.label)
            {
                fontSize = fontSize,
                fontStyle = fontStyle,
                alignment = alignment,
            };
            style.normal.textColor = color;
            return style;
        }

        private static GUIStyle CreateButtonStyle(
            Texture2D normal,
            Texture2D hover,
            Color textColor
        )
        {
            var style = new GUIStyle(GUI.skin.button)
            {
                fontSize = 13,
                fontStyle = FontStyle.Bold,
                alignment = TextAnchor.MiddleCenter,
                padding = new RectOffset(16, 16, 9, 9),
            };
            style.normal.background = normal;
            style.normal.textColor = textColor;
            style.hover.background = hover;
            style.hover.textColor = textColor;
            style.active.background = hover;
            style.active.textColor = textColor;
            style.onNormal.background = hover;
            style.onNormal.textColor = textColor;
            return style;
        }

        private static Texture2D CreateTexture(Color color)
        {
            var texture = new Texture2D(1, 1)
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }

        private static void DrawRect(Rect rect, Color color)
        {
            Color previous = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = previous;
        }

        private void OnDestroy()
        {
            UnbindConnection();
            _lifetime?.Cancel();
            _lifetime?.Dispose();
            DestroyTexture(_surfaceTexture);
            DestroyTexture(_raisedTexture);
            DestroyTexture(_primaryTexture);
            DestroyTexture(_primaryHoverTexture);
            DestroyTexture(_secondaryTexture);
            DestroyTexture(_inputTexture);
        }

        private static void DestroyTexture(Texture2D texture)
        {
            if (texture != null)
            {
                Destroy(texture);
            }
        }
    }
}
