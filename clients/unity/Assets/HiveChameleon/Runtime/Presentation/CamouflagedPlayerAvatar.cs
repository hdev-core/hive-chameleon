using System.Collections.Generic;
using HiveChameleon.Painting;
using HiveChameleon.Realtime;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    [DisallowMultipleComponent]
    public sealed class CamouflagedPlayerAvatar : MonoBehaviour
    {
        private static readonly Color FoundRevealColor = new Color(
            0.08f,
            0.45f,
            1f
        );
        private static readonly Color SurvivedRevealColor = new Color(
            1f,
            0.12f,
            0.18f
        );

        private GameObject _hiderArt;
        private GameObject _hunterArt;
        private HumanoidPresentationRig _hiderRig;
        private HumanoidPresentationRig _hunterRig;
        private CapsuleCollider _hitbox;
        private TextMesh _nameplate;
        private Color _bodyColor;
        private Color _accentColor;
        private Vector3 _networkPosition;
        private Quaternion _networkRotation;
        private bool _networkPoseReady;
        private bool _remote;
        private bool _revealActive;
        private bool _revealFound;
        private bool _nameplateRequested;
        private float _pulseUntil;
        private Vector3 _previousFramePosition;
        private Vector3 _presentationVelocity;
        private int _pose;
        private string _status = "active";
        private string _nameplateStatus = string.Empty;
        private long _lastPaintSequence;

        public string PlayerId { get; private set; } = string.Empty;

        public string DisplayName { get; private set; } = string.Empty;

        public string Role { get; private set; } = "hider";

        public bool IsFound { get; private set; }

        public string Status => _status;

        public int Pose => _pose;

        public Color BodyColor => _bodyColor;

        public Color AccentColor => _accentColor;

        public long LastPaintSequence => _lastPaintSequence;

        public void Configure(
            string playerId,
            string displayName,
            string role,
            Color bodyColor,
            Color accentColor,
            bool remote
        )
        {
            PlayerId = playerId ?? string.Empty;
            _remote = remote;
            SetDisplayName(displayName);

            _hiderArt = HumanoidPlayerFactory.CreateHider(
                "Hider character",
                transform,
                bodyColor,
                accentColor
            );
            _hunterArt = HumanoidPlayerFactory.CreateHunter(
                "Hunter character",
                transform,
                bodyColor,
                accentColor
            );
            HumanoidPlayerFactory.SharePaintAppearance(_hiderArt, _hunterArt);
            _hiderRig = HumanoidPlayerFactory.PresentationRigFor(_hiderArt);
            _hunterRig = HumanoidPlayerFactory.PresentationRigFor(_hunterArt);
            _previousFramePosition = transform.position;

            _hitbox = gameObject.AddComponent<CapsuleCollider>();
            _hitbox.center = new Vector3(0f, 0.95f, 0f);
            _hitbox.height = 1.9f;
            _hitbox.radius = 0.34f;
            _hitbox.isTrigger = true;

            CreateNameplate();
            SetColors(bodyColor, accentColor);
            SetRole(role);
            SetStatus("active");
        }

        public void SetDisplayName(string displayName)
        {
            string resolved = LobbyMenuRules.PlayerDisplayLabel(displayName);
            if (DisplayName == resolved)
            {
                return;
            }

            DisplayName = resolved;
            gameObject.name = $"Player Character // {DisplayName}";
            RefreshNameplate();
        }

        public void SetRole(string role)
        {
            Role = role == "hunter" ? "hunter" : "hider";
            if (_hiderArt != null)
            {
                _hiderArt.SetActive(Role == "hider");
            }
            if (_hunterArt != null)
            {
                _hunterArt.SetActive(Role == "hunter");
            }
            RefreshTargetability();
        }

        public void SetColors(Color bodyColor, Color accentColor)
        {
            if (_bodyColor == bodyColor && _accentColor == accentColor)
            {
                return;
            }
            _bodyColor = bodyColor;
            _accentColor = accentColor;
            ApplyCurrentColors();
        }

        public void SetFound(bool found)
        {
            IsFound = found;
            _status = found ? "found" : "active";
            RefreshTargetability();
        }

        public void SetStatus(string status)
        {
            _status = string.IsNullOrWhiteSpace(status) ? "active" : status;
            IsFound = _status == "found" || _status == "converted";
            RefreshTargetability();
        }

        public void SetTargetable(bool targetable)
        {
            if (_hitbox != null)
            {
                _hitbox.enabled = targetable;
            }
        }

        public void SetReveal(bool active, bool found)
        {
            if (
                _revealActive == active
                && (!active || _revealFound == found)
            )
            {
                return;
            }
            _revealActive = active;
            _revealFound = found;
            ApplyCurrentColors();
            RefreshNameplate();
        }

        public void SetNameplate(bool visible, string status)
        {
            _nameplateRequested = visible;
            _nameplateStatus = status ?? string.Empty;
            RefreshNameplate();
        }

        public void PulseHit(bool found)
        {
            _pulseUntil = Time.unscaledTime + (found ? 0.75f : 0.35f);
            if (found)
            {
                SetFound(true);
            }
        }

        public void SetNetworkPose(Vector3 position, float yaw, bool immediate)
        {
            _networkPosition = position;
            _networkRotation = Quaternion.Euler(0f, yaw, 0f);
            _networkPoseReady = true;
            if (immediate)
            {
                transform.SetPositionAndRotation(_networkPosition, _networkRotation);
            }
        }

        public void SetPose(int pose)
        {
            _pose = Mathf.Clamp(pose, 0, 5);
            ApplyPose(_hiderArt);
            ApplyPose(_hunterArt);
            if (_hitbox != null)
            {
                _hitbox.height = _pose == 3 ? 1.25f : 1.9f;
                _hitbox.center = new Vector3(0f, _hitbox.height * 0.5f, 0f);
            }
        }

        public bool ApplyPaintStroke(PaintStrokeSnapshot stroke)
        {
            if (
                stroke == null
                || stroke.sequence <= _lastPaintSequence
                || stroke.points == null
                || stroke.material == null
            )
            {
                return false;
            }
            PaintMaterialValues material = PaintMaterialFrom(stroke.material);
            var points = new List<Vector2>(stroke.points.Length);
            for (int index = 0; index < stroke.points.Length; index++)
            {
                points.Add(new Vector2(stroke.points[index].u, stroke.points[index].v));
            }
            bool hiderApplied = ApplyPaintStrokeTo(_hiderArt, stroke, points, material);
            if (!hiderApplied)
            {
                return false;
            }
            _lastPaintSequence = stroke.sequence;
            return true;
        }

        private static bool ApplyPaintStrokeTo(
            GameObject art,
            PaintStrokeSnapshot stroke,
            IReadOnlyList<Vector2> points,
            PaintMaterialValues material
        )
        {
            PaintableBody body = HumanoidPlayerFactory.PaintableBodyFor(art);
            return body != null
                && body.BodyId == stroke.body_id
                && body.ApplyStroke(
                    stroke.renderer_id,
                    points,
                    stroke.radius,
                    stroke.hardness,
                    stroke.opacity,
                    material,
                    (PaintChannels)stroke.channels
                );
        }

        private static PaintMaterialValues PaintMaterialFrom(
            PaintMaterialSnapshot snapshot
        )
        {
            return new PaintMaterialValues
            {
                BaseColorLinear = new Color(
                    snapshot.base_r,
                    snapshot.base_g,
                    snapshot.base_b,
                    1f
                ),
                Metallic = snapshot.metallic,
                Roughness = snapshot.roughness,
                EmissionColorLinear = new Color(
                    snapshot.emission_r,
                    snapshot.emission_g,
                    snapshot.emission_b,
                    1f
                ),
                EmissionIntensity = snapshot.emission_intensity,
            }.Clamped();
        }

        private void Update()
        {
            if (_remote && _networkPoseReady)
            {
                transform.position = Vector3.Lerp(
                    transform.position,
                    _networkPosition,
                    Time.deltaTime * 12f
                );
                transform.rotation = Quaternion.Slerp(
                    transform.rotation,
                    _networkRotation,
                    Time.deltaTime * 14f
                );
            }

            float deltaTime = Mathf.Max(Time.deltaTime, 0.0001f);
            Vector3 measuredVelocity =
                (transform.position - _previousFramePosition) / deltaTime;
            _presentationVelocity = Vector3.Lerp(
                _presentationVelocity,
                measuredVelocity,
                1f - Mathf.Exp(-12f * deltaTime)
            );
            _previousFramePosition = transform.position;
            bool crouching = _pose == 3;
            bool aiming = _pose == 4 || Role == "hunter";
            bool painting = _pose == 5;
            _hiderRig?.SetMotion(
                _presentationVelocity,
                9.5f,
                true,
                crouching,
                aiming,
                painting,
                0f
            );
            _hunterRig?.SetMotion(
                _presentationVelocity,
                9.5f,
                true,
                crouching,
                true,
                false,
                0f
            );

            float targetScale =
                Time.unscaledTime < _pulseUntil
                    ? 1f + Mathf.Sin(Time.unscaledTime * 35f) * 0.045f
                    : 1f;
            transform.localScale = Vector3.Lerp(
                transform.localScale,
                Vector3.one * targetScale,
                Time.unscaledDeltaTime * 14f
            );

            if (_revealActive)
            {
                ApplyRevealFrame();
            }
            if (_nameplate != null && _nameplate.gameObject.activeSelf)
            {
                Camera camera = Camera.main;
                if (camera != null)
                {
                    _nameplate.transform.rotation = Quaternion.LookRotation(
                        _nameplate.transform.position - camera.transform.position,
                        Vector3.up
                    );
                }
            }
        }

        private void ApplyCurrentColors()
        {
            Color body = _revealActive
                ? (_revealFound ? FoundRevealColor : SurvivedRevealColor)
                : _bodyColor;
            Color accent = _revealActive
                ? Color.Lerp(body, Color.white, 0.3f)
                : _accentColor;
            HumanoidPlayerFactory.ApplyColors(_hiderArt, body, accent);
            HumanoidPlayerFactory.ApplyColors(_hunterArt, body, accent);
            HumanoidPlayerFactory.SetPresentationOverride(
                _hiderArt,
                body,
                _revealActive ? 1f : 0f
            );
            HumanoidPlayerFactory.SetPresentationOverride(
                _hunterArt,
                body,
                _revealActive ? 1f : 0f
            );
        }

        private void ApplyRevealFrame()
        {
            float frequency = _revealFound ? 7f : 8.5f;
            float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * frequency);
            Color outcome = _revealFound
                ? FoundRevealColor
                : SurvivedRevealColor;
            Color body = Color.Lerp(outcome, Color.white, pulse * 0.42f);
            Color accent = Color.Lerp(
                outcome,
                _revealFound ? Color.cyan : new Color(1f, 0.74f, 0.12f),
                pulse
            );
            HumanoidPlayerFactory.ApplyColors(_hiderArt, body, accent);
            HumanoidPlayerFactory.ApplyColors(_hunterArt, body, accent);
            HumanoidPlayerFactory.SetPresentationOverride(_hiderArt, body, 1f);
            HumanoidPlayerFactory.SetPresentationOverride(_hunterArt, body, 1f);
            if (_nameplate != null)
            {
                _nameplate.color = Color.Lerp(outcome, Color.white, pulse * 0.65f);
            }
        }

        private void CreateNameplate()
        {
            var labelObject = new GameObject("Player nameplate");
            labelObject.transform.SetParent(transform, false);
            labelObject.transform.localPosition = new Vector3(0f, 2.18f, 0f);
            _nameplate = labelObject.AddComponent<TextMesh>();
            _nameplate.anchor = TextAnchor.LowerCenter;
            _nameplate.alignment = TextAlignment.Center;
            _nameplate.characterSize = 0.045f;
            _nameplate.fontSize = 42;
            _nameplate.fontStyle = FontStyle.Bold;
            _nameplate.color = Color.white;
            _nameplate.gameObject.SetActive(false);
        }

        private void RefreshNameplate()
        {
            if (_nameplate == null)
            {
                return;
            }
            bool visible = _nameplateRequested || _revealActive;
            _nameplate.gameObject.SetActive(visible);
            if (!visible)
            {
                return;
            }

            string status = _revealActive
                ? (_revealFound ? "FOUND" : "UNFOUND")
                : _nameplateStatus;
            _nameplate.text = string.IsNullOrWhiteSpace(status)
                ? DisplayName
                : $"{DisplayName}\n{status}";
            _nameplate.color = _revealActive
                ? (_revealFound ? FoundRevealColor : SurvivedRevealColor)
                : Color.white;
        }

        private void RefreshTargetability()
        {
            SetTargetable(Role == "hider" && _status == "active" && !IsFound);
        }

        private void ApplyPose(GameObject art)
        {
            if (art == null)
            {
                return;
            }

            art.transform.localPosition = Vector3.zero;
            art.transform.localRotation = Quaternion.identity;
            art.transform.localScale = Vector3.one;
        }
    }
}
