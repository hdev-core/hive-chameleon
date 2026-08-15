package main

import (
	"math"
	"strings"
	"testing"
)

func TestOfficialAuthorityGeometryIsVersionedAndDeterministic(t *testing.T) {
	t.Parallel()

	if officialAuthorityGeometry.SchemaVersion != 1 ||
		officialAuthorityGeometry.Version !=
			officialAuthorityGeometryVersion ||
		officialAuthorityGeometry.MapSlug != legacyOfficialMapSlug ||
		officialAuthorityGeometry.ContentVersion !=
			legacyOfficialMapContentVersion {
		t.Fatalf(
			"unexpected authority geometry identity: %#v",
			officialAuthorityGeometry,
		)
	}
	if len(officialAuthorityGeometry.Buildings) != 4 ||
		len(officialAuthorityGeometry.Trees) != 9 ||
		len(officialAuthorityGeometry.Boundaries) != 4 {
		t.Fatalf(
			"unexpected authority proxy counts: buildings=%d trees=%d boundaries=%d",
			len(officialAuthorityGeometry.Buildings),
			len(officialAuthorityGeometry.Trees),
			len(officialAuthorityGeometry.Boundaries),
		)
	}
	if !strings.HasPrefix(
		officialAuthorityGeometryDigest,
		"sha256:",
	) ||
		len(officialAuthorityGeometryDigest) != len("sha256:")+64 ||
		officialAuthorityGeometryDigest !=
			officialAuthorityGeometryExpectedDigest ||
		officialAuthorityGeometryDigest !=
			computeAuthorityGeometryDigest(officialAuthorityGeometry) {
		t.Fatalf(
			"authority geometry digest is invalid: %q",
			officialAuthorityGeometryDigest,
		)
	}
	t.Logf("authority geometry digest: %s", officialAuthorityGeometryDigest)
}

func TestEveryOfficialRoleSpawnIsClearOfAuthorityGeometry(t *testing.T) {
	t.Parallel()

	for role, spawns := range map[string][][3]float64{
		"hunter": officialHunterSpawns,
		"hider":  officialHiderSpawns,
	} {
		for index, spawn := range spawns {
			position := authorityVector{
				X: spawn[0],
				Y: spawn[1],
				Z: spawn[2],
			}
			if authorityCapsuleIntersectsStatic(
				authorityPlayerCapsule(
					position,
					authorityPlayerStandingHeight,
				),
			) {
				t.Fatalf(
					"%s spawn %d intersects authority geometry: %#v",
					role,
					index,
					spawn,
				)
			}
		}
	}

	if !authorityCapsuleIntersectsStatic(
		authorityPlayerCapsule(
			authorityVector{X: -14.4, Y: 0.05, Z: 10.8},
			authorityPlayerStandingHeight,
		),
	) {
		t.Fatal("the replaced Coffee House spawn was not recognized as blocked")
	}
	if authorityCapsuleIntersectsStatic(
		authorityPlayerCapsule(
			authorityVector{X: 5.7, Y: 0.05, Z: -7.8},
			authorityPlayerStandingHeight,
		),
	) {
		t.Fatal("the legal Building02 street spawn was rejected by its rotated OBB")
	}
}

func TestAuthorityMovementSweepRejectsBuildingsTreesAndBoundaries(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name  string
		start authorityVector
		end   authorityVector
	}{
		{
			name:  "rotated building",
			start: authorityVector{X: -10, Y: 0.05, Z: -13.4},
			end:   authorityVector{X: 10, Y: 0.05, Z: -13.4},
		},
		{
			name:  "tree capsule",
			start: authorityVector{X: 12.5, Y: 0.05, Z: -25.91},
			end:   authorityVector{X: 15.3, Y: 0.05, Z: -25.91},
		},
		{
			name:  "east boundary",
			start: authorityVector{X: 25.5, Y: 0.05, Z: 0},
			end:   authorityVector{X: 26.5, Y: 0.05, Z: 0},
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if !authorityMovementIntersectsStatic(
				test.start,
				test.end,
				authorityPlayerStandingHeight,
			) {
				t.Fatalf(
					"movement crossed %s without an authority collision",
					test.name,
				)
			}
		})
	}

	if authorityMovementIntersectsStatic(
		authorityVector{X: 0, Y: 0.15, Z: 6},
		authorityVector{X: 1.5, Y: 0.15, Z: 6},
		authorityPlayerStandingHeight,
	) {
		t.Fatal("open Hunter-spawn movement was blocked")
	}
}

func TestAuthorityRayUsesRotatedBoxesCapsulesAndTargetFirstHit(t *testing.T) {
	t.Parallel()

	buildingOrigin := authorityVector{X: 16.1, Y: 1.67, Z: -20}
	forward := authorityVector{Z: 1}
	if distance, hit := firstAuthorityStaticRayHit(
		buildingOrigin,
		forward,
		30,
	); !hit || distance <= 0 || distance >= 30 {
		t.Fatalf(
			"Building01 did not block the authority ray: distance=%f hit=%t",
			distance,
			hit,
		)
	}

	treeOrigin := authorityVector{X: 13.9, Y: 1.7, Z: -30}
	if distance, hit := firstAuthorityStaticRayHit(
		treeOrigin,
		forward,
		10,
	); !hit || distance <= 0 || distance >= 10 {
		t.Fatalf(
			"tree capsule did not block the authority ray: distance=%f hit=%t",
			distance,
			hit,
		)
	}

	target := authorityTargetCapsule(
		authorityVector{X: 0, Y: 0.05, Z: 10},
	)
	targetDistance, targetHit := rayCapsuleIntersection(
		authorityVector{X: 0, Y: 1.67, Z: 0},
		forward,
		target,
		20,
	)
	if !targetHit || targetDistance <= 0 || targetDistance >= 20 {
		t.Fatalf(
			"target capsule was not intersected first: distance=%f hit=%t",
			targetDistance,
			targetHit,
		)
	}
	if distance, hit := firstAuthorityStaticRayHit(
		authorityVector{X: 0, Y: 1.67, Z: 0},
		forward,
		targetDistance,
	); hit {
		t.Fatalf(
			"open target was incorrectly occluded at distance %f",
			distance,
		)
	}
}

func TestSmokeAnchorsAreReachableAndVisibleFromEitherHunterSpawn(
	t *testing.T,
) {
	t.Parallel()

	anchors := []authorityVector{
		{X: -20, Y: 0.05, Z: -9},
		{X: -20, Y: 0.05, Z: 2},
		{X: -20, Y: 0.05, Z: -9},
		{X: -20, Y: 0.05, Z: -10},
		{X: -20, Y: 0.05, Z: -9},
		{X: -20, Y: 0.05, Z: -10},
		{X: -2, Y: 0.05, Z: 20},
		{X: -16, Y: 0.05, Z: 9},
	}
	for spawnIndex, spawn := range officialHiderSpawns {
		target := anchors[spawnIndex]
		if authorityCapsuleIntersectsStatic(
			authorityPlayerCapsule(
				target,
				authorityPlayerStandingHeight,
			),
		) ||
			authorityMovementIntersectsStatic(
				authorityVector{
					X: spawn[0],
					Y: spawn[1],
					Z: spawn[2],
				},
				target,
				authorityPlayerStandingHeight,
			) {
			t.Fatalf(
				"smoke anchor %d is not reachable from its role spawn",
				spawnIndex,
			)
		}
		for hunterIndex, hunterSpawn := range officialHunterSpawns {
			hunter := roundAvatarStateSnapshot{
				PositionX: hunterSpawn[0],
				PositionY: hunterSpawn[1],
				PositionZ: hunterSpawn[2],
				Pose:      "standing",
			}
			distanceX := target.X - hunter.PositionX
			distanceY := target.Y +
				authorityTargetHeight*0.5 -
				(hunter.PositionY + authorityPlayerStandingEyeY)
			distanceZ := target.Z - hunter.PositionZ
			hunter.Yaw = math.Atan2(distanceX, distanceZ) * 180 / math.Pi
			hunter.Pitch = -math.Atan2(
				distanceY,
				math.Hypot(distanceX, distanceZ),
			) * 180 / math.Pi
			if !withinHunterFireLineOfSight(
				hunter,
				roundAvatarStateSnapshot{
					PositionX: target.X,
					PositionY: target.Y,
					PositionZ: target.Z,
				},
			) {
				t.Fatalf(
					"smoke anchor %d is occluded from Hunter spawn %d",
					spawnIndex,
					hunterIndex,
				)
			}
		}
	}
}
