Shader "HiveChameleon/Painted Body"
{
    Properties
    {
        _MainTex ("Base Color + Painted Mask", 2D) = "white" {}
        _MaterialMap ("Metallic (R) Roughness (G)", 2D) = "black" {}
        _EmissionMap ("Emission", 2D) = "black" {}
        _OverrideColor ("Presentation Override", Color) = (1, 1, 1, 1)
        _OverrideAmount ("Presentation Override Amount", Range(0, 1)) = 0
        [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("Depth Test", Float) = 4
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        LOD 250
        ZTest [_ZTest]

        CGPROGRAM
        #pragma surface surf Standard fullforwardshadows
        #pragma target 3.0

        sampler2D _MainTex;
        sampler2D _MaterialMap;
        sampler2D _EmissionMap;
        fixed4 _OverrideColor;
        half _OverrideAmount;

        struct Input
        {
            float2 uv_MainTex;
        };

        void surf(Input IN, inout SurfaceOutputStandard output)
        {
            fixed4 baseSample = tex2D(_MainTex, IN.uv_MainTex);
            fixed4 materialSample = tex2D(_MaterialMap, IN.uv_MainTex);
            fixed4 emissionSample = tex2D(_EmissionMap, IN.uv_MainTex);
            output.Albedo = lerp(baseSample.rgb, _OverrideColor.rgb, _OverrideAmount);
            output.Metallic = saturate(materialSample.r);
            output.Smoothness = 1.0h - saturate(materialSample.g);
            output.Emission = emissionSample.rgb;
            output.Alpha = 1.0h;
        }
        ENDCG
    }

    FallBack "Diffuse"
}
