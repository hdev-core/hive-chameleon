using System;
using UnityEngine;

namespace HiveChameleon.Painting
{
    [Flags]
    public enum PaintChannels
    {
        None = 0,
        BaseColor = 1 << 0,
        Metallic = 1 << 1,
        Roughness = 1 << 2,
        Emission = 1 << 3,
        All = BaseColor | Metallic | Roughness | Emission,
    }

    public enum PaintInteractionState
    {
        Gameplay,
        PaintIdle,
        PaintingStroke,
        CameraOrbit,
        BrushResizing,
        MaterialSamplerArmed,
        RenderedSamplerArmed,
        PaletteInteraction,
        XRayPaintView,
    }

    public enum RenderedSampleRegion
    {
        OneByOne = 1,
        ThreeByThree = 3,
        FiveByFive = 5,
    }

    [Serializable]
    public struct PaintMaterialValues
    {
        public Color BaseColorLinear;
        public float Metallic;
        public float Roughness;
        public Color EmissionColorLinear;
        public float EmissionIntensity;

        public static PaintMaterialValues NeutralWhite =>
            new PaintMaterialValues
            {
                BaseColorLinear = Color.white,
                Metallic = 0f,
                Roughness = 0.82f,
                EmissionColorLinear = Color.black,
                EmissionIntensity = 0f,
            };

        public PaintMaterialValues Clamped()
        {
            PaintMaterialValues value = this;
            value.BaseColorLinear = PaintColorMath.ClampLinear(BaseColorLinear);
            value.Metallic = Mathf.Clamp01(Metallic);
            value.Roughness = Mathf.Clamp01(Roughness);
            value.EmissionColorLinear = PaintColorMath.ClampLinear(
                EmissionColorLinear
            );
            value.EmissionIntensity = Mathf.Clamp(EmissionIntensity, 0f, 8f);
            return value;
        }

        public static PaintMaterialValues Blend(
            PaintMaterialValues oldValue,
            PaintMaterialValues brush,
            float opacity,
            PaintChannels channels
        )
        {
            float alpha = Mathf.Clamp01(opacity);
            PaintMaterialValues result = oldValue;
            if ((channels & PaintChannels.BaseColor) != 0)
            {
                result.BaseColorLinear = PaintColorMath.SourceOver(
                    oldValue.BaseColorLinear,
                    brush.BaseColorLinear,
                    alpha
                );
            }
            if ((channels & PaintChannels.Metallic) != 0)
            {
                result.Metallic = Mathf.Lerp(oldValue.Metallic, brush.Metallic, alpha);
            }
            if ((channels & PaintChannels.Roughness) != 0)
            {
                result.Roughness = Mathf.Lerp(oldValue.Roughness, brush.Roughness, alpha);
            }
            if ((channels & PaintChannels.Emission) != 0)
            {
                result.EmissionColorLinear = PaintColorMath.SourceOver(
                    oldValue.EmissionColorLinear,
                    brush.EmissionColorLinear,
                    alpha
                );
                result.EmissionIntensity = Mathf.Lerp(
                    oldValue.EmissionIntensity,
                    brush.EmissionIntensity,
                    alpha
                );
            }
            return result.Clamped();
        }
    }

    public static class PaintColorMath
    {
        public static Color SourceOver(Color oldLinear, Color brushLinear, float opacity)
        {
            float alpha = Mathf.Clamp01(opacity);
            return new Color(
                brushLinear.r * alpha + oldLinear.r * (1f - alpha),
                brushLinear.g * alpha + oldLinear.g * (1f - alpha),
                brushLinear.b * alpha + oldLinear.b * (1f - alpha),
                brushLinear.a * alpha + oldLinear.a * (1f - alpha)
            );
        }

        public static Color SrgbToLinear(Color srgb)
        {
            Color linear = srgb.linear;
            linear.a = srgb.a;
            return linear;
        }

        public static Color LinearToSrgb(Color linear)
        {
            Color srgb = linear.gamma;
            srgb.a = linear.a;
            return srgb;
        }

        public static bool TryParseRgbaHex(string text, out Color linear)
        {
            linear = Color.white;
            if (string.IsNullOrWhiteSpace(text))
            {
                return false;
            }
            string normalized = text.Trim().TrimStart('#');
            if (normalized.Length == 6)
            {
                normalized += "FF";
            }
            if (
                normalized.Length != 8
                || !ColorUtility.TryParseHtmlString(
                    "#" + normalized,
                    out Color srgb
                )
            )
            {
                return false;
            }
            linear = SrgbToLinear(srgb);
            return true;
        }

        public static string ToRgbaHex(Color linear)
        {
            return ColorUtility.ToHtmlStringRGBA(LinearToSrgb(ClampLinear(linear)));
        }

        public static Color ClampLinear(Color value)
        {
            return new Color(
                Mathf.Clamp01(value.r),
                Mathf.Clamp01(value.g),
                Mathf.Clamp01(value.b),
                Mathf.Clamp01(value.a)
            );
        }
    }
}
