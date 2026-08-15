using System;
using System.Collections.Generic;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    /// <summary>
    /// Presentation adapter between gameplay and a humanoid asset. A replacement model can
    /// either provide a Humanoid Animator or serialize explicit semantic bone overrides; the
    /// gameplay code never depends on the imported hierarchy.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HumanoidPresentationRig : MonoBehaviour
    {
        private const float MotionResponse = 13f;

        /// <summary>Peak vertical pelvis travel either side of the bind pose, in metres.</summary>
        private const float HipBobAmplitude = 0.022f;

        [Serializable]
        private sealed class BoneOverride
        {
            public HumanBodyBones semanticBone = HumanBodyBones.LastBone;
            public Transform transform;
        }

        [SerializeField]
        private BoneOverride[] boneOverrides = Array.Empty<BoneOverride>();

        [SerializeField]
        private Transform equippedWeapon;

        [Header("Animator contract (used by replacement animated models)")]
        [SerializeField]
        private string speedParameter = "MoveSpeed";

        [SerializeField]
        private string groundedParameter = "Grounded";

        [SerializeField]
        private string crouchingParameter = "Crouching";

        [SerializeField]
        private string aimingParameter = "Aiming";

        [SerializeField]
        private string paintingParameter = "Painting";

        [SerializeField]
        private string aimPitchParameter = "AimPitch";

        private readonly Dictionary<HumanBodyBones, Transform> _bones =
            new Dictionary<HumanBodyBones, Transform>();
        private readonly Dictionary<Transform, Quaternion> _bindRotations =
            new Dictionary<Transform, Quaternion>();

        private Animator _animator;
        private Transform _hips;
        private Vector3 _hipsBindPosition;
        private Vector3 _velocity;
        private float _normalizedSpeed;
        private float _aimPitch;
        private float _gait;
        private bool _grounded = true;
        private bool _crouching;
        private bool _aiming;
        private bool _painting;
        private bool _armed;
        private bool _initialized;

        public Transform EquippedWeapon => equippedWeapon;

        public bool UsesAnimatorController =>
            _animator != null && _animator.runtimeAnimatorController != null;

        public Transform Bone(HumanBodyBones semantic)
        {
            Initialize();
            return GetBone(semantic);
        }

        public void EvaluateImmediately(float deltaTime = 1f / 60f)
        {
            Initialize();
            if (!UsesAnimatorController)
            {
                ApplyProceduralMotion(Mathf.Max(0.0001f, deltaTime));
            }
        }

        public static HumanoidPresentationRig Bind(GameObject avatar)
        {
            if (avatar == null)
            {
                throw new ArgumentNullException(nameof(avatar));
            }

            HumanoidPresentationRig rig =
                avatar.GetComponent<HumanoidPresentationRig>()
                ?? avatar.AddComponent<HumanoidPresentationRig>();
            rig.Initialize();
            return rig;
        }

        public void SetMotion(
            Vector3 worldVelocity,
            float maximumSpeed,
            bool grounded,
            bool crouching,
            bool aiming,
            bool painting,
            float aimPitch
        )
        {
            Initialize();
            _velocity = worldVelocity;
            _normalizedSpeed = Mathf.Clamp01(
                new Vector2(worldVelocity.x, worldVelocity.z).magnitude
                    / Mathf.Max(0.01f, maximumSpeed)
            );
            _grounded = grounded;
            _crouching = crouching;
            _aiming = aiming;
            _painting = painting;
            _aimPitch = Mathf.Clamp(aimPitch, -58f, 62f);
        }

        public void SetEquippedWeapon(Transform weapon)
        {
            equippedWeapon = weapon;
            _armed = equippedWeapon != null;
            AttachEquippedWeaponToHand();
        }

        private void Awake()
        {
            Initialize();
        }

        private void Initialize()
        {
            if (_initialized)
            {
                return;
            }

            _initialized = true;
            _animator = GetComponentInChildren<Animator>(true);
            MapBones();
            _hips = GetBone(HumanBodyBones.Hips);
            if (_hips != null)
            {
                _hipsBindPosition = _hips.localPosition;
            }

            if (equippedWeapon == null)
            {
                Transform[] transforms = GetComponentsInChildren<Transform>(true);
                for (int index = 0; index < transforms.Length; index++)
                {
                    if (
                        transforms[index].name.IndexOf(
                            "rifle",
                            StringComparison.OrdinalIgnoreCase
                        ) >= 0
                    )
                    {
                        equippedWeapon = transforms[index];
                        break;
                    }
                }
            }
            _armed = equippedWeapon != null;
            AttachEquippedWeaponToHand();
        }

        private void AttachEquippedWeaponToHand()
        {
            Transform hand = GetBone(HumanBodyBones.RightHand);
            if (
                equippedWeapon == null
                || hand == null
                || equippedWeapon == hand
                || equippedWeapon.IsChildOf(hand)
            )
            {
                return;
            }
            equippedWeapon.SetParent(hand, true);
        }

        private void MapBones()
        {
            _bones.Clear();
            if (_animator != null && _animator.isHuman)
            {
                MapAnimatorBone(HumanBodyBones.Hips);
                MapAnimatorBone(HumanBodyBones.Spine);
                MapAnimatorBone(HumanBodyBones.Chest);
                MapAnimatorBone(HumanBodyBones.Head);
                MapAnimatorBone(HumanBodyBones.LeftUpperArm);
                MapAnimatorBone(HumanBodyBones.LeftLowerArm);
                MapAnimatorBone(HumanBodyBones.LeftHand);
                MapAnimatorBone(HumanBodyBones.RightUpperArm);
                MapAnimatorBone(HumanBodyBones.RightLowerArm);
                MapAnimatorBone(HumanBodyBones.RightHand);
                MapAnimatorBone(HumanBodyBones.LeftUpperLeg);
                MapAnimatorBone(HumanBodyBones.LeftLowerLeg);
                MapAnimatorBone(HumanBodyBones.LeftFoot);
                MapAnimatorBone(HumanBodyBones.RightUpperLeg);
                MapAnimatorBone(HumanBodyBones.RightLowerLeg);
                MapAnimatorBone(HumanBodyBones.RightFoot);
            }

            for (int index = 0; index < boneOverrides.Length; index++)
            {
                BoneOverride value = boneOverrides[index];
                if (
                    value != null
                    && value.semanticBone != HumanBodyBones.LastBone
                    && value.transform != null
                )
                {
                    _bones[value.semanticBone] = value.transform;
                }
            }

            // The bundled prototype model uses a Generic rig. Resolve it through the bones
            // actually referenced by its SkinnedMeshRenderers, avoiding similarly named mesh
            // objects. A replacement asset can bypass this fallback with the fields above.
            var skinnedBones = new Dictionary<string, Transform>(StringComparer.Ordinal);
            SkinnedMeshRenderer[] renderers =
                GetComponentsInChildren<SkinnedMeshRenderer>(true);
            for (int rendererIndex = 0; rendererIndex < renderers.Length; rendererIndex++)
            {
                Transform[] bones = renderers[rendererIndex].bones;
                for (int boneIndex = 0; boneIndex < bones.Length; boneIndex++)
                {
                    Transform bone = bones[boneIndex];
                    if (bone != null && !skinnedBones.ContainsKey(bone.name))
                    {
                        skinnedBones.Add(bone.name, bone);
                    }
                }
            }

            MapNamedBone(skinnedBones, HumanBodyBones.Hips, "Hips");
            MapNamedBone(skinnedBones, HumanBodyBones.Spine, "Spine");
            MapNamedBone(skinnedBones, HumanBodyBones.Chest, "Chest");
            MapNamedBone(skinnedBones, HumanBodyBones.Head, "Head");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftUpperArm, "LeftUpperArm");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftLowerArm, "LeftLowerArm");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftHand, "LeftHand");
            MapNamedBone(skinnedBones, HumanBodyBones.RightUpperArm, "RightUpperArm");
            MapNamedBone(skinnedBones, HumanBodyBones.RightLowerArm, "RightLowerArm");
            MapNamedBone(skinnedBones, HumanBodyBones.RightHand, "RightHand");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftUpperLeg, "LeftUpperLeg");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftLowerLeg, "LeftLowerLeg");
            MapNamedBone(skinnedBones, HumanBodyBones.LeftFoot, "LeftFoot");
            MapNamedBone(skinnedBones, HumanBodyBones.RightUpperLeg, "RightUpperLeg");
            MapNamedBone(skinnedBones, HumanBodyBones.RightLowerLeg, "RightLowerLeg");
            MapNamedBone(skinnedBones, HumanBodyBones.RightFoot, "RightFoot");

            _bindRotations.Clear();
            foreach (Transform bone in _bones.Values)
            {
                if (bone != null && !_bindRotations.ContainsKey(bone))
                {
                    _bindRotations.Add(bone, bone.localRotation);
                }
            }
        }

        private void MapAnimatorBone(HumanBodyBones semantic)
        {
            Transform bone = _animator.GetBoneTransform(semantic);
            if (bone != null)
            {
                _bones[semantic] = bone;
            }
        }

        private void MapNamedBone(
            Dictionary<string, Transform> candidates,
            HumanBodyBones semantic,
            string name
        )
        {
            if (!_bones.ContainsKey(semantic) && candidates.TryGetValue(name, out Transform bone))
            {
                _bones.Add(semantic, bone);
            }
        }

        private Transform GetBone(HumanBodyBones semantic)
        {
            _bones.TryGetValue(semantic, out Transform bone);
            return bone;
        }

        private void LateUpdate()
        {
            Initialize();
            if (UsesAnimatorController)
            {
                ApplyAnimatorParameters();
                return;
            }

            ApplyProceduralMotion(Time.deltaTime);
        }

        private void ApplyAnimatorParameters()
        {
            SetAnimatorFloat(speedParameter, _normalizedSpeed);
            SetAnimatorFloat(aimPitchParameter, _aimPitch / 62f);
            SetAnimatorBool(groundedParameter, _grounded);
            SetAnimatorBool(crouchingParameter, _crouching);
            SetAnimatorBool(aimingParameter, _aiming || _armed);
            SetAnimatorBool(paintingParameter, _painting);
        }

        private void SetAnimatorFloat(string parameter, float value)
        {
            if (HasAnimatorParameter(parameter, AnimatorControllerParameterType.Float))
            {
                _animator.SetFloat(parameter, value, 0.08f, Time.deltaTime);
            }
        }

        private void SetAnimatorBool(string parameter, bool value)
        {
            if (HasAnimatorParameter(parameter, AnimatorControllerParameterType.Bool))
            {
                _animator.SetBool(parameter, value);
            }
        }

        private bool HasAnimatorParameter(
            string parameter,
            AnimatorControllerParameterType expectedType
        )
        {
            if (string.IsNullOrWhiteSpace(parameter))
            {
                return false;
            }
            int hash = Animator.StringToHash(parameter);
            AnimatorControllerParameter[] parameters = _animator.parameters;
            for (int index = 0; index < parameters.Length; index++)
            {
                if (parameters[index].nameHash == hash && parameters[index].type == expectedType)
                {
                    return true;
                }
            }
            return false;
        }

        private void ApplyProceduralMotion(float deltaTime)
        {
            float response = 1f - Mathf.Exp(-MotionResponse * deltaTime);
            float gaitStrength = _grounded ? _normalizedSpeed : 0f;
            _gait += deltaTime * Mathf.Lerp(2.8f, 9.2f, gaitStrength);
            float stride = Mathf.Sin(_gait) * 30f * gaitStrength;
            float knee = Mathf.Max(0f, Mathf.Sin(_gait)) * 24f * gaitStrength;
            float oppositeKnee = Mathf.Max(0f, -Mathf.Sin(_gait)) * 24f * gaitStrength;
            float crouch = _crouching ? 1f : 0f;

            RotateBone(HumanBodyBones.LeftUpperLeg, new Vector3(stride - 20f * crouch, 0f, 0f), response);
            RotateBone(HumanBodyBones.RightUpperLeg, new Vector3(-stride - 20f * crouch, 0f, 0f), response);
            RotateBone(HumanBodyBones.LeftLowerLeg, new Vector3(knee + 28f * crouch, 0f, 0f), response);
            RotateBone(HumanBodyBones.RightLowerLeg, new Vector3(oppositeKnee + 28f * crouch, 0f, 0f), response);
            RotateBone(HumanBodyBones.LeftFoot, new Vector3(-knee * 0.35f, 0f, 0f), response);
            RotateBone(HumanBodyBones.RightFoot, new Vector3(-oppositeKnee * 0.35f, 0f, 0f), response);

            bool holdWeapon = _armed || _aiming;
            if (holdWeapon)
            {
                float pitch = _aimPitch * 0.35f;
                RotateBone(HumanBodyBones.RightUpperArm, new Vector3(-62f + pitch, 5f, -16f), response);
                RotateBone(HumanBodyBones.RightLowerArm, new Vector3(-34f, 2f, 4f), response);
                RotateBone(HumanBodyBones.LeftUpperArm, new Vector3(-48f + pitch, -8f, 24f), response);
                RotateBone(HumanBodyBones.LeftLowerArm, new Vector3(-58f, -4f, -10f), response);
            }
            else if (_painting)
            {
                RotateBone(HumanBodyBones.RightUpperArm, new Vector3(-34f, 0f, -12f), response);
                RotateBone(HumanBodyBones.RightLowerArm, new Vector3(-42f, 0f, 0f), response);
                RotateBone(HumanBodyBones.LeftUpperArm, new Vector3(8f, 0f, 6f), response);
                RotateBone(HumanBodyBones.LeftLowerArm, Vector3.zero, response);
            }
            else
            {
                float armSwing = -stride * 0.72f;
                RotateBone(HumanBodyBones.LeftUpperArm, new Vector3(armSwing, 0f, 4f), response);
                RotateBone(HumanBodyBones.RightUpperArm, new Vector3(-armSwing, 0f, -4f), response);
                RotateBone(HumanBodyBones.LeftLowerArm, new Vector3(-8f, 0f, 0f), response);
                RotateBone(HumanBodyBones.RightLowerArm, new Vector3(-8f, 0f, 0f), response);
            }

            RotateBone(
                HumanBodyBones.Spine,
                new Vector3(_crouching ? 12f : 0f, 0f, -stride * 0.025f),
                response
            );
            if (_hips != null)
            {
                // The pelvis peaks at midstance, when the legs pass each other, and
                // troughs at double support, when they are furthest apart: twice per
                // stride, centred on the bind pose. Abs(Sin(gait)) inverts that phase
                // and never falls below bind height, so the body repeatedly pops
                // upward and the walk reads as a hop.
                float bob = Mathf.Cos(2f * _gait) * HipBobAmplitude * gaitStrength;
                Vector3 target = _hipsBindPosition + new Vector3(0f, -0.18f * crouch + bob, 0f);
                _hips.localPosition = Vector3.Lerp(_hips.localPosition, target, response);
            }
        }

        private void RotateBone(HumanBodyBones semantic, Vector3 euler, float response)
        {
            Transform bone = GetBone(semantic);
            if (bone == null || !_bindRotations.TryGetValue(bone, out Quaternion bind))
            {
                return;
            }
            Quaternion target = bind * Quaternion.Euler(euler);
            bone.localRotation = Quaternion.Slerp(bone.localRotation, target, response);
        }
    }
}
