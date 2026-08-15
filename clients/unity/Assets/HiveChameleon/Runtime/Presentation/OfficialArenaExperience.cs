using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using HiveChameleon.Painting;
using HiveChameleon.Realtime;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    [DisallowMultipleComponent]
    public sealed class OfficialArenaExperience : MonoBehaviour
    {
        private const float MouseSensitivity = 2.2f;
        private const float WalkSpeed = 6.2f;
        private const float SprintSpeed = 9.5f;
        private const float JumpHeight = 1.25f;
        private const float Gravity = -22f;
        private const float AvatarSendInterval = 0.1f;
        private const float ScoreboardDisplaySeconds = 7f;

        private static readonly string[] PoseNames =
        {
            "idle",
            "standing",
            "running",
            "crouching",
            "aiming",
            "painting",
        };

        private readonly Dictionary<string, CamouflagedPlayerAvatar> _avatars =
            new Dictionary<string, CamouflagedPlayerAvatar>();
        private readonly Dictionary<string, bool> _answerCheckReveals =
            new Dictionary<string, bool>();
        private readonly Dictionary<string, SortedDictionary<long, PaintStrokeSnapshot>>
            _pendingPaintStrokes =
                new Dictionary<string, SortedDictionary<long, PaintStrokeSnapshot>>();

        private readonly Color _ink = new Color(0.012f, 0.025f, 0.04f, 0.93f);
        private readonly Color _cyan = new Color(0.16f, 0.87f, 0.88f);
        private readonly Color _lime = new Color(0.64f, 0.94f, 0.32f);
        private readonly Color _amber = new Color(1f, 0.6f, 0.16f);
        private readonly Color _red = new Color(0.98f, 0.19f, 0.3f);

        private IAuthoritativeArenaMap _map;
        private GameObject _mapObject;
        private string _arenaSlug = string.Empty;
        private Camera _camera;
        private Transform _playerRig;
        private CharacterController _controller;
        private GameObject _localHunterAvatar;
        private GameObject _localHiderAvatar;
        private GameObject _firstPersonWeapon;
        private HumanoidPresentationRig _localHunterRig;
        private HumanoidPresentationRig _localHiderRig;
        private PlayerPaintMode _paintMode;
        private NakamaRealtimeConnection _connection;
        private CancellationTokenSource _lifetime;
        private Func<CancellationToken, Task> _leaveLobby;
        private CamouflagedPlayerAvatar _aimedPlayer;

        private GUIStyle _titleStyle;
        private GUIStyle _headingStyle;
        private GUIStyle _bodyStyle;
        private GUIStyle _smallStyle;
        private GUIStyle _mutedStyle;
        private GUIStyle _buttonStyle;
        private GUIStyle _hudLabelStyle;
        private GUIStyle _hudValueStyle;
        private GUIStyle _hudCenterStyle;
        private bool _stylesReady;

        private bool _arenaActive;
        private bool _experienceBuilt;
        private bool _fireBusy;
        private bool _avatarSendBusy;
        private bool _likeBusy;
        private bool _pauseOpen;
        private bool _leaveLobbyBusy;
        private bool _freeCameraInitialized;
        private bool _isCrouching;
        private int _cameraMode;
        private int _spectatorCameraMode = 1;
        private int _localPose = 1;
        private float _yaw = 180f;
        private float _pitch = 5f;
        private float _freeYaw = 180f;
        private float _freePitch = 18f;
        private float _verticalVelocity;
        private Vector3 _localPresentationVelocity;
        private float _nextAvatarSendAt;
        private float _weaponKickUntil;
        private float _hitMarkerUntil;
        private float _scoreboardVisibleUntil;
        private string _lastRoundId = string.Empty;
        private string _spectatorTargetPlayerId = string.Empty;
        private string _pauseStatus = string.Empty;
        private Color _localBodyColor = Color.white;
        private Color _localAccentColor = new Color(0.16f, 0.87f, 0.88f);
        private Color _lastAppliedLocalBody;
        private Color _lastAppliedLocalAccent;
        private bool _localColorsApplied;

        public bool HasAuthoritativeRound
        {
            get
            {
                if (
                    _connection == null
                    || _connection.State != RealtimeConnectionState.Connected
                    || _connection.CurrentRound == null
                    || string.IsNullOrWhiteSpace(_connection.CurrentRound.id)
                    || !LobbyMenuRules.HasCompatibleMap(_connection.CurrentRound)
                )
                {
                    return false;
                }

                string status = _connection.CurrentRound.status;
                return status == "preparing"
                    || status == "hiding"
                    || status == "hunting"
                    || status == "answer_check"
                    || status == "terminal"
                    || status == "completed";
            }
        }

        public void Initialize(
            NakamaRealtimeConnection connection,
            CancellationToken shutdownToken,
            Func<CancellationToken, Task> leaveLobby = null
        )
        {
            if (connection == null)
            {
                throw new ArgumentNullException(nameof(connection));
            }

            Unsubscribe();
            _connection = connection;
            _leaveLobby = leaveLobby;
            _connection.RoundStateChanged += HandleRoundChanged;
            _connection.RoundRoleAssigned += HandleRoleAssigned;
            _connection.RoundPlayerStateChanged += HandlePlayerStateChanged;
            _connection.RoundDiscoveryReceived += HandleDiscovery;
            _connection.HunterFireResolved += HandleFireResult;
            _connection.SpectatorStateChanged += HandleSpectatorState;
            _connection.AnswerCheckChanged += HandleAnswerCheck;
            _connection.RoundScoresChanged += HandleScores;
            _connection.RoundReconnectChanged += HandleReconnect;
            _connection.AvatarStateReceived += HandleAvatarState;
            _connection.PaintStrokeReceived += HandlePaintStroke;
            _connection.PaintStrokeResolved += HandlePaintStrokeResult;
            _lifetime?.Dispose();
            _lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            _pauseOpen = false;
            _leaveLobbyBusy = false;
            _pauseStatus = string.Empty;
            EnterDormantState();
        }

        private void Awake()
        {
            Application.targetFrameRate = 60;
        }

        private void BuildExperience()
        {
            if (
                !AuthoritativeArenaCatalog.TryResolve(
                    _connection?.CurrentRound,
                    out AuthoritativeArenaDefinition definition
                )
            )
            {
                return;
            }
            if (
                _map == null
                || !string.Equals(
                    _arenaSlug,
                    definition.Slug,
                    StringComparison.Ordinal
                )
            )
            {
                if (_mapObject != null)
                {
                    Destroy(_mapObject);
                }
                _map = definition.Instantiate(out _mapObject);
                // Collide against the server's own geometry rather than the
                // separately authored collision meshes, which drift from it.
                AuthorityCollisionSurface.Apply(
                    _mapObject,
                    AuthorityCollisionSurface.NeonServiceArcadeResource
                );
                _arenaSlug = definition.Slug;
                _arenaActive = false;
            }
            if (_experienceBuilt)
            {
                _map.ApplyPresentationEnvironment(_camera);
                return;
            }

            _camera = Camera.main;
            if (_camera == null)
            {
                var cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                _camera = cameraObject.AddComponent<Camera>();
            }
            _camera.fieldOfView = 72f;
            _camera.nearClipPlane = 0.06f;
            _map.ApplyPresentationEnvironment(_camera);

            var rigObject = new GameObject("Local Player Rig");
            _playerRig = rigObject.transform;
            _playerRig.position = _map.LocalHunterSpawn;
            _controller = rigObject.AddComponent<CharacterController>();
            _controller.height = 1.9f;
            _controller.radius = 0.38f;
            _controller.skinWidth = 0.08f;
            _controller.center = new Vector3(0f, 0.95f, 0f);
            _controller.stepOffset = 0.28f;
            _controller.slopeLimit = 48f;

            _camera.transform.SetParent(_playerRig, false);
            _camera.transform.localPosition = new Vector3(0f, 1.62f, 0f);
            _camera.transform.localRotation = Quaternion.identity;

            _localHunterAvatar = HumanoidPlayerFactory.CreateHunter(
                "Local Hunter",
                _playerRig,
                new Color(0.88f, 0.91f, 0.94f),
                new Color(0.16f, 0.87f, 0.88f)
            );
            _localHunterAvatar.SetActive(false);
            _localHunterRig = HumanoidPlayerFactory.PresentationRigFor(
                _localHunterAvatar
            );

            _localHiderAvatar = HumanoidPlayerFactory.CreateHider(
                "Local Hider",
                _playerRig,
                _localBodyColor,
                _localAccentColor
            );
            _localHiderAvatar.SetActive(false);
            _localHiderRig = HumanoidPlayerFactory.PresentationRigFor(
                _localHiderAvatar
            );
            HumanoidPlayerFactory.SharePaintAppearance(
                _localHiderAvatar,
                _localHunterAvatar
            );

            _firstPersonWeapon = HumanoidPlayerFactory.CreateFirstPersonRifle(
                "Hunter Rifle Viewmodel",
                _camera.transform
            );
            _firstPersonWeapon.transform.localRotation = Quaternion.Euler(
                4f,
                180f,
                0f
            );
            _firstPersonWeapon.transform.localScale = Vector3.one * 0.7f;
            _firstPersonWeapon.SetActive(false);
            UpdateWeaponViewmodel();
            _paintMode = new PlayerPaintMode(
                _camera,
                _playerRig,
                _controller,
                _localHiderAvatar,
                _connection,
                _lifetime.Token,
                () => CurrentPhase,
                () => ServerRole,
                pose =>
                {
                    _localPose = Mathf.Clamp(pose, 0, PoseNames.Length - 1);
                    ApplyLocalPose();
                    _nextAvatarSendAt = 0f;
                },
                active =>
                {
                    if (active)
                    {
                        _cameraMode = 1;
                    }
                }
            );
            ApplyPendingPaintStrokes(LocalPlayerId);
            _experienceBuilt = true;
        }

        private void Update()
        {
            if (!HasAuthoritativeRound)
            {
                EnterDormantState();
                return;
            }
            BuildExperience();
            if (_map == null || _camera == null || _playerRig == null)
            {
                return;
            }

            ActivateArena();
            if (Input.GetKeyDown(KeyCode.Escape))
            {
                SetPauseOpen(!_pauseOpen);
            }
            if (_pauseOpen)
            {
                _controller.enabled = false;
                UnlockCursor();
                ApplyRoundVisuals();
                UpdateWeaponViewmodel();
                return;
            }
            if (_paintMode != null)
            {
                float paintScale = Mathf.Max(
                    0.72f,
                    Mathf.Min(Screen.width / 1600f, Screen.height / 900f)
                );
                _paintMode.Tick(paintScale);
                if (_paintMode.IsActive)
                {
                    ApplyLocalPose();
                    ApplyRoundVisuals();
                    UpdateWeaponViewmodel();
                    UpdateAvatarBroadcast();
                    return;
                }
            }
            if (!IsSpectating && !HasPlayerControlAuthority)
            {
                _controller.enabled = false;
                UnlockCursor();
                UpdateAvatarVisibility(false);
                ApplyRoundVisuals();
                UpdateWeaponViewmodel();
                return;
            }
            UpdateCursor();
            if (IsSpectating)
            {
                UpdateSpectatorCamera();
            }
            else
            {
                UpdatePlayer();
            }
            UpdateHiderControls();
            ApplyRoundVisuals();
            UpdateTargeting();
            UpdateWeaponViewmodel();
            UpdateAvatarBroadcast();
        }

        private void ActivateArena()
        {
            if (!HasAuthoritativeRound)
            {
                EnterDormantState();
                return;
            }
            BuildExperience();
            _mapObject.SetActive(true);
            if (_arenaActive)
            {
                _controller.enabled =
                    !IsSpectating
                    && !_pauseOpen
                    && HasPlayerControlAuthority;
                return;
            }

            _arenaActive = true;
            _freeCameraInitialized = false;
            _controller.enabled =
                !IsSpectating
                && !_pauseOpen
                && HasPlayerControlAuthority;
            ApplyRoleSpawn();
            if (!IsSpectating)
            {
                AttachCameraToPlayer();
            }
            ApplyLocalAppearance();
            ApplyRoundVisuals();
        }

        private void EnterDormantState()
        {
            if (_paintMode != null && _paintMode.IsActive)
            {
                _paintMode.Exit();
            }
            if (_controller != null)
            {
                _controller.enabled = false;
            }
            _localHunterAvatar?.SetActive(false);
            _localHiderAvatar?.SetActive(false);
            _firstPersonWeapon?.SetActive(false);
            if (_mapObject != null)
            {
                _mapObject.SetActive(false);
            }
            foreach (CamouflagedPlayerAvatar avatar in _avatars.Values)
            {
                if (avatar != null)
                {
                    avatar.gameObject.SetActive(false);
                }
            }
            UnlockCursor();
            if (_arenaActive && _camera != null)
            {
                _camera.transform.SetParent(null, true);
                _camera.transform.position = new Vector3(0f, 18f, -25f);
                _camera.transform.LookAt(new Vector3(0f, 1.5f, 2f));
            }
            _arenaActive = false;
        }

        private void UpdateCursor()
        {
            if (IsSpectating || !HasPlayerControlAuthority)
            {
                UnlockCursor();
                return;
            }
            if (
                Input.GetMouseButtonDown(0)
                && Cursor.lockState != CursorLockMode.Locked
                && !IsPointerOverHud()
            )
            {
                Cursor.lockState = CursorLockMode.Locked;
                Cursor.visible = false;
            }
        }

        private static void UnlockCursor()
        {
            if (Cursor.lockState != CursorLockMode.None || !Cursor.visible)
            {
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }
        }

        private void SetPauseOpen(bool open)
        {
            if (_leaveLobbyBusy)
            {
                return;
            }
            if (open && _paintMode != null && _paintMode.IsActive)
            {
                _paintMode.Exit();
            }
            _pauseOpen = open;
            _pauseStatus = string.Empty;
            if (open)
            {
                UnlockCursor();
            }
        }

        private async void LeaveLobbyFromPause()
        {
            if (
                _leaveLobbyBusy
                || _leaveLobby == null
                || _lifetime == null
            )
            {
                return;
            }

            _leaveLobbyBusy = true;
            _pauseStatus = string.Empty;
            try
            {
                await _leaveLobby(_lifetime.Token);
                _pauseOpen = false;
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                _pauseStatus = "Leaving the lobby was cancelled.";
            }
            catch (Exception exception)
            {
                _pauseStatus = LobbyMenuRules.ProductErrorMessage(exception);
            }
            finally
            {
                _leaveLobbyBusy = false;
            }
        }

        private void UpdatePlayer()
        {
            string role = ServerRole;
            if (role != "hunter" && role != "hider")
            {
                UpdateAvatarVisibility(false);
                return;
            }
            if (Input.GetKeyDown(KeyCode.C))
            {
                _cameraMode = (_cameraMode + 1) % 2;
            }
            if (_camera.transform.parent != _playerRig)
            {
                AttachCameraToPlayer();
            }

            if (Cursor.lockState == CursorLockMode.Locked)
            {
                _yaw += Input.GetAxis("Mouse X") * MouseSensitivity;
                _pitch = Mathf.Clamp(
                    _pitch - Input.GetAxis("Mouse Y") * MouseSensitivity,
                    -58f,
                    62f
                );
            }
            _playerRig.rotation = Quaternion.Euler(0f, _yaw, 0f);

            float horizontal = Input.GetAxisRaw("Horizontal");
            float vertical = Input.GetAxisRaw("Vertical");
            Vector3 movement = (
                _playerRig.right * horizontal + _playerRig.forward * vertical
            ).normalized;
            _isCrouching = Input.GetKey(KeyCode.LeftControl);
            float targetHeight = _isCrouching ? 1.2f : 1.9f;
            _controller.height = Mathf.Lerp(
                _controller.height,
                targetHeight,
                Time.deltaTime * 12f
            );
            _controller.center = new Vector3(0f, _controller.height * 0.5f, 0f);

            float speed = Input.GetKey(KeyCode.LeftShift) ? SprintSpeed : WalkSpeed;
            if (_isCrouching)
            {
                speed *= 0.56f;
            }
            _localPresentationVelocity = movement * speed;
            if (_controller.isGrounded && _verticalVelocity < 0f)
            {
                _verticalVelocity = -2f;
            }
            if (
                _controller.isGrounded
                && !_isCrouching
                && Input.GetKeyDown(KeyCode.Space)
            )
            {
                _verticalVelocity = Mathf.Sqrt(JumpHeight * -2f * Gravity);
            }
            _verticalVelocity += Gravity * Time.deltaTime;
            _controller.Move(
                (movement * speed + Vector3.up * _verticalVelocity)
                    * Time.deltaTime
            );

            ApplyLocalPose();
            bool grounded = _controller.isGrounded;
            _localHiderRig?.SetMotion(
                _localPresentationVelocity,
                SprintSpeed,
                grounded,
                _isCrouching,
                false,
                false,
                _pitch
            );
            _localHunterRig?.SetMotion(
                _localPresentationVelocity,
                SprintSpeed,
                grounded,
                _isCrouching,
                true,
                false,
                _pitch
            );
            if (_cameraMode == 0)
            {
                _camera.transform.localPosition = Vector3.Lerp(
                    _camera.transform.localPosition,
                    new Vector3(0f, _isCrouching ? 1.02f : 1.62f, 0f),
                    Time.deltaTime * 14f
                );
                _camera.transform.localRotation = Quaternion.Euler(_pitch, 0f, 0f);
                UpdateAvatarVisibility(false);
            }
            else
            {
                _camera.transform.localPosition = Vector3.Lerp(
                    _camera.transform.localPosition,
                    new Vector3(0.68f, 1.78f, -2.75f),
                    Time.deltaTime * 9f
                );
                _camera.transform.localRotation = Quaternion.Euler(
                    Mathf.Clamp(_pitch * 0.55f, -18f, 32f),
                    0f,
                    0f
                );
                UpdateAvatarVisibility(true);
            }
        }

        private void AttachCameraToPlayer()
        {
            _camera.transform.SetParent(_playerRig, false);
            _camera.transform.localPosition =
                _cameraMode == 0
                    ? new Vector3(0f, _isCrouching ? 1.02f : 1.62f, 0f)
                    : new Vector3(0.68f, 1.78f, -2.75f);
            _camera.transform.localRotation = Quaternion.Euler(_pitch, 0f, 0f);
        }

        private void UpdateAvatarVisibility(bool thirdPerson)
        {
            if (IsSpectating || !HasPlayerControlAuthority)
            {
                _localHunterAvatar?.SetActive(false);
                _localHiderAvatar?.SetActive(false);
                _firstPersonWeapon?.SetActive(false);
                return;
            }

            bool hunter = ServerRole == "hunter";
            bool hider = ServerRole == "hider";
            if (_paintMode != null && _paintMode.IsActive)
            {
                _localHunterAvatar?.SetActive(false);
                _localHiderAvatar?.SetActive(hider);
                _firstPersonWeapon?.SetActive(false);
                return;
            }
            _localHunterAvatar?.SetActive(thirdPerson && hunter);
            _localHiderAvatar?.SetActive(thirdPerson && hider);
            _firstPersonWeapon?.SetActive(
                !thirdPerson && hunter && CurrentPhase == "hunting"
            );
        }

        private void UpdateHiderControls()
        {
            if (
                IsSpectating
                || ServerRole != "hider"
                || (
                    CurrentPhase != "preparing"
                    && CurrentPhase != "hiding"
                    && CurrentPhase != "hunting"
                )
            )
            {
                return;
            }

            bool appearanceChanged = false;
            if (Input.GetKeyDown(KeyCode.V))
            {
                _localPose = (_localPose + 1) % PoseNames.Length;
                appearanceChanged = true;
            }

            if (appearanceChanged)
            {
                ApplyLocalAppearance();
                _nextAvatarSendAt = 0f;
            }
        }

        private void ApplyLocalAppearance()
        {
            ApplyLocalColors(_localBodyColor, _localAccentColor);
            ApplyLocalPose();
        }

        private void ApplyLocalPose()
        {
            if (_localHiderAvatar == null)
            {
                return;
            }
            int pose = _isCrouching ? 3 : _localPose;
            _localHiderAvatar.transform.localPosition = Vector3.zero;
            _localHiderAvatar.transform.localRotation = Quaternion.identity;
            _localHiderAvatar.transform.localScale = Vector3.one;
            bool paintActive = _paintMode != null && _paintMode.IsActive;
            _localHiderRig?.SetMotion(
                paintActive ? Vector3.zero : _localPresentationVelocity,
                SprintSpeed,
                _controller == null || _controller.isGrounded,
                pose == 3,
                pose == 4,
                pose == 5 || paintActive,
                _pitch
            );
        }

        private void UpdateTargeting()
        {
            _aimedPlayer = null;
            bool hunterCanFire =
                !IsSpectating
                && CurrentPhase == "hunting"
                && ServerRole == "hunter";
            bool answerCheckSelection =
                CurrentPhase == "answer_check" && !IsSpectating;
            if (!hunterCanFire && !answerCheckSelection)
            {
                return;
            }
            if (answerCheckSelection)
            {
                _aimedPlayer = FindRevealAtCrosshair();
                return;
            }

            if (
                Physics.Raycast(
                    _camera.transform.position,
                    _camera.transform.forward,
                    out RaycastHit hit,
                    80f,
                    Physics.DefaultRaycastLayers,
                    QueryTriggerInteraction.Collide
                )
            )
            {
                CamouflagedPlayerAvatar candidate =
                    hit.collider.GetComponentInParent<CamouflagedPlayerAvatar>();
                if (
                    candidate != null
                    && candidate.Role == "hider"
                    && candidate.Status == "active"
                    && !candidate.IsFound
                )
                {
                    _aimedPlayer = candidate;
                }
            }

            if (
                hunterCanFire
                && Cursor.lockState == CursorLockMode.Locked
                && Input.GetMouseButtonDown(0)
            )
            {
                FireAt(_aimedPlayer);
            }
        }

        private CamouflagedPlayerAvatar FindRevealAtCrosshair()
        {
            CamouflagedPlayerAvatar closest = null;
            float closestDistance = 0.012f;
            foreach (
                KeyValuePair<string, CamouflagedPlayerAvatar> pair in _avatars
            )
            {
                if (
                    pair.Value == null
                    || !pair.Value.gameObject.activeInHierarchy
                    || !_answerCheckReveals.ContainsKey(pair.Key)
                )
                {
                    continue;
                }
                Vector3 viewport = _camera.WorldToViewportPoint(
                    pair.Value.transform.position + Vector3.up
                );
                if (viewport.z <= 0f)
                {
                    continue;
                }
                float distance =
                    (viewport.x - 0.5f) * (viewport.x - 0.5f)
                    + (viewport.y - 0.5f) * (viewport.y - 0.5f);
                if (distance < closestDistance)
                {
                    closestDistance = distance;
                    closest = pair.Value;
                }
            }
            return closest;
        }

        private async void FireAt(CamouflagedPlayerAvatar target)
        {
            if (
                _fireBusy
                || _connection == null
                || _lifetime == null
                || _connection.State != RealtimeConnectionState.Connected
            )
            {
                return;
            }

            _fireBusy = true;
            _weaponKickUntil = Time.unscaledTime + 0.12f;
            try
            {
                await _connection.FireHunterAsync(
                    target?.PlayerId ?? string.Empty,
                    _yaw,
                    _pitch,
                    _lifetime.Token
                );
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                // Object shutdown.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Hunter fire intent failed: {exception.Message}");
            }
            finally
            {
                _fireBusy = false;
            }
        }

        private void UpdateWeaponViewmodel()
        {
            if (_firstPersonWeapon == null)
            {
                return;
            }
            float kick = Time.unscaledTime < _weaponKickUntil ? -0.12f : 0f;
            float horizontalSpeed = new Vector2(
                _localPresentationVelocity.x,
                _localPresentationVelocity.z
            ).magnitude;
            float movementAmount = Mathf.Clamp01(horizontalSpeed / SprintSpeed);
            float gait = Time.unscaledTime * Mathf.Lerp(5.5f, 11f, movementAmount);
            float bobX = Mathf.Sin(gait) * 0.018f * movementAmount;
            float bobY = Mathf.Abs(Mathf.Cos(gait)) * 0.014f * movementAmount;
            Vector3 target = new Vector3(
                0.35f + bobX,
                -0.28f - bobY,
                0.68f + kick
            );
            _firstPersonWeapon.transform.localPosition = Vector3.Lerp(
                _firstPersonWeapon.transform.localPosition,
                target,
                Time.unscaledDeltaTime * 24f
            );
            Quaternion targetRotation = Quaternion.Euler(
                4f + bobY * 35f,
                180f,
                -bobX * 45f
            );
            _firstPersonWeapon.transform.localRotation = Quaternion.Slerp(
                _firstPersonWeapon.transform.localRotation,
                targetRotation,
                Time.unscaledDeltaTime * 18f
            );
        }

        private void UpdateAvatarBroadcast()
        {
            if (
                IsSpectating
                || !HasPlayerControlAuthority
                || _avatarSendBusy
                || _connection == null
                || _lifetime == null
                || _connection.State != RealtimeConnectionState.Connected
                || Time.unscaledTime < _nextAvatarSendAt
                || (ServerRole != "hunter" && ServerRole != "hider")
            )
            {
                return;
            }

            _nextAvatarSendAt = Time.unscaledTime + AvatarSendInterval;
            SendLocalAvatarState();
        }

        private async void SendLocalAvatarState()
        {
            _avatarSendBusy = true;
            var command = new AvatarStateCommand
            {
                position_x = _playerRig.position.x,
                position_y = _playerRig.position.y,
                position_z = _playerRig.position.z,
                yaw = _yaw,
                pitch = _pitch,
                body_r = _localBodyColor.r,
                body_g = _localBodyColor.g,
                body_b = _localBodyColor.b,
                accent_r = _localAccentColor.r,
                accent_g = _localAccentColor.g,
                accent_b = _localAccentColor.b,
                pose = PoseNames[_isCrouching ? 3 : _localPose],
            };
            try
            {
                await _connection.SendAvatarStateAsync(command, _lifetime.Token);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                // Object shutdown.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Avatar state update failed: {exception.Message}");
            }
            finally
            {
                _avatarSendBusy = false;
            }
        }

        private void UpdateSpectatorCamera()
        {
            _controller.enabled = false;
            UpdateAvatarVisibility(false);
            if (!EnsureAllowedSpectatorCameraMode())
            {
                UnlockCursor();
                return;
            }
            if (Input.GetKeyDown(KeyCode.C))
            {
                CycleSpectatorCameraMode();
            }
            if (Input.GetKeyDown(KeyCode.LeftBracket))
            {
                SelectSpectatorTarget(-1);
            }
            if (Input.GetKeyDown(KeyCode.RightBracket))
            {
                SelectSpectatorTarget(1);
            }

            CamouflagedPlayerAvatar target = CurrentSpectatorTarget();
            if (_spectatorCameraMode == 2)
            {
                UpdateFreeSpectatorCamera();
                return;
            }
            if (target == null)
            {
                UnlockCursor();
                return;
            }

            _freeCameraInitialized = false;
            _camera.transform.SetParent(null, true);
            Vector3 head = target.transform.position + Vector3.up * 1.62f;
            if (_spectatorCameraMode == 0)
            {
                _camera.transform.position = Vector3.Lerp(
                    _camera.transform.position,
                    head + target.transform.forward * 0.08f,
                    Time.unscaledDeltaTime * 14f
                );
                _camera.transform.rotation = Quaternion.Slerp(
                    _camera.transform.rotation,
                    target.transform.rotation,
                    Time.unscaledDeltaTime * 14f
                );
            }
            else
            {
                Vector3 desired =
                    target.transform.position
                    - target.transform.forward * 3.1f
                    + Vector3.up * 2.05f;
                _camera.transform.position = Vector3.Lerp(
                    _camera.transform.position,
                    desired,
                    Time.unscaledDeltaTime * 10f
                );
                Quaternion look = Quaternion.LookRotation(
                    head - _camera.transform.position,
                    Vector3.up
                );
                _camera.transform.rotation = Quaternion.Slerp(
                    _camera.transform.rotation,
                    look,
                    Time.unscaledDeltaTime * 12f
                );
            }
        }

        private void UpdateFreeSpectatorCamera()
        {
            if (!_freeCameraInitialized)
            {
                _camera.transform.SetParent(null, true);
                _camera.transform.position = _playerRig.position + new Vector3(
                    0f,
                    5f,
                    -7f
                );
                _freeYaw = _camera.transform.eulerAngles.y;
                _freePitch = 18f;
                _freeCameraInitialized = true;
            }

            if (Input.GetMouseButton(1))
            {
                _freeYaw += Input.GetAxis("Mouse X") * MouseSensitivity;
                _freePitch = Mathf.Clamp(
                    _freePitch - Input.GetAxis("Mouse Y") * MouseSensitivity,
                    -75f,
                    75f
                );
            }
            _camera.transform.rotation = Quaternion.Euler(
                _freePitch,
                _freeYaw,
                0f
            );
            Vector3 movement =
                _camera.transform.right * Input.GetAxisRaw("Horizontal")
                + Vector3.ProjectOnPlane(_camera.transform.forward, Vector3.up)
                    .normalized
                    * Input.GetAxisRaw("Vertical");
            if (Input.GetKey(KeyCode.Space))
            {
                movement += Vector3.up;
            }
            if (Input.GetKey(KeyCode.LeftControl))
            {
                movement += Vector3.down;
            }
            float speed = Input.GetKey(KeyCode.LeftShift) ? 14f : 7f;
            _camera.transform.position +=
                movement.normalized * speed * Time.unscaledDeltaTime;
        }

        private void SetSpectatorCameraMode(int mode)
        {
            int clamped = Mathf.Clamp(mode, 0, 2);
            if (!IsSpectatorCameraModeAllowed(clamped))
            {
                return;
            }
            _spectatorCameraMode = clamped;
            _freeCameraInitialized = false;
        }

        private void CycleSpectatorCameraMode()
        {
            for (int offset = 1; offset <= 3; offset++)
            {
                int candidate = (_spectatorCameraMode + offset) % 3;
                if (IsSpectatorCameraModeAllowed(candidate))
                {
                    SetSpectatorCameraMode(candidate);
                    return;
                }
            }
        }

        private bool EnsureAllowedSpectatorCameraMode()
        {
            if (!IsSpectating)
            {
                return false;
            }
            if (IsSpectatorCameraModeAllowed(_spectatorCameraMode))
            {
                return true;
            }

            string[] modes =
                _connection?.CurrentSpectatorState?.camera_modes
                ?? Array.Empty<string>();
            for (int index = 0; index < modes.Length; index++)
            {
                int candidate = SpectatorCameraModeIndex(modes[index]);
                if (candidate >= 0)
                {
                    _spectatorCameraMode = candidate;
                    _freeCameraInitialized = false;
                    return true;
                }
            }
            return false;
        }

        private bool IsSpectatorCameraModeAllowed(int mode)
        {
            if (!IsSpectating)
            {
                return false;
            }
            string expected = SpectatorCameraModeName(mode);
            if (expected.Length == 0)
            {
                return false;
            }

            string[] modes =
                _connection?.CurrentSpectatorState?.camera_modes
                ?? Array.Empty<string>();
            for (int index = 0; index < modes.Length; index++)
            {
                if (
                    string.Equals(
                        modes[index],
                        expected,
                        StringComparison.Ordinal
                    )
                )
                {
                    return true;
                }
            }
            return false;
        }

        private static int SpectatorCameraModeIndex(string mode)
        {
            switch (mode)
            {
                case "first_person":
                    return 0;
                case "third_person":
                    return 1;
                case "free":
                    return 2;
                default:
                    return -1;
            }
        }

        private static string SpectatorCameraModeName(int mode)
        {
            switch (mode)
            {
                case 0:
                    return "first_person";
                case 1:
                    return "third_person";
                case 2:
                    return "free";
                default:
                    return string.Empty;
            }
        }

        private void SelectSpectatorTarget(int direction)
        {
            List<CamouflagedPlayerAvatar> targets = SpectatorTargets();
            if (targets.Count == 0)
            {
                _spectatorTargetPlayerId = string.Empty;
                return;
            }

            int current = 0;
            for (int index = 0; index < targets.Count; index++)
            {
                if (targets[index].PlayerId == _spectatorTargetPlayerId)
                {
                    current = index;
                    break;
                }
            }
            current = Wrap(current + direction, targets.Count);
            _spectatorTargetPlayerId = targets[current].PlayerId;
        }

        private CamouflagedPlayerAvatar CurrentSpectatorTarget()
        {
            List<CamouflagedPlayerAvatar> targets = SpectatorTargets();
            if (targets.Count == 0)
            {
                _spectatorTargetPlayerId = string.Empty;
                return null;
            }
            for (int index = 0; index < targets.Count; index++)
            {
                if (targets[index].PlayerId == _spectatorTargetPlayerId)
                {
                    return targets[index];
                }
            }
            _spectatorTargetPlayerId = targets[0].PlayerId;
            return targets[0];
        }

        private List<CamouflagedPlayerAvatar> SpectatorTargets()
        {
            var targets = new List<CamouflagedPlayerAvatar>();
            SpectatorStateSnapshot spectator =
                _connection?.CurrentSpectatorState;
            if (
                !IsSpectating
                || spectator?.players == null
            )
            {
                return targets;
            }

            for (int index = 0; index < spectator.players.Length; index++)
            {
                SpectatorPlayerSnapshot player = spectator.players[index];
                if (
                    !IsVisibleSpectatorPlayer(player)
                    || !_avatars.TryGetValue(
                        player.player_id,
                        out CamouflagedPlayerAvatar avatar
                    )
                    || avatar == null
                    || !avatar.gameObject.activeInHierarchy
                )
                {
                    continue;
                }
                avatar.SetDisplayName(player.display_name);
                avatar.SetRole(player.role);
                avatar.SetStatus(player.status);
                targets.Add(avatar);
            }
            targets.Sort(
                (left, right) =>
                    string.CompareOrdinal(left.PlayerId, right.PlayerId)
            );
            return targets;
        }

        private bool IsVisibleSpectatorPlayer(SpectatorPlayerSnapshot player)
        {
            if (
                player == null
                || string.IsNullOrWhiteSpace(player.player_id)
                || (
                    player.role != "hunter"
                    && player.role != "hider"
                )
                || string.IsNullOrWhiteSpace(player.status)
            )
            {
                return false;
            }
            return player.role != "hider"
                || ContainsPlayerId(
                    _connection?.CurrentSpectatorState
                        ?.visible_hider_player_ids,
                    player.player_id
                );
        }

        private SpectatorPlayerSnapshot AuthoritativeSpectatorPlayer(
            string playerId
        )
        {
            SpectatorPlayerSnapshot[] players =
                _connection?.CurrentSpectatorState?.players;
            if (players == null || string.IsNullOrWhiteSpace(playerId))
            {
                return null;
            }
            for (int index = 0; index < players.Length; index++)
            {
                if (
                    players[index] != null
                    && string.Equals(
                        players[index].player_id,
                        playerId,
                        StringComparison.Ordinal
                    )
                )
                {
                    return players[index];
                }
            }
            return null;
        }

        private static bool ContainsPlayerId(
            string[] playerIds,
            string playerId
        )
        {
            if (playerIds == null || string.IsNullOrWhiteSpace(playerId))
            {
                return false;
            }
            for (int index = 0; index < playerIds.Length; index++)
            {
                if (
                    string.Equals(
                        playerIds[index],
                        playerId,
                        StringComparison.Ordinal
                    )
                )
                {
                    return true;
                }
            }
            return false;
        }

        private CamouflagedPlayerAvatar CreateAvatar(
            string playerId,
            string displayName,
            string role,
            Color body,
            Color accent,
            Vector3 position,
            float yaw
        )
        {
            var avatarObject = new GameObject($"Player // {displayName}");
            avatarObject.transform.position = position;
            avatarObject.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            CamouflagedPlayerAvatar avatar =
                avatarObject.AddComponent<CamouflagedPlayerAvatar>();
            avatar.Configure(
                playerId,
                displayName,
                role,
                body,
                accent,
                true
            );
            avatar.SetNetworkPose(position, yaw, true);
            _avatars[playerId] = avatar;
            ApplyPendingPaintStrokes(playerId);
            return avatar;
        }

        private CamouflagedPlayerAvatar EnsureAvatar(
            string playerId,
            string displayName,
            string role,
            Color body,
            Color accent,
            Vector3 position,
            float yaw
        )
        {
            string resolvedDisplayName = ResolvePlayerDisplayName(
                playerId,
                displayName
            );
            if (_avatars.TryGetValue(playerId, out CamouflagedPlayerAvatar existing))
            {
                existing.SetDisplayName(resolvedDisplayName);
                return existing;
            }
            return CreateAvatar(
                playerId,
                resolvedDisplayName,
                role,
                body,
                accent,
                position,
                yaw
            );
        }

        private void ClearAvatars()
        {
            foreach (CamouflagedPlayerAvatar avatar in _avatars.Values)
            {
                if (avatar != null)
                {
                    Destroy(avatar.gameObject);
                }
            }
            _avatars.Clear();
            _answerCheckReveals.Clear();
            _pendingPaintStrokes.Clear();
            _aimedPlayer = null;
            _spectatorTargetPlayerId = string.Empty;
        }

        private void ApplyRoundVisuals()
        {
            if (!HasAuthoritativeRound)
            {
                return;
            }

            _answerCheckReveals.Clear();
            bool reveal =
                CurrentPhase == "answer_check" || CurrentPhase == "completed";
            AnswerCheckReveal[] serverReveals =
                _connection?.CurrentAnswerCheck?.reveals;
            if (serverReveals != null)
            {
                for (int index = 0; index < serverReveals.Length; index++)
                {
                    AnswerCheckReveal item = serverReveals[index];
                    if (string.IsNullOrWhiteSpace(item.player_id))
                    {
                        continue;
                    }
                    _answerCheckReveals[item.player_id] = item.found;
                    if (!item.avatar_state_available)
                    {
                        continue;
                    }
                    Color body = new Color(
                        item.body_r,
                        item.body_g,
                        item.body_b,
                        1f
                    );
                    Color accent = new Color(
                        item.accent_r,
                        item.accent_g,
                        item.accent_b,
                        1f
                    );
                    CamouflagedPlayerAvatar avatar = EnsureAvatar(
                        item.player_id,
                        item.display_name,
                        "hider",
                        body,
                        accent,
                        new Vector3(
                            item.position_x,
                            item.position_y,
                            item.position_z
                        ),
                        item.yaw
                    );
                    avatar.SetRole("hider");
                    avatar.SetStatus(item.status);
                    avatar.SetColors(body, accent);
                    avatar.SetPose(PoseIndex(item.pose));
                    avatar.SetNetworkPose(
                        new Vector3(
                            item.position_x,
                            item.position_y,
                            item.position_z
                        ),
                        item.yaw,
                        true
                    );
                }
            }

            bool infection = _connection?.CurrentRound?.mode == "infection";
            foreach (
                KeyValuePair<string, CamouflagedPlayerAvatar> pair in _avatars
            )
            {
                CamouflagedPlayerAvatar avatar = pair.Value;
                SpectatorPlayerSnapshot spectatorPlayer =
                    IsSpectating
                        ? AuthoritativeSpectatorPlayer(pair.Key)
                        : null;
                bool spectatorVisible =
                    !IsSpectating
                    || IsVisibleSpectatorPlayer(spectatorPlayer);
                bool spectatorNameVisible =
                    IsSpectating
                    && ContainsPlayerId(
                        _connection?.CurrentSpectatorState
                            ?.visible_player_name_ids,
                        pair.Key
                    );
                if (spectatorPlayer != null)
                {
                    avatar.SetDisplayName(spectatorPlayer.display_name);
                    avatar.SetRole(spectatorPlayer.role);
                    avatar.SetStatus(spectatorPlayer.status);
                }
                bool hiderHiddenDuringPreparation =
                    !IsSpectating
                    && ServerRole == "hunter"
                    && (
                        CurrentPhase == "preparing"
                        || CurrentPhase == "hiding"
                    )
                    && avatar.Role == "hider";
                bool infectionTeammateConcealed =
                    !IsSpectating
                    && infection
                    && ServerRole == "hider"
                    && avatar.Role == "hider"
                    && !reveal;
                bool visible =
                    spectatorVisible
                    && !hiderHiddenDuringPreparation
                    && !infectionTeammateConcealed;
                avatar.gameObject.SetActive(visible);

                bool found = false;
                bool isRevealed =
                    reveal
                    && _answerCheckReveals.TryGetValue(pair.Key, out found);
                avatar.SetReveal(isRevealed, found);
                avatar.SetTargetable(
                    visible
                        && !reveal
                        && CurrentPhase == "hunting"
                        && ServerRole == "hunter"
                        && avatar.Role == "hider"
                        && avatar.Status == "active"
                        && !avatar.IsFound
                );
                avatar.SetNameplate(
                    visible
                        && (
                            spectatorNameVisible
                            || isRevealed
                        ),
                    isRevealed
                        ? (found ? "FOUND" : "UNFOUND")
                        : avatar.Status.ToUpperInvariant()
                );
            }

            UpdateAvatarVisibility(_cameraMode != 0);
        }

        private void ApplyLocalColors(Color body, Color accent)
        {
            if (
                _localColorsApplied
                && _lastAppliedLocalBody == body
                && _lastAppliedLocalAccent == accent
            )
            {
                return;
            }
            HumanoidPlayerFactory.ApplyColors(_localHiderAvatar, body, accent);
            HumanoidPlayerFactory.ApplyColors(_localHunterAvatar, body, accent);
            _lastAppliedLocalBody = body;
            _lastAppliedLocalAccent = accent;
            _localColorsApplied = true;
        }

        private string CurrentPhase
        {
            get
            {
                string phase = _connection?.CurrentRound?.status ?? "lobby";
                return phase == "terminal" ? "completed" : phase;
            }
        }

        private string ServerRole
        {
            get
            {
                if (_connection?.CurrentRoundPlayerState != null)
                {
                    return _connection.CurrentRoundPlayerState.role;
                }
                return _connection?.CurrentRoleAssignment?.role ?? "waiting";
            }
        }

        private bool HasPlayerControlAuthority
        {
            get
            {
                return LobbyMenuRules.HasPlayerControlAuthority(
                    _connection?.CurrentRound,
                    _connection?.CurrentRoundPlayerState,
                    _connection?.CurrentSpectatorState
                );
            }
        }

        private bool IsSpectating
        {
            get
            {
                return LobbyMenuRules.IsEligibleSpectator(
                    _connection?.CurrentRound,
                    _connection?.CurrentSpectatorState
                );
            }
        }

        private string LocalPlayerId =>
            _connection?.CurrentRoundPlayerState?.player_id
            ?? _connection?.CurrentRoleAssignment?.player_id
            ?? string.Empty;

        private int CurrentShells =>
            _connection?.CurrentRoundPlayerState?.shells_remaining ?? 0;

        private int CurrentHiders =>
            _connection?.CurrentRound?.hiders_remaining ?? 0;

        private int CurrentHidersTotal =>
            _connection?.CurrentRound?.hiders_total ?? 0;

        private string PhaseLabel
        {
            get
            {
                switch (CurrentPhase)
                {
                    case "preparing":
                        return "GET READY";
                    case "hiding":
                        return "CAMOUFLAGE";
                    case "hunting":
                        return _connection?.CurrentRound?.mode == "infection"
                            ? "INFECTION"
                            : "THE HUNT";
                    case "answer_check":
                        return "ANSWER CHECK";
                    case "completed":
                        return "ROUND COMPLETE";
                    default:
                        return "LOBBY";
                }
            }
        }

        private string RoleLabel
        {
            get
            {
                if (IsSpectating)
                {
                    return "SPECTATOR";
                }
                switch (ServerRole)
                {
                    case "hunter":
                        return "HUNTER";
                    case "hider":
                        return "HIDER";
                    default:
                        return "WAITING";
                }
            }
        }

        private int RemainingSeconds
        {
            get
            {
                string deadline = _connection?.CurrentRound?.phase_deadline;
                if (
                    string.IsNullOrWhiteSpace(deadline)
                    || !DateTimeOffset.TryParse(
                        deadline,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal
                            | DateTimeStyles.AdjustToUniversal,
                        out DateTimeOffset parsed
                    )
                )
                {
                    return 0;
                }
                return Mathf.Max(
                    0,
                    Mathf.CeilToInt(
                        (float)(parsed - DateTimeOffset.UtcNow).TotalSeconds
                    )
                );
            }
        }

        private void OnGUI()
        {
            if (!HasAuthoritativeRound)
            {
                return;
            }
            EnsureStyles();

            float scale = Mathf.Max(
                0.72f,
                Mathf.Min(Screen.width / 1600f, Screen.height / 900f)
            );
            Matrix4x4 previous = GUI.matrix;
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            float width = Screen.width / scale;
            float height = Screen.height / scale;

            if (_paintMode != null && _paintMode.IsActive)
            {
                _paintMode.Draw(width, height);
                GUI.matrix = previous;
                return;
            }
            DrawTopBar(width);
            DrawScoreboard(height);
            if (!_pauseOpen)
            {
                DrawCrosshair(width, height);
                if (IsSpectating)
                {
                    DrawSpectatorHud(width, height);
                }
                if (CurrentPhase == "answer_check")
                {
                    DrawAnswerCheckAction(width, height);
                }
            }
            if (_pauseOpen)
            {
                DrawPauseOverlay(width, height);
            }

            GUI.matrix = previous;
        }

        private void DrawPauseOverlay(float width, float height)
        {
            DrawRect(
                new Rect(0f, 0f, width, height),
                new Color(0.002f, 0.008f, 0.014f, 0.82f)
            );
            float panelHeight = CanQuitApplication ? 286f : 236f;
            Rect panel = new Rect(
                width * 0.5f - 190f,
                height * 0.5f - panelHeight * 0.5f,
                380f,
                panelHeight
            );
            DrawPanel(panel, _ink);
            DrawRect(new Rect(panel.x, panel.y, 4f, panel.height), _cyan);
            GUI.Label(
                new Rect(panel.x + 24f, panel.y + 22f, panel.width - 48f, 32f),
                "GAME MENU",
                _titleStyle
            );

            if (
                GUI.Button(
                    new Rect(panel.x + 44f, panel.y + 76f, panel.width - 88f, 42f),
                    "RESUME",
                    _buttonStyle
                )
            )
            {
                SetPauseOpen(false);
            }

            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && !_leaveLobbyBusy
                && _leaveLobby != null;
            if (
                GUI.Button(
                    new Rect(panel.x + 44f, panel.y + 130f, panel.width - 88f, 42f),
                    _leaveLobbyBusy ? "LEAVING LOBBY…" : "LEAVE LOBBY",
                    _buttonStyle
                )
            )
            {
                LeaveLobbyFromPause();
            }
            GUI.enabled = previousEnabled;

            if (CanQuitApplication)
            {
                if (
                    GUI.Button(
                        new Rect(
                            panel.x + 44f,
                            panel.y + 184f,
                            panel.width - 88f,
                            42f
                        ),
                        "QUIT GAME",
                        _buttonStyle
                    )
                )
                {
                    Application.Quit();
                }
            }

            if (!string.IsNullOrWhiteSpace(_pauseStatus))
            {
                GUI.Label(
                    new Rect(
                        panel.x + 24f,
                        panel.yMax - 42f,
                        panel.width - 48f,
                        28f
                    ),
                    _pauseStatus,
                    _mutedStyle
                );
            }
        }

        private static bool CanQuitApplication
        {
            get
            {
#if UNITY_STANDALONE && !UNITY_EDITOR
                return true;
#else
                return false;
#endif
            }
        }

        private void DrawTopBar(float width)
        {
            Rect identity = new Rect(22f, 20f, 245f, 54f);
            DrawPanel(identity, _ink);
            DrawRect(new Rect(identity.x, identity.y, 3f, identity.height), _cyan);
            GUI.Label(
                new Rect(identity.x + 15f, identity.y + 5f, 215f, 18f),
                CurrentArenaDisplayName.ToUpperInvariant(),
                _hudLabelStyle
            );
            GUI.Label(
                new Rect(identity.x + 15f, identity.y + 23f, 215f, 26f),
                RoleLabel,
                _hudValueStyle
            );

            Rect phase = new Rect(width * 0.5f - 105f, 20f, 210f, 54f);
            DrawPanel(phase, _ink);
            DrawRect(
                new Rect(phase.x, phase.y, phase.width, 3f),
                PhaseColor(CurrentPhase)
            );
            GUI.Label(
                new Rect(phase.x, phase.y + 5f, phase.width, 18f),
                PhaseLabel,
                _hudCenterStyle
            );
            GUI.Label(
                new Rect(phase.x, phase.y + 21f, phase.width, 27f),
                CurrentPhase == "completed"
                    ? "—"
                    : $"{RemainingSeconds / 60:00}:{RemainingSeconds % 60:00}",
                _titleStyle
            );

            Rect state = new Rect(width - 267f, 20f, 245f, 54f);
            DrawPanel(state, _ink);
            DrawRect(new Rect(state.xMax - 3f, state.y, 3f, state.height), _amber);
            if (ServerRole == "hider" && !IsSpectating)
            {
                GUI.Label(
                    new Rect(state.x + 14f, state.y + 5f, 96f, 18f),
                    "CAMOUFLAGE",
                    _hudLabelStyle
                );
                DrawRect(
                    new Rect(state.x + 14f, state.y + 28f, 200f, 11f),
                    _localBodyColor
                );
            }
            else
            {
                GUI.Label(
                    new Rect(state.x + 14f, state.y + 5f, 96f, 18f),
                    "HIDERS",
                    _hudLabelStyle
                );
                GUI.Label(
                    new Rect(state.x + 14f, state.y + 23f, 96f, 24f),
                    $"{CurrentHiders} / {CurrentHidersTotal}",
                    _hudValueStyle
                );
                GUI.Label(
                    new Rect(state.x + 132f, state.y + 5f, 96f, 18f),
                    "AMMO",
                    _hudLabelStyle
                );
                GUI.Label(
                    new Rect(state.x + 132f, state.y + 23f, 96f, 24f),
                    CurrentShells.ToString("00", CultureInfo.InvariantCulture),
                    _hudValueStyle
                );
            }
        }

        private string CurrentArenaDisplayName
        {
            get
            {
                string displayName = _connection?.CurrentRound?.map_display_name;
                return string.IsNullOrWhiteSpace(displayName)
                    ? AuthoritativeArenaCatalog.NeonServiceArcadeDisplayName
                    : displayName;
            }
        }

        private void DrawCrosshair(float width, float height)
        {
            bool hunterCrosshair =
                !IsSpectating
                && HasPlayerControlAuthority
                && ServerRole == "hunter"
                && (
                    CurrentPhase == "hunting"
                    || CurrentPhase == "answer_check"
                );
            if (!hunterCrosshair)
            {
                return;
            }
            float centerX = width * 0.5f;
            float centerY = height * 0.5f;
            Color color = new Color(0.8f, 0.94f, 0.96f, 0.86f);
            DrawRect(new Rect(centerX - 16f, centerY - 1f, 10f, 2f), color);
            DrawRect(new Rect(centerX + 6f, centerY - 1f, 10f, 2f), color);
            DrawRect(new Rect(centerX - 1f, centerY - 16f, 2f, 10f), color);
            DrawRect(new Rect(centerX - 1f, centerY + 6f, 2f, 10f), color);
            if (Time.unscaledTime < _hitMarkerUntil)
            {
                DrawRect(
                    new Rect(centerX - 13f, centerY - 13f, 8f, 2f),
                    _lime
                );
                DrawRect(
                    new Rect(centerX + 5f, centerY - 13f, 8f, 2f),
                    _lime
                );
                DrawRect(
                    new Rect(centerX - 13f, centerY + 11f, 8f, 2f),
                    _lime
                );
                DrawRect(
                    new Rect(centerX + 5f, centerY + 11f, 8f, 2f),
                    _lime
                );
            }
        }

        private void DrawScoreboard(float height)
        {
            RoundScoreSnapshot scores = _connection?.CurrentScores;
            if (
                scores?.entries == null
                || scores.entries.Length == 0
                || scores.round_id != _connection?.CurrentRound?.id
                || (
                    CurrentPhase != "answer_check"
                    && CurrentPhase != "completed"
                    && Time.unscaledTime >= _scoreboardVisibleUntil
                )
            )
            {
                return;
            }

            int count = Mathf.Min(10, scores.entries.Length);
            float panelHeight = 46f + count * 31f;
            Rect panel = new Rect(22f, 92f, 318f, panelHeight);
            DrawPanel(panel, _ink);
            DrawRect(new Rect(panel.x, panel.y, 4f, panel.height), _lime);
            GUI.Label(
                new Rect(panel.x + 16f, panel.y + 10f, 286f, 24f),
                "ROUND SCORE",
                _headingStyle
            );
            for (int index = 0; index < count; index++)
            {
                RoundScoreEntry entry = scores.entries[index];
                float y = panel.y + 41f + index * 31f;
                GUI.Label(
                    new Rect(panel.x + 16f, y, 220f, 24f),
                    $"{entry.rank:00}  "
                        + ResolvePlayerDisplayName(
                            entry.player_id,
                            entry.display_name,
                            index + 1
                        ),
                    _smallStyle
                );
                GUI.Label(
                    new Rect(panel.x + 238f, y, 62f, 24f),
                    (entry.breakdown?.total ?? 0).ToString(
                        CultureInfo.InvariantCulture
                    ),
                    _smallStyle
                );
            }
        }

        private void DrawSpectatorHud(float width, float height)
        {
            CamouflagedPlayerAvatar target = CurrentSpectatorTarget();
            SpectatorPlayerSnapshot targetState =
                target == null
                    ? null
                    : AuthoritativeSpectatorPlayer(target.PlayerId);
            Rect panel = new Rect(width * 0.5f - 300f, height - 84f, 600f, 60f);
            DrawPanel(panel, _ink);
            if (
                GUI.Button(
                    new Rect(panel.x + 12f, panel.y + 15f, 72f, 32f),
                    "PREV",
                    _buttonStyle
                )
            )
            {
                SelectSpectatorTarget(-1);
            }
            GUI.Label(
                new Rect(panel.x + 92f, panel.y + 8f, 185f, 19f),
                target == null ? "FREE CAMERA" : target.DisplayName,
                _smallStyle
            );
            GUI.Label(
                new Rect(panel.x + 92f, panel.y + 28f, 185f, 19f),
                targetState == null
                    ? string.Empty
                    : targetState.status.ToUpperInvariant(),
                _mutedStyle
            );
            bool previousEnabled = GUI.enabled;
            GUI.enabled =
                previousEnabled
                && IsSpectatorCameraModeAllowed(0);
            if (
                GUI.Button(
                    new Rect(panel.x + 283f, panel.y + 15f, 58f, 32f),
                    "1ST",
                    _buttonStyle
                )
            )
            {
                SetSpectatorCameraMode(0);
            }
            GUI.enabled =
                previousEnabled
                && IsSpectatorCameraModeAllowed(1);
            if (
                GUI.Button(
                    new Rect(panel.x + 347f, panel.y + 15f, 58f, 32f),
                    "3RD",
                    _buttonStyle
                )
            )
            {
                SetSpectatorCameraMode(1);
            }
            GUI.enabled =
                previousEnabled
                && IsSpectatorCameraModeAllowed(2);
            if (
                GUI.Button(
                    new Rect(panel.x + 411f, panel.y + 15f, 72f, 32f),
                    "FREE",
                    _buttonStyle
                )
            )
            {
                SetSpectatorCameraMode(2);
            }
            GUI.enabled = previousEnabled;
            if (
                GUI.Button(
                    new Rect(panel.x + 489f, panel.y + 15f, 99f, 32f),
                    "NEXT",
                    _buttonStyle
                )
            )
            {
                SelectSpectatorTarget(1);
            }
        }

        private void DrawAnswerCheckAction(float width, float height)
        {
            CamouflagedPlayerAvatar candidate = IsSpectating
                ? CurrentSpectatorTarget()
                : HasPlayerControlAuthority
                    ? _aimedPlayer
                    : null;
            if (
                !CanLikeAnswerCheckCandidate(candidate)
                || _connection?.LastLikeResult?.accepted == true
            )
            {
                return;
            }

            Rect panel = new Rect(width - 282f, height - 84f, 260f, 60f);
            DrawPanel(panel, _ink);
            GUI.Label(
                new Rect(panel.x + 12f, panel.y + 7f, 145f, 19f),
                candidate.DisplayName,
                _smallStyle
            );
            if (
                GUI.Button(
                    new Rect(panel.x + 12f, panel.y + 29f, 236f, 25f),
                    "LIKE DISGUISE",
                    _buttonStyle
                )
            )
            {
                LikeDisguise(candidate.PlayerId);
            }
        }

        private bool CanLikeAnswerCheckCandidate(
            CamouflagedPlayerAvatar candidate
        )
        {
            if (
                candidate == null
                || candidate.PlayerId == LocalPlayerId
            )
            {
                return false;
            }
            AnswerCheckReveal[] reveals =
                _connection?.CurrentAnswerCheck?.reveals;
            if (reveals == null)
            {
                return false;
            }
            for (int index = 0; index < reveals.Length; index++)
            {
                AnswerCheckReveal reveal = reveals[index];
                if (
                    reveal != null
                    && reveal.player_id == candidate.PlayerId
                )
                {
                    return true;
                }
            }
            return false;
        }

        private async void LikeDisguise(string playerId)
        {
            if (
                _likeBusy
                || _connection == null
                || _lifetime == null
                || string.IsNullOrWhiteSpace(playerId)
                || !_avatars.TryGetValue(
                    playerId,
                    out CamouflagedPlayerAvatar candidate
                )
                || !CanLikeAnswerCheckCandidate(candidate)
            )
            {
                return;
            }
            _likeBusy = true;
            try
            {
                await _connection.LikeDisguiseAsync(playerId, _lifetime.Token);
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
                // Object shutdown.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Disguise like failed: {exception.Message}");
            }
            finally
            {
                _likeBusy = false;
            }
        }

        private bool IsPointerOverHud()
        {
            Vector2 point = Input.mousePosition;
            point.y = Screen.height - point.y;
            return point.y < 110f || point.y > Screen.height - 125f;
        }

        private Color PhaseColor(string phase)
        {
            switch (phase)
            {
                case "hiding":
                    return _amber;
                case "hunting":
                    return _red;
                case "answer_check":
                case "completed":
                    return _lime;
                default:
                    return _cyan;
            }
        }

        private void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }
            _titleStyle = CreateStyle(
                21,
                FontStyle.Bold,
                Color.white,
                TextAnchor.MiddleCenter
            );
            _headingStyle = CreateStyle(
                14,
                FontStyle.Bold,
                _cyan,
                TextAnchor.MiddleLeft
            );
            _bodyStyle = CreateStyle(
                14,
                FontStyle.Normal,
                Color.white,
                TextAnchor.MiddleLeft
            );
            _smallStyle = CreateStyle(
                12,
                FontStyle.Bold,
                new Color(0.7f, 0.84f, 0.88f),
                TextAnchor.MiddleLeft
            );
            _mutedStyle = CreateStyle(
                11,
                FontStyle.Normal,
                new Color(0.48f, 0.62f, 0.68f),
                TextAnchor.MiddleLeft
            );
            _buttonStyle = new GUIStyle(GUI.skin.button)
            {
                fontSize = 12,
                fontStyle = FontStyle.Bold,
                alignment = TextAnchor.MiddleCenter,
            };
            _buttonStyle.normal.textColor = Color.white;
            _buttonStyle.hover.textColor = _lime;
            _hudLabelStyle = CreateStyle(
                10,
                FontStyle.Bold,
                new Color(0.42f, 0.78f, 0.82f),
                TextAnchor.MiddleLeft
            );
            _hudValueStyle = CreateStyle(
                15,
                FontStyle.Bold,
                Color.white,
                TextAnchor.MiddleLeft
            );
            _hudCenterStyle = CreateStyle(
                10,
                FontStyle.Bold,
                new Color(0.42f, 0.78f, 0.82f),
                TextAnchor.MiddleCenter
            );
            _stylesReady = true;
        }

        private static GUIStyle CreateStyle(
            int size,
            FontStyle fontStyle,
            Color color,
            TextAnchor alignment
        )
        {
            var style = new GUIStyle(GUI.skin.label)
            {
                fontSize = size,
                fontStyle = fontStyle,
                alignment = alignment,
            };
            style.normal.textColor = color;
            return style;
        }

        private static void DrawPanel(Rect rect, Color color)
        {
            DrawRect(rect, color);
            DrawRect(
                new Rect(rect.x, rect.y, rect.width, 1f),
                new Color(0.2f, 0.52f, 0.65f, 0.5f)
            );
            DrawRect(
                new Rect(rect.x, rect.yMax - 1f, rect.width, 1f),
                new Color(0f, 0f, 0f, 0.65f)
            );
        }

        private static void DrawRect(Rect rect, Color color)
        {
            Color previous = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = previous;
        }

        private string ResolvePlayerDisplayName(
            string playerId,
            string preferred,
            int ordinal = 0
        )
        {
            string preferredLabel = string.Empty;
            if (
                LobbyMenuRules.TryPlayerDisplayName(
                    preferred,
                    out string resolved
                )
            )
            {
                preferredLabel = resolved;
                if (!IsNeutralPlayerLabel(resolved))
                {
                    return resolved;
                }
            }

            LobbyMemberSnapshot[] members = _connection?.CurrentLobby?.members;
            if (members != null)
            {
                for (int index = 0; index < members.Length; index++)
                {
                    if (
                        members[index].player_id == playerId
                        && LobbyMenuRules.TryPlayerDisplayName(
                            members[index].display_name,
                            out resolved
                        )
                    )
                    {
                        return resolved;
                    }
                }
            }

            SpectatorPlayerSnapshot[] spectatorPlayers =
                _connection?.CurrentSpectatorState?.players;
            if (spectatorPlayers != null)
            {
                for (int index = 0; index < spectatorPlayers.Length; index++)
                {
                    if (
                        spectatorPlayers[index].player_id == playerId
                        && LobbyMenuRules.TryPlayerDisplayName(
                            spectatorPlayers[index].display_name,
                            out resolved
                        )
                    )
                    {
                        return resolved;
                    }
                }
            }

            AnswerCheckReveal[] reveals =
                _connection?.CurrentAnswerCheck?.reveals;
            if (reveals != null)
            {
                for (int index = 0; index < reveals.Length; index++)
                {
                    if (
                        reveals[index].player_id == playerId
                        && LobbyMenuRules.TryPlayerDisplayName(
                            reveals[index].display_name,
                            out resolved
                        )
                    )
                    {
                        return resolved;
                    }
                }
            }

            RoundScoreEntry[] entries = _connection?.CurrentScores?.entries;
            if (entries != null)
            {
                for (int index = 0; index < entries.Length; index++)
                {
                    if (
                        entries[index].player_id == playerId
                        && LobbyMenuRules.TryPlayerDisplayName(
                            entries[index].display_name,
                            out resolved
                        )
                    )
                    {
                        return resolved;
                    }
                }
            }

            return preferredLabel.Length > 0
                ? preferredLabel
                : LobbyMenuRules.PlayerDisplayLabel(string.Empty, ordinal);
        }

        private static bool IsNeutralPlayerLabel(string value)
        {
            if (string.Equals(value, "Player", StringComparison.Ordinal))
            {
                return true;
            }
            if (
                value.Length != 9
                || !value.StartsWith("Player ", StringComparison.Ordinal)
            )
            {
                return false;
            }
            return char.IsDigit(value[7]) && char.IsDigit(value[8]);
        }

        private void RefreshAvatarDisplayNames()
        {
            foreach (
                KeyValuePair<string, CamouflagedPlayerAvatar> pair in _avatars
            )
            {
                if (pair.Value != null)
                {
                    pair.Value.SetDisplayName(
                        ResolvePlayerDisplayName(
                            pair.Key,
                            pair.Value.DisplayName
                        )
                    );
                }
            }
        }

        private static int Wrap(int value, int length)
        {
            return (value % length + length) % length;
        }

        private static int PoseIndex(string pose)
        {
            if (string.IsNullOrWhiteSpace(pose))
            {
                return 1;
            }
            for (int index = 0; index < PoseNames.Length; index++)
            {
                if (
                    string.Equals(
                        PoseNames[index],
                        pose,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    return index;
                }
            }
            return 1;
        }

        private void ApplyRoleSpawn()
        {
            if (_map == null || _playerRig == null)
            {
                return;
            }
            string role = ServerRole;
            _playerRig.position =
                role == "hider"
                    ? _map.SpawnForPlayer(LocalPlayerId, false)
                    : _map.SpawnForPlayer(LocalPlayerId, true);
            _verticalVelocity = 0f;
        }

        private void HandleRoundChanged(RoundSnapshot round)
        {
            if (round == null)
            {
                return;
            }
            if (round.id != _lastRoundId)
            {
                _lastRoundId = round.id;
                ClearAvatars();
                _localBodyColor = Color.white;
                HumanoidPlayerFactory.PaintableBodyFor(_localHiderAvatar)
                    ?.ResetPaint(PaintMaterialValues.NeutralWhite);
                _scoreboardVisibleUntil = 0f;
                _cameraMode = 0;
                _spectatorCameraMode = 1;
                ApplyRoleSpawn();
            }
            if (round.status == "answer_check")
            {
                _scoreboardVisibleUntil =
                    Time.unscaledTime + ScoreboardDisplaySeconds;
            }
            ApplyRoundVisuals();
        }

        private void HandleRoleAssigned(RoundRoleAssignment assignment)
        {
            if (assignment?.round_id == _connection?.CurrentRound?.id)
            {
                ApplyRoleSpawn();
                UpdateAvatarVisibility(_cameraMode != 0);
            }
        }

        private void HandlePlayerStateChanged(RoundPlayerState playerState)
        {
            if (playerState?.round_id != _connection?.CurrentRound?.id)
            {
                return;
            }
            UpdateAvatarVisibility(_cameraMode != 0);
            ApplyRoundVisuals();
        }

        private void HandleAvatarState(AvatarStateSnapshot state)
        {
            if (
                state == null
                || state.round_id != _connection?.CurrentRound?.id
            )
            {
                return;
            }
            if (state.player_id == LocalPlayerId)
            {
                if (!state.correction || _playerRig == null || _controller == null)
                {
                    return;
                }
                bool controllerWasEnabled = _controller.enabled;
                _controller.enabled = false;
                _playerRig.position = new Vector3(
                    state.position_x,
                    state.position_y,
                    state.position_z
                );
                _yaw = Mathf.Repeat(state.yaw, 360f);
                _pitch = Mathf.Clamp(state.pitch, -58f, 62f);
                _verticalVelocity = 0f;
                _controller.enabled = controllerWasEnabled;
                return;
            }
            Color body = new Color(
                state.body_r,
                state.body_g,
                state.body_b,
                1f
            );
            Color accent = new Color(
                state.accent_r,
                state.accent_g,
                state.accent_b,
                1f
            );
            CamouflagedPlayerAvatar avatar = EnsureAvatar(
                state.player_id,
                state.display_name,
                state.role,
                body,
                accent,
                new Vector3(
                    state.position_x,
                    state.position_y,
                    state.position_z
                ),
                state.yaw
            );
            avatar.SetRole(state.role);
            avatar.SetStatus(state.status);
            avatar.SetColors(body, accent);
            avatar.SetPose(PoseIndex(state.pose));
            avatar.SetNetworkPose(
                new Vector3(
                    state.position_x,
                    state.position_y,
                    state.position_z
                ),
                state.yaw,
                false
            );
        }

        private void HandlePaintStroke(PaintStrokeSnapshot stroke)
        {
            if (
                stroke == null
                || stroke.round_id != _connection?.CurrentRound?.id
                || stroke.material == null
                || stroke.points == null
            )
            {
                return;
            }
            if (stroke.player_id == LocalPlayerId)
            {
                PaintableBody body = HumanoidPlayerFactory.PaintableBodyFor(
                    _localHiderAvatar
                );
                if (body == null)
                {
                    QueuePendingPaintStroke(stroke);
                    return;
                }
                bool shouldApply = _paintMode?.ReconcileAuthoritativeStroke(stroke) ?? true;
                if (shouldApply)
                {
                    ApplyPaintSnapshot(body, stroke);
                }
                return;
            }
            if (
                _avatars.TryGetValue(
                    stroke.player_id,
                    out CamouflagedPlayerAvatar avatar
                )
            )
            {
                avatar.ApplyPaintStroke(stroke);
                return;
            }
            QueuePendingPaintStroke(stroke);
        }

        private void HandlePaintStrokeResult(PaintStrokeResult result)
        {
            _paintMode?.ReconcileAuthoritativeResult(result);
        }

        private void QueuePendingPaintStroke(PaintStrokeSnapshot stroke)
        {
            if (
                !_pendingPaintStrokes.TryGetValue(
                    stroke.player_id,
                    out SortedDictionary<long, PaintStrokeSnapshot> pending
                )
            )
            {
                pending = new SortedDictionary<long, PaintStrokeSnapshot>();
                _pendingPaintStrokes.Add(stroke.player_id, pending);
            }
            pending[stroke.sequence] = stroke;
        }

        private void ApplyPendingPaintStrokes(string playerId)
        {
            if (
                string.IsNullOrWhiteSpace(playerId)
                || !_pendingPaintStrokes.TryGetValue(
                    playerId,
                    out SortedDictionary<long, PaintStrokeSnapshot> pending
                )
            )
            {
                return;
            }
            if (playerId == LocalPlayerId)
            {
                PaintableBody body = HumanoidPlayerFactory.PaintableBodyFor(
                    _localHiderAvatar
                );
                if (body == null)
                {
                    return;
                }
                foreach (PaintStrokeSnapshot stroke in pending.Values)
                {
                    if (_paintMode?.ReconcileAuthoritativeStroke(stroke) ?? true)
                    {
                        ApplyPaintSnapshot(body, stroke);
                    }
                }
            }
            else if (
                _avatars.TryGetValue(playerId, out CamouflagedPlayerAvatar avatar)
            )
            {
                foreach (PaintStrokeSnapshot stroke in pending.Values)
                {
                    avatar.ApplyPaintStroke(stroke);
                }
            }
            _pendingPaintStrokes.Remove(playerId);
        }

        private static void ApplyPaintSnapshot(
            PaintableBody body,
            PaintStrokeSnapshot stroke
        )
        {
            if (body == null || body.BodyId != stroke.body_id)
            {
                return;
            }
            var points = new List<Vector2>(stroke.points.Length);
            for (int index = 0; index < stroke.points.Length; index++)
            {
                points.Add(new Vector2(stroke.points[index].u, stroke.points[index].v));
            }
            PaintMaterialSnapshot source = stroke.material;
            body.ApplyStroke(
                stroke.renderer_id,
                points,
                stroke.radius,
                stroke.hardness,
                stroke.opacity,
                new PaintMaterialValues
                {
                    BaseColorLinear = new Color(
                        source.base_r,
                        source.base_g,
                        source.base_b,
                        1f
                    ),
                    Metallic = source.metallic,
                    Roughness = source.roughness,
                    EmissionColorLinear = new Color(
                        source.emission_r,
                        source.emission_g,
                        source.emission_b,
                        1f
                    ),
                    EmissionIntensity = source.emission_intensity,
                },
                (PaintChannels)stroke.channels
            );
        }

        private void HandleDiscovery(RoundDiscoverySnapshot discovery)
        {
            if (
                discovery == null
                || discovery.round_id != _connection?.CurrentRound?.id
            )
            {
                return;
            }
            if (
                _avatars.TryGetValue(
                    discovery.hider_player_id,
                    out CamouflagedPlayerAvatar avatar
                )
            )
            {
                avatar.PulseHit(true);
                avatar.SetStatus(
                    discovery.caused_infection_conversion
                        ? "converted"
                        : "found"
                );
                if (discovery.caused_infection_conversion)
                {
                    avatar.SetRole("hunter");
                }
            }
        }

        private void HandleFireResult(HunterFireResult result)
        {
            if (
                result == null
                || result.round_id != _connection?.CurrentRound?.id
            )
            {
                return;
            }
            if (
                !string.IsNullOrWhiteSpace(result.target_player_id)
                && _avatars.TryGetValue(
                    result.target_player_id,
                    out CamouflagedPlayerAvatar target
                )
            )
            {
                target.PulseHit(result.hit);
            }
            if (result.accepted && result.hit)
            {
                _hitMarkerUntil = Time.unscaledTime + 0.28f;
            }
        }

        private void HandleSpectatorState(SpectatorStateSnapshot spectator)
        {
            if (spectator?.round_id != _connection?.CurrentRound?.id)
            {
                return;
            }
            _spectatorTargetPlayerId = string.Empty;
            _freeCameraInitialized = false;
            if (spectator.eligible)
            {
                _cameraMode = 0;
                _spectatorCameraMode = 1;
                EnsureAllowedSpectatorCameraMode();
                UnlockCursor();
            }
            RefreshAvatarDisplayNames();
            ApplyRoundVisuals();
        }

        private void HandleAnswerCheck(AnswerCheckSnapshot answerCheck)
        {
            if (answerCheck?.round_id != _connection?.CurrentRound?.id)
            {
                return;
            }
            ApplyRoundVisuals();
        }

        private void HandleScores(RoundScoreSnapshot scores)
        {
            if (scores?.round_id != _connection?.CurrentRound?.id)
            {
                return;
            }
            _scoreboardVisibleUntil =
                Time.unscaledTime + ScoreboardDisplaySeconds;
            RefreshAvatarDisplayNames();
        }

        private void HandleReconnect(RoundReconnectSnapshot reconnect)
        {
            if (
                reconnect?.round_id == _connection?.CurrentRound?.id
                && reconnect.outcome_preserved
            )
            {
                ActivateArena();
                ApplyRoundVisuals();
            }
        }

        private void Unsubscribe()
        {
            if (_connection == null)
            {
                return;
            }
            _connection.RoundStateChanged -= HandleRoundChanged;
            _connection.RoundRoleAssigned -= HandleRoleAssigned;
            _connection.RoundPlayerStateChanged -= HandlePlayerStateChanged;
            _connection.RoundDiscoveryReceived -= HandleDiscovery;
            _connection.HunterFireResolved -= HandleFireResult;
            _connection.SpectatorStateChanged -= HandleSpectatorState;
            _connection.AnswerCheckChanged -= HandleAnswerCheck;
            _connection.RoundScoresChanged -= HandleScores;
            _connection.RoundReconnectChanged -= HandleReconnect;
            _connection.AvatarStateReceived -= HandleAvatarState;
            _connection.PaintStrokeReceived -= HandlePaintStroke;
            _connection.PaintStrokeResolved -= HandlePaintStrokeResult;
            _connection = null;
        }

        private void OnDisable()
        {
            _pauseOpen = false;
            _pauseStatus = string.Empty;
            EnterDormantState();
        }

        private void OnDestroy()
        {
            _paintMode?.Dispose();
            _paintMode = null;
            Unsubscribe();
            _leaveLobby = null;
            _lifetime?.Cancel();
            _lifetime?.Dispose();
            UnlockCursor();
        }
    }
}
