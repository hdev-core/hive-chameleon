package main

import (
	"math"
	"strings"
	"testing"
)

func defaultOfficialArenaTestDefinition() *officialArenaDefinition {
	definition, ok := officialArenaForContent(
		defaultOfficialMapSlug,
		defaultOfficialMapContentVersion,
	)
	if !ok {
		panic("default official arena test definition is unavailable")
	}
	return definition
}

func TestBundledArenaCatalogIsAuthoritativeAndSpawnSafe(t *testing.T) {
	t.Parallel()

	if len(officialArenaDefinitions) != 1 {
		t.Fatalf("official arena count = %d, want 1", len(officialArenaDefinitions))
	}
	for key, arena := range officialArenaDefinitions {
		if arena == nil ||
			key != officialArenaKey(arena.Slug, arena.ContentVersion) ||
			arena.Geometry.MapSlug != arena.Slug ||
			arena.Geometry.ContentVersion != arena.ContentVersion ||
			arena.GeometryDigest != computeAuthorityGeometryDigest(arena.Geometry) ||
			!strings.HasPrefix(arena.GeometryDigest, "sha256:") {
			t.Fatalf("invalid official arena definition %q: %#v", key, arena)
		}
		for role, spawns := range map[string][][3]float64{
			"hunter": arena.HunterSpawns,
			"hider":  arena.HiderSpawns,
		} {
			for index, spawn := range spawns {
				position := authorityVector{
					X: spawn[0],
					Y: spawn[1],
					Z: spawn[2],
				}
				if !validAvatarPositionForArena(
					spawn[0],
					spawn[1],
					spawn[2],
					arena,
				) {
					t.Fatalf(
						"%s %s spawn %d is outside arena bounds: %#v",
						arena.Slug,
						role,
						index,
						spawn,
					)
				}
				if authorityCapsuleIntersectsStatic(
					authorityPlayerCapsule(
						position,
						authorityPlayerStandingHeight,
					),
					&arena.Geometry,
				) {
					t.Fatalf(
						"%s %s spawn %d intersects authority geometry: %#v",
						arena.Slug,
						role,
						index,
						spawn,
					)
				}

				clearanceCapsule := authorityPlayerCapsule(
					position,
					authorityPlayerStandingHeight,
				)
				clearanceCapsule.Radius += authorityPlayerSkinWidth + 0.10
				if authorityCapsuleIntersectsStatic(
					clearanceCapsule,
					&arena.Geometry,
				) {
					t.Fatalf(
						"%s %s spawn %d lacks collider safety clearance: %#v",
						arena.Slug,
						role,
						index,
						spawn,
					)
				}

				const directionCount = 16
				clearDirections := 0
				for directionIndex := 0; directionIndex < directionCount; directionIndex++ {
					angle := float64(directionIndex) * 2 * math.Pi / directionCount
					endpoint := position.add(authorityVector{
						X: 1.25 * math.Cos(angle),
						Z: 1.25 * math.Sin(angle),
					})
					if !authorityMovementIntersectsStatic(
						position,
						endpoint,
						authorityPlayerStandingHeight,
						&arena.Geometry,
					) {
						clearDirections++
					}
				}
				if clearDirections < 4 {
					t.Fatalf(
						"%s %s spawn %d has only %d/%d clear escape directions: %#v",
						arena.Slug,
						role,
						index,
						clearDirections,
						directionCount,
						spawn,
					)
				}
			}
		}
		t.Logf("%s %s", arena.Slug, arena.GeometryDigest)
	}
}

func TestNeonServiceArcadeSmokePairHasAuthoritativeLineOfSight(t *testing.T) {
	t.Parallel()

	arena := defaultOfficialArenaTestDefinition()
	hunterSpawn := arena.HunterSpawns[0]
	hiderSpawn := arena.HiderSpawns[0]
	horizontalX := hiderSpawn[0] - hunterSpawn[0]
	horizontalZ := hiderSpawn[2] - hunterSpawn[2]
	horizontalDistance := math.Hypot(horizontalX, horizontalZ)
	hunter := roundAvatarStateSnapshot{
		PositionX: hunterSpawn[0],
		PositionY: hunterSpawn[1],
		PositionZ: hunterSpawn[2],
		Yaw:       math.Atan2(horizontalX, horizontalZ) * 180 / math.Pi,
		Pitch: -math.Atan2(
			hiderSpawn[1]+authorityTargetHeight*0.5-
				(hunterSpawn[1]+authorityPlayerStandingEyeY),
			horizontalDistance,
		) * 180 / math.Pi,
		Pose: "standing",
	}
	target := roundAvatarStateSnapshot{
		PositionX: hiderSpawn[0],
		PositionY: hiderSpawn[1],
		PositionZ: hiderSpawn[2],
		Pose:      "crouching",
	}
	if !withinHunterFireLineOfSight(hunter, target, &arena.Geometry) {
		t.Fatal("the deterministic smoke pair does not have authoritative line of sight")
	}
}
