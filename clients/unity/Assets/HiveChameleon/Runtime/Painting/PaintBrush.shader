Shader "Hidden/HiveChameleon/Paint Brush"
{
    Properties
    {
        _MainTex ("Brush", 2D) = "white" {}
        _BrushValue ("Brush Value", Color) = (1, 1, 1, 1)
        _Opacity ("Opacity", Range(0, 1)) = 1
        _Hardness ("Hardness", Range(0, 1)) = 1
        _ColorMask ("Color Mask", Int) = 15
    }

    SubShader
    {
        Tags { "Queue"="Overlay" }
        Cull Off
        Lighting Off
        ZWrite Off
        ZTest Always
        Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha
        ColorMask [_ColorMask]

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float4 vertex : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            sampler2D _MainTex;
            float4 _BrushValue;
            half _Opacity;
            half _Hardness;

            v2f vert(appdata input)
            {
                v2f output;
                output.vertex = UnityObjectToClipPos(input.vertex);
                output.uv = input.uv;
                return output;
            }

            float4 frag(v2f input) : SV_Target
            {
                float distanceFromCenter = length(input.uv - float2(0.5, 0.5)) * 2.0;
                float feather = max(0.001, 1.0 - _Hardness);
                half coverage = 1.0h - smoothstep(
                    1.0h - feather,
                    1.0h,
                    distanceFromCenter
                );
                float4 value = _BrushValue;
                half alpha = saturate(_Opacity * coverage);
                value.a = alpha;
                return value;
            }
            ENDCG
        }
    }
}
