using System;
using HiveChameleon.Realtime;
using UnityEngine;

namespace HiveChameleon.Presentation
{
    public sealed class AuthoritativeArenaDefinition
    {
        public AuthoritativeArenaDefinition(
            string slug,
            string displayName,
            string description,
            string contentVersion,
            string authorityGeometryVersion,
            string authorityGeometryDigest,
            string resourcePath
        )
        {
            Slug = slug;
            DisplayName = displayName;
            Description = description;
            ContentVersion = contentVersion;
            AuthorityGeometryVersion = authorityGeometryVersion;
            AuthorityGeometryDigest = authorityGeometryDigest;
            ResourcePath = resourcePath;
        }

        public string Slug { get; }

        public string DisplayName { get; }

        public string Description { get; }

        public string ContentVersion { get; }

        public string AuthorityGeometryVersion { get; }

        public string AuthorityGeometryDigest { get; }

        public string ResourcePath { get; }

        public bool Matches(RoundSnapshot round)
        {
            return round != null
                && string.Equals(round.map_slug, Slug, StringComparison.Ordinal)
                && string.Equals(
                    round.map_content_version,
                    ContentVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.authority_geometry_version,
                    AuthorityGeometryVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    round.authority_geometry_digest,
                    AuthorityGeometryDigest,
                    StringComparison.Ordinal
                );
        }

        public bool Matches(AvailableMapSnapshot available)
        {
            return available != null
                && string.Equals(available.map_slug, Slug, StringComparison.Ordinal)
                && string.Equals(
                    available.content_version,
                    ContentVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    available.authority_geometry_version,
                    AuthorityGeometryVersion,
                    StringComparison.Ordinal
                )
                && string.Equals(
                    available.authority_geometry_digest,
                    AuthorityGeometryDigest,
                    StringComparison.Ordinal
                );
        }

        public IAuthoritativeArenaMap Instantiate(out GameObject arenaObject)
        {
            if (string.IsNullOrWhiteSpace(ResourcePath))
            {
                throw new InvalidOperationException(
                    $"{DisplayName} does not declare a bundled arena resource."
                );
            }

            GameObject prefab = Resources.Load<GameObject>(ResourcePath);
            if (prefab == null)
            {
                throw new MissingReferenceException(
                    $"Required arena prefab is missing at Resources/{ResourcePath}."
                );
            }
            arenaObject = UnityEngine.Object.Instantiate(prefab);
            arenaObject.name = $"{DisplayName} // Official Arena";
            IAuthoritativeArenaMap arena =
                arenaObject.GetComponent<IAuthoritativeArenaMap>();
            if (arena == null)
            {
                UnityEngine.Object.Destroy(arenaObject);
                throw new MissingComponentException(
                    $"{DisplayName} does not implement {nameof(IAuthoritativeArenaMap)}."
                );
            }
            return arena;
        }
    }

    public static class AuthoritativeArenaCatalog
    {
        public const string NeonServiceArcadeSlug = "neon-service-arcade";
        public const string NeonServiceArcadeDisplayName = "Neon Service Arcade";
        public const string NeonServiceArcadeContentVersion = "m2";
        public const string NeonServiceArcadeAuthorityGeometryVersion =
            "neon-service-arcade-authority-5";
        public const string NeonServiceArcadeAuthorityGeometryDigest =
            "sha256:5f7cb5f35e15ba004da1fb37229c75c07d8cc3f81eabe2eed4f8ab42051ad1aa";

        public static readonly AuthoritativeArenaDefinition[] All =
        {
            new AuthoritativeArenaDefinition(
                NeonServiceArcadeSlug,
                NeonServiceArcadeDisplayName,
                "An indoor arcade, prize cafe, and repair workshop built for close pursuit.",
                NeonServiceArcadeContentVersion,
                NeonServiceArcadeAuthorityGeometryVersion,
                NeonServiceArcadeAuthorityGeometryDigest,
                "Maps/NeonServiceArcade/HC_NeonServiceArcade"
            ),
        };

        public static bool TryResolve(
            RoundSnapshot round,
            out AuthoritativeArenaDefinition definition
        )
        {
            for (int index = 0; index < All.Length; index++)
            {
                if (All[index].Matches(round))
                {
                    definition = All[index];
                    return true;
                }
            }
            definition = null;
            return false;
        }

        public static bool Supports(AvailableMapSnapshot available)
        {
            for (int index = 0; index < All.Length; index++)
            {
                if (All[index].Matches(available))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
