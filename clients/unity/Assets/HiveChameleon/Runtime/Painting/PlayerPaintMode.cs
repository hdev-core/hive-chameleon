using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using HiveChameleon.Realtime;
using UnityEngine;

namespace HiveChameleon.Painting
{
    [Serializable]
    public sealed class PaintInputBindings
    {
        public KeyCode togglePaintMode = KeyCode.P;
        public int paintButton;
        public int orbitButton = 1;
        public KeyCode materialSample = KeyCode.F;
        public KeyCode renderedSample = KeyCode.R;
        public KeyCode resizeModifier = KeyCode.LeftShift;
        public KeyCode toggleXRay = KeyCode.X;
        public KeyCode smallerBrush = KeyCode.LeftBracket;
        public KeyCode largerBrush = KeyCode.RightBracket;

        public static PaintInputBindings Load()
        {
            var bindings = new PaintInputBindings();
            string json = PlayerPrefs.GetString("hive.paint.input.v1", string.Empty);
            if (!string.IsNullOrWhiteSpace(json))
            {
                try
                {
                    JsonUtility.FromJsonOverwrite(json, bindings);
                }
                catch (ArgumentException)
                {
                    // Invalid local preferences fall back to the stable defaults.
                }
            }
            return bindings;
        }

        public void Save()
        {
            PlayerPrefs.SetString("hive.paint.input.v1", JsonUtility.ToJson(this));
            PlayerPrefs.Save();
        }
    }

    /// <summary>
    /// Owns the mutually exclusive Paint Mode states. It deliberately receives semantic body
    /// and connection abstractions instead of knowing anything about a particular FBX model.
    /// </summary>
    public sealed class PlayerPaintMode : IDisposable
    {
        private const float MinimumOrbitDistance = 1.35f;
        private const float MaximumOrbitDistance = 4.2f;
        private const float MaximumPaintDistance = 8f;
        private const float StrokeSpacingRatio = 0.22f;
        private const float OptimisticStrokeTimeout = 8f;
        // Nakama wraps these JSON bytes in base64 inside a WebSocket JSON envelope. Unity's
        // float serializer can use long round-trip decimals. Forty points keeps deliberate
        // headroom below the server's 4 KiB inbound frame limit, including future identifier
        // growth; splitting a freehand stroke does not change its local or replayed appearance.
        public const int MaximumPointsPerCommand = 40;
        private const int PaintCommandIntervalMilliseconds = 110;
        private const int ColorFieldWidth = 174;
        private const int ColorFieldHeight = 174;

        private static readonly Color[] ThemedPalette =
        {
            new Color32(235, 239, 236, 255),
            new Color32(42, 50, 58, 255),
            new Color32(160, 71, 55, 255),
            new Color32(81, 119, 68, 255),
            new Color32(174, 149, 102, 255),
            new Color32(58, 104, 151, 255),
            new Color32(214, 105, 42, 255),
            new Color32(211, 184, 138, 255),
            new Color32(91, 60, 42, 255),
            new Color32(120, 85, 139, 255),
            new Color32(42, 126, 132, 255),
            new Color32(192, 185, 65, 255),
        };

        private readonly Camera _camera;
        private readonly Transform _playerRig;
        private readonly CharacterController _controller;
        private readonly GameObject _localBodyObject;
        private readonly PaintableBody _body;
        private readonly NakamaRealtimeConnection _connection;
        private readonly CancellationToken _shutdownToken;
        private readonly Func<string> _phase;
        private readonly Func<string> _role;
        private readonly Action<int> _poseChanged;
        private readonly Action<bool> _activeChanged;
        private readonly PaintInputBindings _input;
        private readonly PaintMaterialSampler _materialSampler;
        private readonly PaintRenderedColorSampler _renderedSampler;
        private readonly Queue<PaintStrokeCommand> _outbox =
            new Queue<PaintStrokeCommand>();
        private readonly List<PaintPoint> _strokePoints = new List<PaintPoint>();
        private readonly SortedDictionary<long, PaintStrokeCommand> _optimisticStrokes =
            new SortedDictionary<long, PaintStrokeCommand>();
        private readonly Dictionary<long, float> _optimisticSentAt =
            new Dictionary<long, float>();
        private readonly SortedDictionary<long, PaintStrokeSnapshot> _acceptedStrokes =
            new SortedDictionary<long, PaintStrokeSnapshot>();
        private readonly Color[] _savedSwatches = new Color[12];
        private readonly PaintMaterialPreview _preview;

        private PaintMaterialValues _material = PaintMaterialValues.NeutralWhite;
        private PaintMaterialValues _previousMaterial = PaintMaterialValues.NeutralWhite;
        private PaintSampleResult _lastMaterialSample = PaintSampleResult.Failure(
            "No material sampled yet."
        );
        private PaintSampleResult _lastRenderedSample = PaintSampleResult.Failure(
            "No rendered color sampled yet."
        );
        private PaintChannels _channels = PaintChannels.BaseColor;
        private RenderedSampleRegion _sampleRegion = RenderedSampleRegion.ThreeByThree;
        private PaintInteractionState _state = PaintInteractionState.Gameplay;
        private Transform _cameraParent;
        private Vector3 _cameraLocalPosition;
        private Quaternion _cameraLocalRotation;
        private float _cameraFieldOfView;
        private Rect _panelRect;
        private Texture2D _colorField;
        private Texture2D _valueField;
        private Texture2D _brushCursor;
        private Texture2D _buttonNormalTexture;
        private Texture2D _buttonHoverTexture;
        private Texture2D _buttonActiveTexture;
        private Texture2D _fieldTexture;
        private float _fieldValue = -1f;
        private float _valueHue = -1f;
        private float _valueSaturation = -1f;
        private float _brushRadius = 0.045f;
        private float _brushHardness = 1f;
        private float _brushOpacity = 1f;
        private float _brushSpacing = StrokeSpacingRatio;
        private float _orbitYaw;
        private float _orbitPitch = 10f;
        private float _orbitDistance = 2.7f;
        private float _uiScale = 1f;
        private Vector2 _lowerScroll;
        private float _nextMaterialSampleAt;
        private float _nextPaintCommandAt;
        private long _nextClientSequence = 1;
        private string _roundId = string.Empty;
        private string _strokeRendererId = string.Empty;
        private Vector2 _lastStrokeUv;
        private string _hex = "FFFFFFFF";
        private string _red = "255";
        private string _green = "255";
        private string _blue = "255";
        private string _alpha = "255";
        private string _status = string.Empty;
        private bool _editingEmission;
        private bool _sampleAllChannels;
        private bool _srgbPreview = true;
        private bool _xray;
        private bool _sending;
        private bool _disposed;
        private bool _hasLastStrokeUv;
        private int _selectedPose = 1;

        private GUIStyle _heading;
        private GUIStyle _label;
        private GUIStyle _small;
        private GUIStyle _button;
        private GUIStyle _field;
        private GUIStyle _tooltip;
        private bool _stylesReady;

        public bool IsActive => _state != PaintInteractionState.Gameplay;
        public PaintInteractionState State => _state;
        public Color CurrentBaseColorLinear => _material.BaseColorLinear;

        public bool ReconcileAuthoritativeStroke(PaintStrokeSnapshot stroke)
        {
            if (stroke == null || stroke.client_sequence < 1)
            {
                return true;
            }
            _nextClientSequence = Math.Max(
                _nextClientSequence,
                stroke.client_sequence + 1
            );
            if (_acceptedStrokes.ContainsKey(stroke.sequence))
            {
                return false;
            }
            _acceptedStrokes[stroke.sequence] = stroke;
            // A locally authored command was already drawn as the pointer moved. Its server
            // echo acknowledges that preview and must not blend the same stroke a second time.
            bool wasOptimistic = _optimisticStrokes.Remove(stroke.client_sequence);
            _optimisticSentAt.Remove(stroke.client_sequence);
            return !wasOptimistic;
        }

        public void ReconcileAuthoritativeResult(PaintStrokeResult result)
        {
            if (
                result == null
                || result.client_sequence < 1
                || !string.Equals(result.round_id, _roundId, StringComparison.Ordinal)
            )
            {
                return;
            }
            if (result.accepted)
            {
                // During reconnect replay the accepted snapshot remains queued in server order.
                // Keep the local mark visible and disable its timeout until that snapshot arrives.
                if (_optimisticStrokes.ContainsKey(result.client_sequence))
                {
                    _optimisticSentAt[result.client_sequence] = float.PositiveInfinity;
                }
                return;
            }
            if (!_optimisticStrokes.Remove(result.client_sequence))
            {
                return;
            }
            _optimisticSentAt.Remove(result.client_sequence);
            RebuildPaint(includeOptimistic: true);
            _status = "That stroke could not be saved.";
        }

        public PlayerPaintMode(
            Camera camera,
            Transform playerRig,
            CharacterController controller,
            GameObject localBodyObject,
            NakamaRealtimeConnection connection,
            CancellationToken shutdownToken,
            Func<string> phase,
            Func<string> role,
            Action<int> poseChanged,
            Action<bool> activeChanged
        )
        {
            _camera = camera ?? throw new ArgumentNullException(nameof(camera));
            _playerRig = playerRig ?? throw new ArgumentNullException(nameof(playerRig));
            _controller = controller ?? throw new ArgumentNullException(nameof(controller));
            _localBodyObject = localBodyObject
                ?? throw new ArgumentNullException(nameof(localBodyObject));
            _body = localBodyObject.GetComponent<PaintableBody>()
                ?? throw new MissingComponentException(
                    "The local Hider is missing its PaintableBody definition."
                );
            _connection = connection ?? throw new ArgumentNullException(nameof(connection));
            _shutdownToken = shutdownToken;
            _phase = phase ?? throw new ArgumentNullException(nameof(phase));
            _role = role ?? throw new ArgumentNullException(nameof(role));
            _poseChanged = poseChanged;
            _activeChanged = activeChanged;
            _input = PaintInputBindings.Load();
            _materialSampler = new PaintMaterialSampler();
            _renderedSampler = new PaintRenderedColorSampler();
            _preview = new PaintMaterialPreview();
            _roundId = _connection.CurrentRound?.id ?? string.Empty;
            for (int index = 0; index < _savedSwatches.Length; index++)
            {
                _savedSwatches[index] = PaintColorMath.SrgbToLinear(
                    ThemedPalette[index]
                );
            }
            LoadSavedSwatches();
            RefreshColorText();
        }

        public void Tick(float uiScale)
        {
            if (_disposed)
            {
                return;
            }
            _uiScale = Mathf.Max(0.5f, uiScale);
            _panelRect = LayoutPanel(Screen.width / _uiScale, Screen.height / _uiScale);

            string activeRound = _connection.CurrentRound?.id ?? string.Empty;
            if (!string.Equals(activeRound, _roundId, StringComparison.Ordinal))
            {
                _roundId = activeRound;
                _nextClientSequence = 1;
                _outbox.Clear();
                _strokePoints.Clear();
                _optimisticStrokes.Clear();
                _optimisticSentAt.Clear();
                _acceptedStrokes.Clear();
                _nextPaintCommandAt = 0f;
                _status = string.Empty;
            }
            ExpireUnconfirmedStrokes();

            bool canPaint = CanPaintNow();
            if (Input.GetKeyDown(_input.togglePaintMode))
            {
                if (IsActive)
                {
                    Exit();
                }
                else if (canPaint)
                {
                    Enter();
                }
            }
            if (!IsActive)
            {
                return;
            }
            if (!canPaint)
            {
                Exit();
                return;
            }

            _controller.enabled = false;
            _localBodyObject.SetActive(true);
            UpdateOrbitCamera();
            _body.RefreshEditColliders();

            if (Input.GetKeyDown(_input.toggleXRay))
            {
                _xray = !_xray;
                _body.SetXRay(_xray);
                _state = _xray
                    ? PaintInteractionState.XRayPaintView
                    : PaintInteractionState.PaintIdle;
            }
            if (Input.GetKeyDown(_input.smallerBrush))
            {
                _brushRadius = Mathf.Clamp(_brushRadius * 0.85f, 0.005f, 0.25f);
            }
            if (Input.GetKeyDown(_input.largerBrush))
            {
                _brushRadius = Mathf.Clamp(_brushRadius * 1.18f, 0.005f, 0.25f);
            }

            bool overPanel = PointerOverPanel();
            if (overPanel)
            {
                FinishStroke();
                _state = PaintInteractionState.PaletteInteraction;
                return;
            }

            if (Input.GetKey(_input.materialSample))
            {
                FinishStroke();
                _state = PaintInteractionState.MaterialSamplerArmed;
                if (
                    Input.GetKeyDown(_input.materialSample)
                    || Time.unscaledTime >= _nextMaterialSampleAt
                )
                {
                    _nextMaterialSampleAt = Time.unscaledTime + 0.12f;
                    ApplySample(
                        _materialSampler.Sample(
                            _camera,
                            Input.mousePosition,
                            (int)_sampleRegion
                        ),
                        false
                    );
                }
                return;
            }
            if (Input.GetKeyDown(_input.renderedSample))
            {
                FinishStroke();
                _state = PaintInteractionState.RenderedSamplerArmed;
                ApplySample(
                    _renderedSampler.Sample(
                        _camera,
                        Input.mousePosition,
                        _sampleRegion,
                        _localBodyObject
                    ),
                    true
                );
                return;
            }

            float wheel = Input.mouseScrollDelta.y;
            if (Input.GetKey(_input.resizeModifier) && Mathf.Abs(wheel) > 0.01f)
            {
                FinishStroke();
                _brushRadius = Mathf.Clamp(
                    _brushRadius * Mathf.Pow(1.12f, wheel),
                    0.005f,
                    0.25f
                );
                _state = PaintInteractionState.BrushResizing;
                return;
            }
            if (Input.GetMouseButton(_input.orbitButton))
            {
                FinishStroke();
                _state = PaintInteractionState.CameraOrbit;
                return;
            }
            if (Input.GetMouseButton(_input.paintButton))
            {
                PaintAtPointer();
                return;
            }
            FinishStroke();
            _state = _xray
                ? PaintInteractionState.XRayPaintView
                : PaintInteractionState.PaintIdle;
        }

        public void Draw(float logicalWidth, float logicalHeight)
        {
            if (!IsActive || _disposed)
            {
                return;
            }
            EnsureStyles();
            _panelRect = LayoutPanel(logicalWidth, logicalHeight);
            DrawRect(_panelRect, new Color(0.018f, 0.019f, 0.021f, 0.965f));
            DrawRect(
                new Rect(_panelRect.x, _panelRect.y, _panelRect.width, 2f),
                new Color(0.88f, 0.66f, 0.25f)
            );
            GUI.Label(
                new Rect(_panelRect.x + 16f, _panelRect.y + 12f, _panelRect.width - 140f, 25f),
                "CHAMELEON PAINT",
                _heading
            );
            if (
                GUI.Button(
                    new Rect(_panelRect.xMax - 102f, _panelRect.y + 10f, 86f, 25f),
                    "P  CLOSE",
                    _button
                )
            )
            {
                Exit();
            }

            Rect viewport = new Rect(
                _panelRect.x + 10f,
                _panelRect.y + 47f,
                _panelRect.width - 20f,
                _panelRect.height - 79f
            );
            float contentWidth = viewport.width - 18f;
            _lowerScroll = GUI.BeginScrollView(
                viewport,
                _lowerScroll,
                new Rect(0f, 0f, contentWidth, 960f),
                false,
                true
            );
            float x = 5f;
            float y = 2f;
            float width = contentWidth - 10f;
            GUI.Label(
                new Rect(x, y, width, 19f),
                _editingEmission ? "EMISSION COLOR" : "BASE COLOR",
                _label
            );
            y += 21f;

            float hue;
            float saturation;
            float value;
            Color.RGBToHSV(
                PaintColorMath.LinearToSrgb(CurrentEditedColor()),
                out hue,
                out saturation,
                out value
            );
            if (Mathf.Abs(value - _fieldValue) > 0.002f || _colorField == null)
            {
                _fieldValue = value;
                RebuildColorField();
            }
            if (
                Mathf.Abs(hue - _valueHue) > 0.002f
                || Mathf.Abs(saturation - _valueSaturation) > 0.002f
                || _valueField == null
            )
            {
                _valueHue = hue;
                _valueSaturation = saturation;
                RebuildValueField();
            }
            float wheelSize = Mathf.Clamp(width * 0.52f, 158f, 220f);
            Rect colorRect = new Rect(x, y, wheelSize, wheelSize);
            GUI.DrawTexture(colorRect, _colorField, ScaleMode.StretchToFill, false);
            float angle = hue * Mathf.PI * 2f;
            Vector2 marker = colorRect.center + new Vector2(
                Mathf.Cos(angle),
                -Mathf.Sin(angle)
            ) * (saturation * colorRect.width * 0.48f);
            DrawRect(new Rect(marker.x - 6f, marker.y - 1f, 12f, 2f), Color.black);
            DrawRect(new Rect(marker.x - 1f, marker.y - 6f, 2f, 12f), Color.black);
            DrawRect(new Rect(marker.x - 5f, marker.y, 10f, 1f), Color.white);
            DrawRect(new Rect(marker.x, marker.y - 5f, 1f, 10f), Color.white);
            if (
                Event.current.type == EventType.MouseDown
                || Event.current.type == EventType.MouseDrag
            )
            {
                if (colorRect.Contains(Event.current.mousePosition))
                {
                    Vector2 delta = Event.current.mousePosition - colorRect.center;
                    float wheelSaturation = Mathf.Clamp01(
                        delta.magnitude / (colorRect.width * 0.5f)
                    );
                    if (wheelSaturation <= 1f)
                    {
                        float wheelHue = Mathf.Repeat(
                            Mathf.Atan2(-delta.y, delta.x) / (Mathf.PI * 2f),
                            1f
                        );
                        SetEditedColor(
                            PaintColorMath.SrgbToLinear(
                                Color.HSVToRGB(wheelHue, wheelSaturation, value)
                            )
                        );
                        Event.current.Use();
                    }
                }
            }

            Rect valueRect = new Rect(colorRect.xMax + 8f, y, 18f, wheelSize);
            GUI.DrawTexture(valueRect, _valueField, ScaleMode.StretchToFill, false);
            DrawRect(
                new Rect(valueRect.x - 2f, valueRect.y + (1f - value) * valueRect.height - 1f,
                    valueRect.width + 4f, 2f),
                Color.white
            );
            if (
                (Event.current.type == EventType.MouseDown
                    || Event.current.type == EventType.MouseDrag)
                && valueRect.Contains(Event.current.mousePosition)
            )
            {
                float stripValue = 1f - Mathf.Clamp01(
                    (Event.current.mousePosition.y - valueRect.y) / valueRect.height
                );
                SetEditedColor(
                    PaintColorMath.SrgbToLinear(Color.HSVToRGB(hue, saturation, stripValue))
                );
                Event.current.Use();
            }

            float previewX = valueRect.xMax + 10f;
            float previewWidth = Mathf.Max(72f, x + width - previewX);
            Rect previewRect = new Rect(previewX, y, previewWidth, Mathf.Min(126f, wheelSize * 0.62f));
            _preview.SetMaterial(_material);
            GUI.DrawTexture(previewRect, _preview.Texture, ScaleMode.ScaleToFit, false);
            GUI.Label(new Rect(previewX, previewRect.yMax + 1f, previewWidth, 17f), "NEUTRAL LIGHT", _small);
            Rect previous = new Rect(previewX, previewRect.yMax + 22f, (previewWidth - 6f) * 0.42f, 32f);
            Rect current = new Rect(previous.xMax + 6f, previous.y, previewWidth - previous.width - 6f, 32f);
            DrawSwatch(previous, PreviewColor(_previousMaterial.BaseColorLinear));
            DrawSwatch(current, PreviewColor(CurrentEditedColor()));
            GUI.Label(new Rect(previous.x, previous.yMax + 1f, previous.width, 16f), "BEFORE", _small);
            GUI.Label(new Rect(current.x, current.yMax + 1f, current.width, 16f), "ACTIVE", _small);
            y += wheelSize + 10f;

            float nextHue = LabeledSlider(x, ref y, width, "Hue", hue, 0f, 1f,
                "Selects the color family. Values are shown through an sRGB preview.");
            if (!Mathf.Approximately(nextHue, hue))
            {
                SetEditedColor(
                    PaintColorMath.SrgbToLinear(
                        Color.HSVToRGB(nextHue, saturation, value)
                    )
                );
            }
            float nextSaturation = LabeledSlider(
                x, ref y, width, "Saturation", saturation, 0f, 1f,
                "Controls how vivid the color is. Zero is neutral gray."
            );
            if (!Mathf.Approximately(nextSaturation, saturation))
            {
                SetEditedColor(
                    PaintColorMath.SrgbToLinear(Color.HSVToRGB(hue, nextSaturation, value))
                );
            }
            float nextValue = LabeledSlider(
                x, ref y, width, "Brightness", value, 0f, 1f,
                "Controls the unlit color value before the map lighting is applied."
            );
            if (!Mathf.Approximately(nextValue, value))
            {
                SetEditedColor(
                    PaintColorMath.SrgbToLinear(Color.HSVToRGB(hue, saturation, nextValue))
                );
            }

            DrawColorEntries(x, ref y, width);
            _srgbPreview = GUI.Toggle(
                new Rect(x, y, width, 20f),
                _srgbPreview,
                new GUIContent(
                    "sRGB preview",
                    "Display swatches and 0–255/hex values as standard screen colors. Paint remains linear internally."
                )
            );
            y += 25f;

            DrawMaterialControls(x, ref y, width);
            DrawChannelControls(x, ref y, width);
            DrawSwatches(x, ref y, width);
            DrawSamplerComparison(x, ref y, width);
            DrawPoseAndViewControls(x, ref y, width);

            if (!string.IsNullOrWhiteSpace(_status))
            {
                GUI.Label(new Rect(x, y, width, 34f), _status, _small);
                y += 36f;
            }
            GUI.EndScrollView();
            GUI.Label(
                new Rect(_panelRect.x + 16f, _panelRect.yMax - 25f, _panelRect.width - 32f, 18f),
                new GUIContent(
                    "SHADOW  LOCKED ON",
                    "Cast shadows are server-owned for competitive fairness. Paint Mode cannot disable them."
                ),
                _small
            );

            if (!string.IsNullOrWhiteSpace(GUI.tooltip))
            {
                Vector2 size = _tooltip.CalcSize(new GUIContent(GUI.tooltip));
                Vector2 point = Event.current.mousePosition + new Vector2(12f, 16f);
                Rect tip = new Rect(
                    Mathf.Min(point.x, logicalWidth - size.x - 18f),
                    Mathf.Min(point.y, logicalHeight - size.y - 12f),
                    Mathf.Min(340f, size.x + 16f),
                    size.y + 10f
                );
                DrawRect(tip, new Color(0.005f, 0.012f, 0.018f, 0.98f));
                GUI.Label(
                    new Rect(tip.x + 8f, tip.y + 5f, tip.width - 16f, tip.height - 10f),
                    GUI.tooltip,
                    _tooltip
                );
            }

            DrawBrushCursor(logicalWidth, logicalHeight);
        }

        private bool CanPaintNow()
        {
            string phase = _phase();
            return _role() == "hider" && (phase == "preparing" || phase == "hiding");
        }

        private void Enter()
        {
            _cameraParent = _camera.transform.parent;
            _cameraLocalPosition = _camera.transform.localPosition;
            _cameraLocalRotation = _camera.transform.localRotation;
            _cameraFieldOfView = _camera.fieldOfView;
            _orbitYaw = _playerRig.eulerAngles.y;
            _orbitPitch = 8f;
            _orbitDistance = 2.7f;
            _camera.fieldOfView = 51f;
            _controller.enabled = false;
            _localBodyObject.SetActive(true);
            _body.EnterEditMode();
            _body.SetShadowPreview(true);
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
            _state = PaintInteractionState.PaintIdle;
            _activeChanged?.Invoke(true);
            UpdateOrbitCamera();
        }

        public void Exit()
        {
            if (!IsActive)
            {
                return;
            }
            FinishStroke();
            _body.ExitEditMode();
            _body.SetShadowPreview(true);
            _xray = false;
            _camera.transform.SetParent(_cameraParent, false);
            _camera.transform.localPosition = _cameraLocalPosition;
            _camera.transform.localRotation = _cameraLocalRotation;
            _camera.fieldOfView = _cameraFieldOfView;
            _state = PaintInteractionState.Gameplay;
            _activeChanged?.Invoke(false);
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
        }

        private void UpdateOrbitCamera()
        {
            if (Input.GetMouseButton(_input.orbitButton) && !PointerOverPanel())
            {
                _orbitYaw += Input.GetAxis("Mouse X") * 3.2f;
                _orbitPitch = Mathf.Clamp(
                    _orbitPitch - Input.GetAxis("Mouse Y") * 2.8f,
                    -42f,
                    62f
                );
            }
            if (!Input.GetKey(_input.resizeModifier))
            {
                _orbitDistance = Mathf.Clamp(
                    _orbitDistance - Input.mouseScrollDelta.y * 0.22f,
                    MinimumOrbitDistance,
                    MaximumOrbitDistance
                );
            }
            Vector3 focus = _playerRig.position + Vector3.up * 1.05f;
            Quaternion rotation = Quaternion.Euler(_orbitPitch, _orbitYaw, 0f);
            Vector3 position =
                focus + rotation * new Vector3(-0.42f, 0f, -_orbitDistance);
            _camera.transform.SetParent(null, true);
            _camera.transform.SetPositionAndRotation(
                position,
                Quaternion.LookRotation(focus - position, Vector3.up)
            );
        }

        private void PaintAtPointer()
        {
            if (
                !_body.TryRaycast(
                    _camera.ScreenPointToRay(Input.mousePosition),
                    MaximumPaintDistance,
                    out PaintBodyHit hit
                )
            )
            {
                FinishStroke();
                _state = PaintInteractionState.PaintIdle;
                return;
            }
            if (
                _hasLastStrokeUv
                && !string.Equals(
                    _strokeRendererId,
                    hit.RendererId,
                    StringComparison.Ordinal
                )
            )
            {
                FinishStroke();
            }
            _strokeRendererId = hit.RendererId;
            AddInterpolatedPoint(hit.UV);
            _state = PaintInteractionState.PaintingStroke;
        }

        private void AddInterpolatedPoint(Vector2 uv)
        {
            if (!_hasLastStrokeUv)
            {
                AppendStrokePoint(uv);
                return;
            }
            Vector2 previous = _lastStrokeUv;
            float distance = Vector2.Distance(previous, uv);
            if (distance > 0.5f)
            {
                string rendererId = _strokeRendererId;
                FinishStroke();
                _strokeRendererId = rendererId;
                AppendStrokePoint(uv);
                return;
            }
            float spacing = Mathf.Max(0.002f, _brushRadius * _brushSpacing);
            int stamps = Mathf.FloorToInt(distance / spacing);
            for (int index = 1; index <= stamps; index++)
            {
                float amount = Mathf.Min(1f, index * spacing / Mathf.Max(distance, 0.0001f));
                Vector2 point = Vector2.Lerp(previous, uv, amount);
                AppendStrokePoint(point);
            }
            if (stamps == 0 && Input.GetMouseButtonDown(_input.paintButton))
            {
                AppendStrokePoint(uv);
            }
        }

        private void AppendStrokePoint(Vector2 uv)
        {
            _lastStrokeUv = uv;
            _hasLastStrokeUv = true;
            _strokePoints.Add(new PaintPoint(uv.x, uv.y));
            // Draw on the local atlas immediately. The authoritative echo reconciles this
            // optimistic mark; a missing/rejected echo restores the accepted stroke history.
            _body.ApplyStroke(
                _strokeRendererId,
                new[] { uv },
                _brushRadius,
                _brushHardness,
                _brushOpacity,
                _material,
                _channels
            );
            if (_strokePoints.Count >= MaximumPointsPerCommand)
            {
                FlushStrokeChunk();
            }
        }

        private void FinishStroke()
        {
            if (_strokePoints.Count > 0)
            {
                FlushStrokeChunk();
            }
            _strokeRendererId = string.Empty;
            _hasLastStrokeUv = false;
        }

        private void FlushStrokeChunk()
        {
            if (_strokePoints.Count == 0 || string.IsNullOrWhiteSpace(_strokeRendererId))
            {
                _strokePoints.Clear();
                return;
            }
            long clientSequence = _nextClientSequence++;
            var command = new PaintStrokeCommand
            {
                body_id = _body.BodyId,
                renderer_id = _strokeRendererId,
                points = _strokePoints.ToArray(),
                radius = _brushRadius,
                hardness = _brushHardness,
                opacity = _brushOpacity,
                material = ToSnapshot(_material),
                channels = (int)_channels,
                client_sequence = clientSequence,
                client_tick = Mathf.Max(0, Mathf.RoundToInt(Time.time * 1000f)),
            };
            _outbox.Enqueue(command);
            // The delivery queue can legitimately hold more than two seconds of a long
            // freehand stroke. Start the acknowledgement clock only when this command is sent.
            _optimisticStrokes[clientSequence] = command;
            _optimisticSentAt[clientSequence] = float.PositiveInfinity;
            _strokePoints.Clear();
            if (!_sending)
            {
                SendOutbox();
            }
        }

        private async void SendOutbox()
        {
            _sending = true;
            try
            {
                while (_outbox.Count > 0 && !_shutdownToken.IsCancellationRequested)
                {
                    float waitSeconds = _nextPaintCommandAt - Time.unscaledTime;
                    if (waitSeconds > 0f)
                    {
                        await Task.Delay(
                            Mathf.CeilToInt(waitSeconds * 1000f),
                            _shutdownToken
                        );
                    }
                    PaintStrokeCommand command = _outbox.Peek();
                    _optimisticSentAt[command.client_sequence] = Time.unscaledTime;
                    await _connection.SendPaintStrokeAsync(command, _shutdownToken);
                    _outbox.Dequeue();
                    // This deadline survives separate SendOutbox invocations, so rapid clicks
                    // cannot bypass the same 10 Hz pacing applied to a continuous drag.
                    _nextPaintCommandAt =
                        Time.unscaledTime + PaintCommandIntervalMilliseconds / 1000f;
                }
            }
            catch (OperationCanceledException) when (_shutdownToken.IsCancellationRequested)
            {
                _outbox.Clear();
                RejectOptimisticStrokes();
            }
            catch (Exception exception)
            {
                _outbox.Clear();
                RejectOptimisticStrokes();
                _status = "Paint was not saved because the connection was interrupted.";
                Debug.LogWarning($"Paint stroke delivery failed: {exception.Message}");
            }
            finally
            {
                _sending = false;
            }
        }

        private void ExpireUnconfirmedStrokes()
        {
            var expired = new List<long>();
            foreach (KeyValuePair<long, float> pending in _optimisticSentAt)
            {
                if (Time.unscaledTime - pending.Value < OptimisticStrokeTimeout)
                {
                    continue;
                }
                expired.Add(pending.Key);
            }
            if (expired.Count == 0)
            {
                return;
            }
            for (int index = 0; index < expired.Count; index++)
            {
                _optimisticStrokes.Remove(expired[index]);
                _optimisticSentAt.Remove(expired[index]);
            }
            RebuildPaint(includeOptimistic: true);
            if (expired.Count > 0)
            {
                _status = "The server did not accept that stroke.";
            }
        }

        private void RejectOptimisticStrokes()
        {
            if (_optimisticStrokes.Count == 0)
            {
                return;
            }
            _optimisticStrokes.Clear();
            _optimisticSentAt.Clear();
            _strokePoints.Clear();
            _strokeRendererId = string.Empty;
            _hasLastStrokeUv = false;
            RebuildPaint(includeOptimistic: false);
        }

        private void RebuildPaint(bool includeOptimistic)
        {
            _body.ResetPaint(CurrentNeutralMaterial());
            foreach (PaintStrokeSnapshot stroke in _acceptedStrokes.Values)
            {
                ApplySnapshot(_body, stroke);
            }
            if (!includeOptimistic)
            {
                return;
            }
            foreach (PaintStrokeCommand command in _optimisticStrokes.Values)
            {
                ApplyCommand(_body, command);
            }
        }

        private PaintMaterialValues CurrentNeutralMaterial()
        {
            Color linear = PaintColorMath.SrgbToLinear(_body.InitialBodyColor);
            return new PaintMaterialValues
            {
                BaseColorLinear = linear,
                Metallic = 0f,
                Roughness = 0.82f,
                EmissionColorLinear = Color.black,
                EmissionIntensity = 0f,
            };
        }

        private static void ApplySnapshot(PaintableBody body, PaintStrokeSnapshot stroke)
        {
            if (body == null || stroke == null || stroke.material == null || stroke.points == null)
            {
                return;
            }
            var points = new Vector2[stroke.points.Length];
            for (int index = 0; index < points.Length; index++)
            {
                points[index] = new Vector2(stroke.points[index].u, stroke.points[index].v);
            }
            PaintMaterialSnapshot material = stroke.material;
            body.ApplyStroke(
                stroke.renderer_id,
                points,
                stroke.radius,
                stroke.hardness,
                stroke.opacity,
                new PaintMaterialValues
                {
                    BaseColorLinear = new Color(material.base_r, material.base_g, material.base_b, 1f),
                    Metallic = material.metallic,
                    Roughness = material.roughness,
                    EmissionColorLinear = new Color(
                        material.emission_r,
                        material.emission_g,
                        material.emission_b,
                        1f
                    ),
                    EmissionIntensity = material.emission_intensity,
                },
                (PaintChannels)stroke.channels
            );
        }

        private static void ApplyCommand(PaintableBody body, PaintStrokeCommand command)
        {
            if (body == null || command == null || command.material == null || command.points == null)
            {
                return;
            }
            var points = new Vector2[command.points.Length];
            for (int index = 0; index < points.Length; index++)
            {
                points[index] = new Vector2(command.points[index].u, command.points[index].v);
            }
            PaintMaterialSnapshot material = command.material;
            body.ApplyStroke(
                command.renderer_id,
                points,
                command.radius,
                command.hardness,
                command.opacity,
                new PaintMaterialValues
                {
                    BaseColorLinear = new Color(material.base_r, material.base_g, material.base_b, 1f),
                    Metallic = material.metallic,
                    Roughness = material.roughness,
                    EmissionColorLinear = new Color(
                        material.emission_r,
                        material.emission_g,
                        material.emission_b,
                        1f
                    ),
                    EmissionIntensity = material.emission_intensity,
                },
                (PaintChannels)command.channels
            );
        }

        private void ApplySample(PaintSampleResult sample, bool rendered)
        {
            if (rendered)
            {
                _lastRenderedSample = sample;
            }
            else
            {
                _lastMaterialSample = sample;
            }
            if (!sample.Available)
            {
                _status = sample.Status;
                return;
            }
            _previousMaterial = _material;
            if (rendered || !_sampleAllChannels)
            {
                _material.BaseColorLinear = sample.Material.BaseColorLinear;
            }
            else
            {
                _material = PaintMaterialValues.Blend(
                    _material,
                    sample.Material,
                    1f,
                    sample.AvailableChannels
                );
            }
            _status = rendered
                ? "Rendered sample includes current lighting."
                : "Material sample reads the surface before lighting.";
            RefreshColorText();
        }

        private void DrawMaterialControls(float x, ref float y, float width)
        {
            _brushRadius = LabeledSlider(x, ref y, width, "Radius", _brushRadius, 0.005f, 0.25f,
                "Size of each circular stamp in normalized body-surface UV space.");
            _brushHardness = LabeledSlider(x, ref y, width, "Hardness", _brushHardness, 0f, 1f,
                "One gives a crisp competitive edge; lower values feather the edge.");
            _brushOpacity = LabeledSlider(x, ref y, width, "Brush opacity", _brushOpacity, 0f, 1f,
                "Stroke strength. This does not make the player's body transparent.");
            _material.Metallic = LabeledSlider(x, ref y, width, "Metallic", _material.Metallic, 0f, 1f,
                "Zero behaves like painted plastic; one behaves like metal.");
            _material.Roughness = LabeledSlider(x, ref y, width, "Roughness", _material.Roughness, 0f, 1f,
                "Higher values spread reflections and look more matte.");
            _material.EmissionIntensity = LabeledSlider(
                x,
                ref y,
                width,
                "Emission",
                _material.EmissionIntensity,
                0f,
                8f,
                "Adds self-lit color. It does not illuminate the map."
            );

            if (GUI.Button(new Rect(x, y, width * 0.48f, 24f),
                _editingEmission ? "EDIT BASE" : "EDIT EMISSION", _button))
            {
                _editingEmission = !_editingEmission;
                RefreshColorText();
            }
            if (GUI.Button(new Rect(x + width * 0.52f, y, width * 0.48f, 24f),
                "EMISSION ← BASE", _button))
            {
                _material.EmissionColorLinear = _material.BaseColorLinear;
            }
            y += 31f;
        }

        private void DrawChannelControls(float x, ref float y, float width)
        {
            GUI.Label(new Rect(x, y, width, 19f), "PAINT CHANNELS", _label);
            y += 20f;
            float cell = width / 4f;
            ToggleChannel(new Rect(x, y, cell, 21f), "COLOR", PaintChannels.BaseColor);
            ToggleChannel(new Rect(x + cell, y, cell, 21f), "METAL", PaintChannels.Metallic);
            ToggleChannel(new Rect(x + cell * 2f, y, cell, 21f), "ROUGH", PaintChannels.Roughness);
            ToggleChannel(new Rect(x + cell * 3f, y, cell, 21f), "EMIT", PaintChannels.Emission);
            y += 27f;
            _sampleAllChannels = GUI.Toggle(
                new Rect(x, y, width, 20f),
                _sampleAllChannels,
                new GUIContent(
                    "Material Sample overwrites supported PBR channels",
                    "Off changes base color only. On also copies metallic, roughness, and emission when the surface exposes them."
                )
            );
            y += 25f;
        }

        private void ToggleChannel(Rect rect, string label, PaintChannels channel)
        {
            bool enabled = (_channels & channel) != 0;
            bool next = GUI.Toggle(rect, enabled, label);
            if (next)
            {
                _channels |= channel;
            }
            else if (_channels != channel)
            {
                _channels &= ~channel;
            }
        }

        private void DrawSwatches(float x, ref float y, float width)
        {
            GUI.Label(new Rect(x, y, width, 19f), "SAVED / MAP PALETTE", _label);
            y += 21f;
            const int columns = 6;
            const float gap = 5f;
            float swatch = (width - gap * (columns - 1)) / columns;
            for (int index = 0; index < _savedSwatches.Length; index++)
            {
                int row = index / columns;
                int column = index % columns;
                Rect rect = new Rect(
                    x + column * (swatch + gap),
                    y + row * 30f,
                    swatch,
                    25f
                );
                if (GUI.Button(rect, string.Empty, GUIStyle.none))
                {
                    _previousMaterial = _material;
                    SetEditedColor(_savedSwatches[index]);
                }
                DrawSwatch(rect, PreviewColor(_savedSwatches[index]));
            }
            y += 63f;
            if (GUI.Button(new Rect(x, y, width, 23f), "SAVE CURRENT SWATCH", _button))
            {
                for (int index = _savedSwatches.Length - 1; index > 0; index--)
                {
                    _savedSwatches[index] = _savedSwatches[index - 1];
                }
                _savedSwatches[0] = CurrentEditedColor();
                SaveSwatches();
            }
            y += 30f;
        }

        private void DrawSamplerComparison(float x, ref float y, float width)
        {
            GUI.Label(new Rect(x, y, width, 19f), "SAMPLES", _label);
            y += 20f;
            float half = (width - 8f) * 0.5f;
            Rect materialRect = new Rect(x, y, half, 43f);
            Rect renderedRect = new Rect(x + half + 8f, y, half, 43f);
            DrawSample(materialRect, _lastMaterialSample, "MATERIAL");
            DrawSample(renderedRect, _lastRenderedSample, "RENDERED / LIT");
            y += 49f;
            if (GUI.Button(new Rect(x, y, width / 3f - 4f, 22f), "1×1", _button))
            {
                _sampleRegion = RenderedSampleRegion.OneByOne;
            }
            if (GUI.Button(new Rect(x + width / 3f, y, width / 3f - 4f, 22f), "3×3", _button))
            {
                _sampleRegion = RenderedSampleRegion.ThreeByThree;
            }
            if (GUI.Button(new Rect(x + width * 2f / 3f, y, width / 3f, 22f), "5×5", _button))
            {
                _sampleRegion = RenderedSampleRegion.FiveByFive;
            }
            y += 29f;
        }

        private void DrawSample(Rect rect, PaintSampleResult sample, string label)
        {
            DrawRect(rect, new Color(0.02f, 0.055f, 0.07f, 0.95f));
            Color color = sample.Available
                ? PreviewColor(sample.Material.BaseColorLinear)
                : new Color(0.13f, 0.16f, 0.18f);
            DrawSwatch(new Rect(rect.x + 5f, rect.y + 7f, 29f, 29f), color);
            GUI.Label(new Rect(rect.x + 40f, rect.y + 4f, rect.width - 44f, 18f), label, _small);
            GUI.Label(
                new Rect(rect.x + 40f, rect.y + 21f, rect.width - 44f, 18f),
                sample.Available ? sample.Source : "—",
                _small
            );
        }

        private void DrawPoseAndViewControls(float x, ref float y, float width)
        {
            float cell = width / 3f;
            string[] labels = { "STAND", "RUN", "CROUCH", "AIM", "PAINT" };
            int[] poses = { 1, 2, 3, 4, 5 };
            for (int index = 0; index < labels.Length; index++)
            {
                float row = index / 3;
                float column = index % 3;
                if (
                    GUI.Button(
                        new Rect(x + column * cell, y + row * 27f, cell - 4f, 23f),
                        labels[index],
                        _button
                    )
                )
                {
                    _selectedPose = poses[index];
                    _poseChanged?.Invoke(_selectedPose);
                }
            }
            if (
                GUI.Button(
                    new Rect(x + cell * 2f, y + 27f, cell - 4f, 23f),
                    _xray ? "X-RAY ON" : "X-RAY OFF",
                    _button
                )
            )
            {
                _xray = !_xray;
                _body.SetXRay(_xray);
            }
            y += 58f;
            if (GUI.Button(new Rect(x, y, width, 27f), "RETURN TO GAME", _button))
            {
                Exit();
            }
            y += 33f;
        }

        private void DrawColorEntries(float x, ref float y, float width)
        {
            Color srgb = PaintColorMath.LinearToSrgb(CurrentEditedColor());
            float cell = (width - 18f) / 4f;
            string[] values = { _red, _green, _blue, _alpha };
            string[] labels = { "R", "G", "B", "A" };
            bool changed = false;
            for (int index = 0; index < 4; index++)
            {
                GUI.Label(new Rect(x + index * (cell + 6f), y, 14f, 20f), labels[index], _small);
                string next = GUI.TextField(
                    new Rect(x + 15f + index * (cell + 6f), y, cell - 15f, 21f),
                    values[index],
                    3,
                    _field
                );
                if (next != values[index])
                {
                    values[index] = next;
                    changed = true;
                }
            }
            _red = values[0];
            _green = values[1];
            _blue = values[2];
            _alpha = values[3];
            y += 26f;
            string nextHex = GUI.TextField(new Rect(x, y, width, 22f), _hex, 8, _field);
            if (!string.Equals(nextHex, _hex, StringComparison.Ordinal))
            {
                _hex = nextHex.ToUpperInvariant();
                if (PaintColorMath.TryParseRgbaHex(_hex, out Color linear))
                {
                    SetEditedColor(linear, false);
                    changed = false;
                }
            }
            if (changed && TryParseByte(_red, out byte r) && TryParseByte(_green, out byte g)
                && TryParseByte(_blue, out byte b) && TryParseByte(_alpha, out byte a))
            {
                SetEditedColor(
                    PaintColorMath.SrgbToLinear(new Color32(r, g, b, a)),
                    false
                );
                _hex = PaintColorMath.ToRgbaHex(CurrentEditedColor());
            }
            y += 28f;
            _ = srgb;
        }

        private static bool TryParseByte(string text, out byte value)
        {
            return byte.TryParse(
                text,
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out value
            );
        }

        private float LabeledSlider(
            float x,
            ref float y,
            float width,
            string label,
            float value,
            float minimum,
            float maximum,
            string tooltip
        )
        {
            GUI.Label(
                new Rect(x, y, 100f, 19f),
                new GUIContent(label, tooltip),
                _small
            );
            float next = GUI.HorizontalSlider(
                new Rect(x + 104f, y + 4f, width - 151f, 16f),
                value,
                minimum,
                maximum
            );
            GUI.Label(
                new Rect(x + width - 43f, y, 43f, 19f),
                next.ToString("0.00", CultureInfo.InvariantCulture),
                _small
            );
            y += 22f;
            return next;
        }

        private void DrawBrushCursor(float logicalWidth, float logicalHeight)
        {
            if (PointerOverPanel() || _state == PaintInteractionState.CameraOrbit)
            {
                return;
            }
            EnsureBrushCursor();
            Vector2 pointer = new Vector2(
                Input.mousePosition.x / _uiScale,
                logicalHeight - Input.mousePosition.y / _uiScale
            );
            float size = Mathf.Lerp(18f, 86f, _brushRadius / 0.25f);
            GUI.DrawTexture(
                new Rect(pointer.x - size * 0.5f, pointer.y - size * 0.5f, size, size),
                _brushCursor,
                ScaleMode.StretchToFill,
                true
            );
        }

        private bool PointerOverPanel()
        {
            Vector2 pointer = new Vector2(
                Input.mousePosition.x / _uiScale,
                Screen.height / _uiScale - Input.mousePosition.y / _uiScale
            );
            return _panelRect.Contains(pointer);
        }

        private static Rect LayoutPanel(float width, float height)
        {
            float panelWidth = Mathf.Min(420f, width - 28f);
            return new Rect(
                16f,
                68f,
                panelWidth,
                Mathf.Max(420f, height - 82f)
            );
        }

        private Color CurrentEditedColor()
        {
            return _editingEmission
                ? _material.EmissionColorLinear
                : _material.BaseColorLinear;
        }

        private void SetEditedColor(Color linear, bool refreshText = true)
        {
            _previousMaterial = _material;
            if (_editingEmission)
            {
                _material.EmissionColorLinear = PaintColorMath.ClampLinear(linear);
            }
            else
            {
                _material.BaseColorLinear = PaintColorMath.ClampLinear(linear);
            }
            if (refreshText)
            {
                RefreshColorText();
            }
        }

        private Color PreviewColor(Color linear)
        {
            return _srgbPreview ? PaintColorMath.LinearToSrgb(linear) : linear;
        }

        private void RefreshColorText()
        {
            Color srgb = PaintColorMath.LinearToSrgb(CurrentEditedColor());
            _red = Mathf.RoundToInt(srgb.r * 255f).ToString(CultureInfo.InvariantCulture);
            _green = Mathf.RoundToInt(srgb.g * 255f).ToString(CultureInfo.InvariantCulture);
            _blue = Mathf.RoundToInt(srgb.b * 255f).ToString(CultureInfo.InvariantCulture);
            _alpha = Mathf.RoundToInt(srgb.a * 255f).ToString(CultureInfo.InvariantCulture);
            _hex = PaintColorMath.ToRgbaHex(CurrentEditedColor());
        }

        private static PaintMaterialSnapshot ToSnapshot(PaintMaterialValues value)
        {
            PaintMaterialValues safe = value.Clamped();
            return new PaintMaterialSnapshot
            {
                base_r = safe.BaseColorLinear.r,
                base_g = safe.BaseColorLinear.g,
                base_b = safe.BaseColorLinear.b,
                metallic = safe.Metallic,
                roughness = safe.Roughness,
                emission_r = safe.EmissionColorLinear.r,
                emission_g = safe.EmissionColorLinear.g,
                emission_b = safe.EmissionColorLinear.b,
                emission_intensity = safe.EmissionIntensity,
            };
        }

        private void RebuildColorField()
        {
            if (_colorField == null)
            {
                _colorField = new Texture2D(
                    ColorFieldWidth,
                    ColorFieldHeight,
                    TextureFormat.RGBA32,
                    false,
                    false
                )
                {
                    name = "HC Paint Color Field",
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp,
                    hideFlags = HideFlags.HideAndDontSave,
                };
            }
            var pixels = new Color32[ColorFieldWidth * ColorFieldHeight];
            for (int row = 0; row < ColorFieldHeight; row++)
            {
                for (int column = 0; column < ColorFieldWidth; column++)
                {
                    float x = column / (float)(ColorFieldWidth - 1) * 2f - 1f;
                    float y = row / (float)(ColorFieldHeight - 1) * 2f - 1f;
                    float saturation = Mathf.Sqrt(x * x + y * y);
                    if (saturation > 1f)
                    {
                        pixels[row * ColorFieldWidth + column] = new Color32(0, 0, 0, 0);
                        continue;
                    }
                    float hue = Mathf.Repeat(Mathf.Atan2(y, x) / (Mathf.PI * 2f), 1f);
                    pixels[row * ColorFieldWidth + column] =
                        Color.HSVToRGB(hue, saturation, _fieldValue);
                }
            }
            _colorField.SetPixels32(pixels);
            _colorField.Apply(false, false);
        }

        private void RebuildValueField()
        {
            const int height = 174;
            if (_valueField == null)
            {
                _valueField = new Texture2D(1, height, TextureFormat.RGBA32, false, false)
                {
                    name = "HC Paint Value Field",
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp,
                    hideFlags = HideFlags.HideAndDontSave,
                };
            }
            var pixels = new Color32[height];
            for (int row = 0; row < height; row++)
            {
                float value = row / (float)(height - 1);
                pixels[row] = Color.HSVToRGB(_valueHue, _valueSaturation, value);
            }
            _valueField.SetPixels32(pixels);
            _valueField.Apply(false, false);
        }

        private void EnsureBrushCursor()
        {
            if (_brushCursor != null)
            {
                return;
            }
            const int size = 64;
            _brushCursor = new Texture2D(size, size, TextureFormat.RGBA32, false)
            {
                name = "HC Paint Brush Cursor",
                hideFlags = HideFlags.HideAndDontSave,
            };
            var pixels = new Color32[size * size];
            Vector2 center = Vector2.one * (size - 1) * 0.5f;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float distance = Vector2.Distance(new Vector2(x, y), center);
                    byte alpha = distance > size * 0.43f && distance < size * 0.49f
                        ? (byte)220
                        : (byte)0;
                    pixels[y * size + x] = new Color32(230, 255, 252, alpha);
                }
            }
            _brushCursor.SetPixels32(pixels);
            _brushCursor.Apply(false, true);
        }

        private void LoadSavedSwatches()
        {
            string serialized = PlayerPrefs.GetString(
                "hive.paint.swatches.v1",
                string.Empty
            );
            if (string.IsNullOrWhiteSpace(serialized))
            {
                return;
            }
            string[] values = serialized.Split(',');
            for (
                int index = 0;
                index < Mathf.Min(values.Length, _savedSwatches.Length);
                index++
            )
            {
                if (PaintColorMath.TryParseRgbaHex(values[index], out Color linear))
                {
                    _savedSwatches[index] = linear;
                }
            }
        }

        private void SaveSwatches()
        {
            var values = new string[_savedSwatches.Length];
            for (int index = 0; index < values.Length; index++)
            {
                values[index] = PaintColorMath.ToRgbaHex(_savedSwatches[index]);
            }
            PlayerPrefs.SetString("hive.paint.swatches.v1", string.Join(",", values));
            PlayerPrefs.Save();
        }

        private void EnsureStyles()
        {
            if (_stylesReady)
            {
                return;
            }
            _heading = new GUIStyle(GUI.skin.label)
            {
                fontSize = 18,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.94f, 0.91f, 0.84f) },
            };
            _label = new GUIStyle(GUI.skin.label)
            {
                fontSize = 11,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.92f, 0.69f, 0.30f) },
            };
            _small = new GUIStyle(GUI.skin.label)
            {
                fontSize = 10,
                normal = { textColor = new Color(0.78f, 0.78f, 0.75f) },
                clipping = TextClipping.Clip,
            };
            _buttonNormalTexture = SolidTexture(new Color(0.10f, 0.105f, 0.11f, 1f));
            _buttonHoverTexture = SolidTexture(new Color(0.22f, 0.19f, 0.13f, 1f));
            _buttonActiveTexture = SolidTexture(new Color(0.62f, 0.42f, 0.12f, 1f));
            _fieldTexture = SolidTexture(new Color(0.055f, 0.058f, 0.062f, 1f));
            _button = new GUIStyle(GUI.skin.button)
            {
                fontSize = 10,
                fontStyle = FontStyle.Bold,
                normal = { textColor = Color.white },
                hover = { textColor = Color.white },
                active = { textColor = Color.white },
            };
            _button.normal.background = _buttonNormalTexture;
            _button.hover.background = _buttonHoverTexture;
            _button.active.background = _buttonActiveTexture;
            _field = new GUIStyle(GUI.skin.textField)
            {
                fontSize = 10,
                alignment = TextAnchor.MiddleCenter,
            };
            _field.normal.background = _fieldTexture;
            _tooltip = new GUIStyle(GUI.skin.label)
            {
                fontSize = 10,
                wordWrap = true,
                normal = { textColor = Color.white },
            };
            _stylesReady = true;
        }

        private static Texture2D SolidTexture(Color color)
        {
            var texture = new Texture2D(1, 1, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            texture.SetPixel(0, 0, color);
            texture.Apply(false, true);
            return texture;
        }

        private static void DrawRect(Rect rect, Color color)
        {
            Color previous = GUI.color;
            GUI.color = color;
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = previous;
        }

        private static void DrawSwatch(Rect rect, Color color)
        {
            DrawRect(rect, new Color(0.72f, 0.82f, 0.84f, 0.7f));
            DrawRect(
                new Rect(rect.x + 2f, rect.y + 2f, rect.width - 4f, rect.height - 4f),
                color
            );
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            if (IsActive)
            {
                Exit();
            }
            _disposed = true;
            _materialSampler.Dispose();
            _renderedSampler.Dispose();
            _preview.Dispose();
            if (_colorField != null)
            {
                UnityEngine.Object.Destroy(_colorField);
            }
            if (_valueField != null)
            {
                UnityEngine.Object.Destroy(_valueField);
            }
            if (_brushCursor != null)
            {
                UnityEngine.Object.Destroy(_brushCursor);
            }
            if (_buttonNormalTexture != null)
            {
                UnityEngine.Object.Destroy(_buttonNormalTexture);
            }
            if (_buttonHoverTexture != null)
            {
                UnityEngine.Object.Destroy(_buttonHoverTexture);
            }
            if (_buttonActiveTexture != null)
            {
                UnityEngine.Object.Destroy(_buttonActiveTexture);
            }
            if (_fieldTexture != null)
            {
                UnityEngine.Object.Destroy(_fieldTexture);
            }
        }
    }

    internal sealed class PaintMaterialPreview : IDisposable
    {
        private readonly GameObject _root;
        private readonly Camera _camera;
        private readonly Material _material;
        private readonly RenderTexture _texture;
        private PaintMaterialValues _last;
        private bool _hasLast;

        public Texture Texture => _texture;

        public PaintMaterialPreview()
        {
            _root = new GameObject("HC Paint Material Preview")
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            _root.transform.position = new Vector3(10000f, 10000f, 10000f);
            int previewLayer = PaintableBody.EditColliderLayer;
            GameObject sphere = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            sphere.name = "Material sphere";
            sphere.hideFlags = HideFlags.HideAndDontSave;
            sphere.transform.SetParent(_root.transform, false);
            sphere.layer = previewLayer;
            UnityEngine.Object.Destroy(sphere.GetComponent<Collider>());
            _material = new Material(Shader.Find("Standard"))
            {
                name = "HC Paint Preview Material",
                hideFlags = HideFlags.HideAndDontSave,
            };
            sphere.GetComponent<Renderer>().sharedMaterial = _material;

            GameObject cameraObject = new GameObject("Preview camera")
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            cameraObject.transform.SetParent(_root.transform, false);
            cameraObject.transform.localPosition = new Vector3(0f, 0f, -3f);
            cameraObject.transform.localRotation = Quaternion.identity;
            _camera = cameraObject.AddComponent<Camera>();
            _camera.enabled = false;
            _camera.clearFlags = CameraClearFlags.SolidColor;
            _camera.backgroundColor = new Color(0.035f, 0.045f, 0.055f);
            _camera.fieldOfView = 34f;
            _camera.cullingMask = 1 << previewLayer;

            GameObject keyObject = new GameObject("Neutral key")
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            keyObject.transform.SetParent(_root.transform, false);
            keyObject.layer = previewLayer;
            keyObject.transform.localPosition = new Vector3(-2f, 2f, -2f);
            keyObject.transform.LookAt(_root.transform.position);
            Light key = keyObject.AddComponent<Light>();
            key.type = LightType.Point;
            key.color = Color.white;
            key.intensity = 9f;
            key.range = 6f;

            _texture = new RenderTexture(
                128,
                128,
                16,
                RenderTextureFormat.ARGB32,
                RenderTextureReadWrite.sRGB
            )
            {
                name = "HC Paint Material Preview",
                hideFlags = HideFlags.HideAndDontSave,
            };
            _texture.Create();
            _camera.targetTexture = _texture;
        }

        public void SetMaterial(PaintMaterialValues values)
        {
            PaintMaterialValues safe = values.Clamped();
            if (_hasLast && MaterialsEqual(_last, safe))
            {
                return;
            }
            _last = safe;
            _hasLast = true;
            _material.color = PaintColorMath.LinearToSrgb(safe.BaseColorLinear);
            _material.SetFloat("_Metallic", safe.Metallic);
            _material.SetFloat("_Glossiness", 1f - safe.Roughness);
            Color emission = safe.EmissionColorLinear * safe.EmissionIntensity;
            _material.SetColor("_EmissionColor", emission);
            if (safe.EmissionIntensity > 0.001f)
            {
                _material.EnableKeyword("_EMISSION");
            }
            else
            {
                _material.DisableKeyword("_EMISSION");
            }
            _camera.Render();
        }

        private static bool MaterialsEqual(
            PaintMaterialValues left,
            PaintMaterialValues right
        )
        {
            return left.BaseColorLinear == right.BaseColorLinear
                && Mathf.Approximately(left.Metallic, right.Metallic)
                && Mathf.Approximately(left.Roughness, right.Roughness)
                && left.EmissionColorLinear == right.EmissionColorLinear
                && Mathf.Approximately(left.EmissionIntensity, right.EmissionIntensity);
        }

        public void Dispose()
        {
            if (_camera != null)
            {
                _camera.targetTexture = null;
            }
            _texture.Release();
            UnityEngine.Object.Destroy(_texture);
            UnityEngine.Object.Destroy(_material);
            UnityEngine.Object.Destroy(_root);
        }
    }
}
