package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	neonServiceArcadeMapSlug                  = "neon-service-arcade"
	neonServiceArcadeContentVersion           = "m2"
	neonServiceArcadeAuthorityGeometryVersion = "neon-service-arcade-authority-5"
	neonServiceArcadeAuthorityGeometryDigest  = "sha256:5f7cb5f35e15ba004da1fb37229c75c07d8cc3f81eabe2eed4f8ab42051ad1aa"
)

//go:embed maps/neon-service-arcade-authority.json
var neonServiceArcadeAuthorityPayload []byte

type officialArenaDefinition struct {
	Slug                      string
	DisplayName               string
	Description               string
	ContentVersion            string
	RecommendedMinimumPlayers int
	RecommendedMaximumPlayers int
	HorizontalLimit           float64
	MinimumY                  float64
	MaximumY                  float64
	Geometry                  authorityGeometryManifest
	GeometryDigest            string
	HunterSpawns              [][3]float64
	HiderSpawns               [][3]float64
}

var officialArenaDefinitions = buildOfficialArenaDefinitions()

func buildOfficialArenaDefinitions() map[string]*officialArenaDefinition {
	definitions := []*officialArenaDefinition{
		newEmbeddedArenaDefinition(
			neonServiceArcadeAuthorityPayload,
			"Neon Service Arcade",
			"An indoor arcade, prize cafe, and repair workshop built for close pursuit.",
			2,
			6,
			// Spawns are placed on floor that is clear of the republished
			// authority geometry, with the first hunter and hider forming the
			// deterministic smoke pair that must hold line of sight.
			[][3]float64{
				{-9.00, 0.05, -5.25},
				{-9.00, 0.05, -3.75},
			},
			[][3]float64{
				{-9.00, 0.05, -1.00},
				{8.00, 0.05, 7.00},
				{4.50, 0.05, -6.00},
				{-1.75, 0.05, 5.75},
				{-1.50, 0.05, -1.75},
				{8.00, 0.05, 0.00},
			},
		),
	}

	result := make(map[string]*officialArenaDefinition, len(definitions))
	for _, definition := range definitions {
		if definition == nil ||
			definition.Slug == "" ||
			definition.ContentVersion == "" ||
			definition.Geometry.Version == "" ||
			definition.GeometryDigest == "" ||
			len(definition.HunterSpawns) == 0 ||
			len(definition.HiderSpawns) == 0 {
			panic("official arena definition is incomplete")
		}
		if definition.Slug == neonServiceArcadeMapSlug &&
			(definition.ContentVersion != neonServiceArcadeContentVersion ||
				definition.Geometry.Version != neonServiceArcadeAuthorityGeometryVersion ||
				definition.GeometryDigest != neonServiceArcadeAuthorityGeometryDigest) {
			panic("Neon Service Arcade identity does not match its pinned runtime contract")
		}
		key := officialArenaKey(definition.Slug, definition.ContentVersion)
		if _, duplicate := result[key]; duplicate {
			panic("official arena definition is duplicated")
		}
		result[key] = definition
	}
	return result
}

func newEmbeddedArenaDefinition(
	payload []byte,
	displayName string,
	description string,
	recommendedMinimumPlayers int,
	recommendedMaximumPlayers int,
	hunterSpawns [][3]float64,
	hiderSpawns [][3]float64,
) *officialArenaDefinition {
	var geometry authorityGeometryManifest
	if err := json.Unmarshal(payload, &geometry); err != nil {
		panic(fmt.Sprintf("decode bundled authority geometry: %v", err))
	}
	if geometry.SchemaVersion != 1 ||
		geometry.MapSlug == "" ||
		geometry.ContentVersion == "" ||
		geometry.Version == "" ||
		len(geometry.Buildings)+len(geometry.Trees)+len(geometry.Boundaries) == 0 {
		panic("bundled authority geometry is incomplete")
	}
	return &officialArenaDefinition{
		Slug:                      geometry.MapSlug,
		DisplayName:               displayName,
		Description:               description,
		ContentVersion:            geometry.ContentVersion,
		RecommendedMinimumPlayers: recommendedMinimumPlayers,
		RecommendedMaximumPlayers: recommendedMaximumPlayers,
		HorizontalLimit:           10.5,
		MinimumY:                  -2,
		MaximumY:                  8,
		Geometry:                  geometry,
		GeometryDigest:            computeAuthorityGeometryDigest(geometry),
		HunterSpawns:              hunterSpawns,
		HiderSpawns:               hiderSpawns,
	}
}

func officialArenaKey(slug string, contentVersion string) string {
	return slug + "\x00" + contentVersion
}

func officialArenaForContent(
	slug string,
	contentVersion string,
) (*officialArenaDefinition, bool) {
	definition, ok := officialArenaDefinitions[officialArenaKey(slug, contentVersion)]
	return definition, ok
}

func officialArenaForRound(
	round *roundSnapshot,
) (*officialArenaDefinition, error) {
	if round == nil {
		return nil, errors.New("round map identity is required")
	}
	slug := round.MapSlug
	if slug == "" && round.MapContentVersion == defaultOfficialMapContentVersion {
		slug = defaultOfficialMapSlug
	}
	definition, ok := officialArenaForContent(
		slug,
		round.MapContentVersion,
	)
	if !ok {
		return nil, errors.New("round map is not bundled by this server")
	}
	if round.AuthorityGeometryVersion != "" &&
		round.AuthorityGeometryVersion != definition.Geometry.Version {
		return nil, errors.New("round authority geometry version is incompatible")
	}
	if round.AuthorityGeometryDigest != "" &&
		round.AuthorityGeometryDigest != definition.GeometryDigest {
		return nil, errors.New("round authority geometry digest is incompatible")
	}
	return definition, nil
}

func mustOfficialArenaForRound(
	round *roundSnapshot,
) *officialArenaDefinition {
	definition, err := officialArenaForRound(round)
	if err != nil {
		panic(err)
	}
	return definition
}
