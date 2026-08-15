using System.Collections;
using HiveChameleon.Presentation;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class HumanoidGaitTests
    {
        /// <summary>
        /// A walking pelvis oscillates around its bind height: it rises as the legs pass
        /// each other and falls as they split apart. A bob built from Abs(Sin(gait)) is
        /// never negative, so the body only ever pops upward, which reads as hopping
        /// rather than walking.
        /// </summary>
        [UnityTest]
        public IEnumerator WalkingPelvisOscillatesAroundBindHeightInsteadOfOnlyRising()
        {
            var parent = new GameObject("Gait test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Gait Hider",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            HumanoidPresentationRig rig =
                hider.GetComponent<HumanoidPresentationRig>();
            Transform hips = rig.Bone(HumanBodyBones.Hips);
            Assert.That(hips, Is.Not.Null, "the bundled humanoid must expose its hips");
            float bindHeight = hips.localPosition.y;

            // Walk at full speed for long enough to cover several stride cycles, and
            // settle first so the smoothed pose is no longer chasing the bind pose.
            rig.SetMotion(Vector3.forward * 9.5f, 9.5f, true, false, false, false, 0f);
            for (int warmup = 0; warmup < 120; warmup++)
            {
                rig.EvaluateImmediately();
            }

            float lowest = float.MaxValue;
            float highest = float.MinValue;
            for (int step = 0; step < 240; step++)
            {
                rig.EvaluateImmediately();
                float height = hips.localPosition.y;
                lowest = Mathf.Min(lowest, height);
                highest = Mathf.Max(highest, height);
            }

            Assert.That(
                highest,
                Is.GreaterThan(bindHeight),
                "the pelvis must rise above its bind height while walking"
            );
            Assert.That(
                lowest,
                Is.LessThan(bindHeight),
                "the pelvis must also fall below its bind height; a one-directional "
                    + "bob reads as a hop rather than a walk"
            );

            // The travel is a gait bob, not a jump: a few centimetres, roughly centred.
            float travel = highest - lowest;
            Assert.That(travel, Is.LessThan(0.12f), "pelvis travel must stay subtle");
            float centre = (highest + lowest) * 0.5f;
            Assert.That(
                Mathf.Abs(centre - bindHeight),
                Is.LessThan(travel * 0.5f),
                "pelvis travel must straddle the bind height rather than sit above it"
            );

            Object.Destroy(parent);
            yield return null;
        }

        /// <summary>Standing still must not drive any pelvis motion.</summary>
        [UnityTest]
        public IEnumerator StandingStillLeavesThePelvisAtBindHeight()
        {
            var parent = new GameObject("Idle test root");
            GameObject hider = HumanoidPlayerFactory.CreateHider(
                "Idle Hider",
                parent.transform,
                Color.white,
                Color.cyan
            );
            yield return null;

            HumanoidPresentationRig rig =
                hider.GetComponent<HumanoidPresentationRig>();
            Transform hips = rig.Bone(HumanBodyBones.Hips);
            float bindHeight = hips.localPosition.y;

            rig.SetMotion(Vector3.zero, 9.5f, true, false, false, false, 0f);
            for (int step = 0; step < 180; step++)
            {
                rig.EvaluateImmediately();
            }

            Assert.That(
                Mathf.Abs(hips.localPosition.y - bindHeight),
                Is.LessThan(0.001f),
                "an idle humanoid must not bob"
            );

            Object.Destroy(parent);
            yield return null;
        }
    }
}
