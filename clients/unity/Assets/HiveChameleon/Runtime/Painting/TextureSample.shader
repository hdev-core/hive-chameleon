Shader "Hidden/HiveChameleon/Texture Sample"
{
    SubShader
    {
        Cull Off
        ZWrite Off
        ZTest Always

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

            sampler2D _SourceTex;
            float4 _SourceTex_TexelSize;
            float4 _SampleUV;
            int _RegionSize;

            v2f vert(appdata input)
            {
                v2f output;
                output.vertex = UnityObjectToClipPos(input.vertex);
                output.uv = input.uv;
                return output;
            }

            fixed4 frag(v2f input) : SV_Target
            {
                // RegionSize is restricted to 1, 3, or 5. Branching avoids the
                // GLES3 integer-division path that Unity warns about during WebGL builds.
                int radius = _RegionSize == 5 ? 2 : (_RegionSize == 3 ? 1 : 0);
                fixed4 sum = 0;
                int count = 0;
                [unroll]
                for (int y = -2; y <= 2; y++)
                {
                    [unroll]
                    for (int x = -2; x <= 2; x++)
                    {
                        if (abs(x) <= radius && abs(y) <= radius)
                        {
                            float2 uv = _SampleUV.xy
                                + float2(x, y) * _SourceTex_TexelSize.xy;
                            sum += tex2D(_SourceTex, uv);
                            count++;
                        }
                    }
                }
                return sum / max(1, count);
            }
            ENDCG
        }
    }
}
