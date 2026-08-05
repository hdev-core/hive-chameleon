package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
)

const (
	officialAuthorityGeometryVersion        = "chroma-district-authority-proxy-1"
	officialAuthorityGeometryExpectedDigest = "sha256:a39e5e7ae0e3f8f3d7fffc718f5e93047799f8d1338afa8b25b5d3ee0021c9a8"

	authorityPlayerRadius          = 0.38
	authorityPlayerSkinWidth       = 0.08
	authorityPlayerStandingHeight  = 1.90
	authorityPlayerCrouchingHeight = 1.20
	authorityPlayerStandingEyeY    = 1.62
	authorityPlayerCrouchingEyeY   = 1.02
	authorityTargetRadius          = 0.34
	authorityTargetHeight          = 1.90

	authoritySweepStep        = 0.075
	authorityCollisionEpsilon = 1e-9
	authorityRayEpsilon       = 1e-7
)

type authorityVector struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

func (left authorityVector) add(right authorityVector) authorityVector {
	return authorityVector{
		X: left.X + right.X,
		Y: left.Y + right.Y,
		Z: left.Z + right.Z,
	}
}

func (left authorityVector) subtract(right authorityVector) authorityVector {
	return authorityVector{
		X: left.X - right.X,
		Y: left.Y - right.Y,
		Z: left.Z - right.Z,
	}
}

func (value authorityVector) scale(factor float64) authorityVector {
	return authorityVector{
		X: value.X * factor,
		Y: value.Y * factor,
		Z: value.Z * factor,
	}
}

func (value authorityVector) length() float64 {
	return math.Sqrt(
		value.X*value.X +
			value.Y*value.Y +
			value.Z*value.Z,
	)
}

type authorityOrientedBox struct {
	Name        string          `json:"name"`
	Center      authorityVector `json:"center"`
	HalfExtent  authorityVector `json:"half_extent"`
	Quaternion  authorityVector `json:"quaternion_xyz"`
	QuaternionW float64         `json:"quaternion_w"`
}

func (box authorityOrientedBox) worldToLocal(
	point authorityVector,
) authorityVector {
	offset := point.subtract(box.Center)
	sine := 2 * box.QuaternionW * box.Quaternion.Y
	cosine := 1 - 2*box.Quaternion.Y*box.Quaternion.Y
	return authorityVector{
		X: cosine*offset.X - sine*offset.Z,
		Y: offset.Y,
		Z: sine*offset.X + cosine*offset.Z,
	}
}

func (box authorityOrientedBox) directionToLocal(
	direction authorityVector,
) authorityVector {
	sine := 2 * box.QuaternionW * box.Quaternion.Y
	cosine := 1 - 2*box.Quaternion.Y*box.Quaternion.Y
	return authorityVector{
		X: cosine*direction.X - sine*direction.Z,
		Y: direction.Y,
		Z: sine*direction.X + cosine*direction.Z,
	}
}

type authorityCapsuleProxy struct {
	Name   string          `json:"name"`
	Center authorityVector `json:"center"`
	Radius float64         `json:"radius"`
	Height float64         `json:"height"`
}

func (capsule authorityCapsuleProxy) axis() (float64, float64) {
	halfSegment := math.Max(0, capsule.Height*0.5-capsule.Radius)
	return capsule.Center.Y - halfSegment, capsule.Center.Y + halfSegment
}

type authorityAxisAlignedBox struct {
	Name string          `json:"name"`
	Min  authorityVector `json:"min"`
	Max  authorityVector `json:"max"`
}

type authorityPlayerGeometry struct {
	Radius          float64 `json:"radius"`
	SkinWidth       float64 `json:"skin_width"`
	StandingHeight  float64 `json:"standing_height"`
	CrouchingHeight float64 `json:"crouching_height"`
	StandingEyeY    float64 `json:"standing_eye_y"`
	CrouchingEyeY   float64 `json:"crouching_eye_y"`
	TargetRadius    float64 `json:"target_radius"`
	TargetHeight    float64 `json:"target_height"`
}

type authorityGeometryManifest struct {
	SchemaVersion  int                       `json:"schema_version"`
	Version        string                    `json:"version"`
	MapSlug        string                    `json:"map_slug"`
	ContentVersion string                    `json:"content_version"`
	Player         authorityPlayerGeometry   `json:"player"`
	Buildings      []authorityOrientedBox    `json:"buildings"`
	Trees          []authorityCapsuleProxy   `json:"trees"`
	Boundaries     []authorityAxisAlignedBox `json:"boundaries"`
}

var officialAuthorityGeometry = authorityGeometryManifest{
	SchemaVersion:  1,
	Version:        officialAuthorityGeometryVersion,
	MapSlug:        defaultOfficialMapSlug,
	ContentVersion: defaultOfficialMapContentVersion,
	Player: authorityPlayerGeometry{
		Radius:          authorityPlayerRadius,
		SkinWidth:       authorityPlayerSkinWidth,
		StandingHeight:  authorityPlayerStandingHeight,
		CrouchingHeight: authorityPlayerCrouchingHeight,
		StandingEyeY:    authorityPlayerStandingEyeY,
		CrouchingEyeY:   authorityPlayerCrouchingEyeY,
		TargetRadius:    authorityTargetRadius,
		TargetHeight:    authorityTargetHeight,
	},
	Buildings: []authorityOrientedBox{
		{
			Name: "Building01",
			Center: authorityVector{
				X: 16.1000366,
				Y: 11.4065228,
				Z: -11.3999987,
			},
			HalfExtent: authorityVector{
				X: 4.999999,
				Y: 11.1365223,
				Z: 4.999999,
			},
			Quaternion:  authorityVector{Y: 0.06142344},
			QuaternionW: 0.9981118,
		},
		{
			Name: "Building02",
			Center: authorityVector{
				X: -0.129982442,
				Y: 11.3865223,
				Z: -13.4000063,
			},
			HalfExtent: authorityVector{
				X: 4.999999,
				Y: 11.1365223,
				Z: 4.999999,
			},
			Quaternion:  authorityVector{Y: -0.296102762},
			QuaternionW: 0.955156147,
		},
		{
			Name: "Building03",
			Center: authorityVector{
				X: -16.2000122,
				Y: 11.3465271,
				Z: -16.2999954,
			},
			HalfExtent: authorityVector{
				X: 4.999999,
				Y: 11.1365223,
				Z: 4.999999,
			},
			Quaternion:  authorityVector{Y: 0.129438266},
			QuaternionW: 0.9915875,
		},
		{
			Name: "Coffee House",
			Center: authorityVector{
				X: -16.422945,
				Y: 1.6939683,
				Z: 13.4501295,
			},
			HalfExtent: authorityVector{
				X: 2.564299,
				Y: 1.6939683,
				Z: 2.55199862,
			},
			Quaternion:  authorityVector{Y: -0.00285784085},
			QuaternionW: 0.999995947,
		},
	},
	Trees: []authorityCapsuleProxy{
		{
			Name:   "Tree01",
			Center: authorityVector{X: 13.9, Y: 2.4, Z: -25.91},
			Radius: 0.45,
			Height: 4.8,
		},
		{
			Name:   "Tree02",
			Center: authorityVector{X: -25.94, Y: 2.4, Z: 11.49},
			Radius: 0.4500001,
			Height: 4.8,
		},
		{
			Name:   "Tree03",
			Center: authorityVector{X: 25.710001, Y: 1.63200009, Z: 19.4},
			Radius: 0.450000048,
			Height: 3.26400018,
		},
		{
			Name:   "Tree04",
			Center: authorityVector{X: -26, Y: 2.4, Z: -9.7},
			Radius: 0.450000048,
			Height: 4.8,
		},
		{
			Name:   "Tree05",
			Center: authorityVector{X: 13.8, Y: 1.63200009, Z: 13.9},
			Radius: 0.450000048,
			Height: 3.26400018,
		},
		{
			Name:   "Tree06",
			Center: authorityVector{X: 12.18, Y: 2.59354854, Z: 26.2540054},
			Radius: 0.4500001,
			Height: 5.187097,
		},
		{
			Name:   "Tree07",
			Center: authorityVector{X: -4, Y: 1.63200009, Z: -26.4},
			Radius: 0.449999958,
			Height: 3.26400018,
		},
		{
			Name:   "Tree08",
			Center: authorityVector{X: 23.42, Y: 2.4, Z: 11.44},
			Radius: 0.4500001,
			Height: 4.8,
		},
		{
			Name:   "Tree09",
			Center: authorityVector{X: 26.09, Y: 2.4, Z: -7.32156563},
			Radius: 0.416417927,
			Height: 4.8,
		},
	},
	Boundaries: []authorityAxisAlignedBox{
		{
			Name: "North city boundary",
			Min:  authorityVector{X: -27.5, Y: 0, Z: 26.7},
			Max:  authorityVector{X: 27.5, Y: 6, Z: 27.7},
		},
		{
			Name: "South city boundary",
			Min:  authorityVector{X: -27.5, Y: 0, Z: -27.7},
			Max:  authorityVector{X: 27.5, Y: 6, Z: -26.7},
		},
		{
			Name: "West city boundary",
			Min:  authorityVector{X: -27.7, Y: 0, Z: -27.5},
			Max:  authorityVector{X: -26.7, Y: 6, Z: 27.5},
		},
		{
			Name: "East city boundary",
			Min:  authorityVector{X: 26.7, Y: 0, Z: -27.5},
			Max:  authorityVector{X: 27.7, Y: 6, Z: 27.5},
		},
	},
}

var officialAuthorityGeometryDigest = computeAuthorityGeometryDigest(
	officialAuthorityGeometry,
)

func init() {
	if officialAuthorityGeometryDigest !=
		officialAuthorityGeometryExpectedDigest {
		panic("official authority geometry digest changed without a version update")
	}
}

func computeAuthorityGeometryDigest(
	geometry authorityGeometryManifest,
) string {
	payload, err := json.Marshal(geometry)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func authorityPlayerHeight(pose string) float64 {
	if pose == "crouching" {
		return authorityPlayerCrouchingHeight
	}
	return authorityPlayerStandingHeight
}

func authorityPlayerEyeHeight(pose string) float64 {
	if pose == "crouching" {
		return authorityPlayerCrouchingEyeY
	}
	return authorityPlayerStandingEyeY
}

func authorityPlayerCapsule(
	position authorityVector,
	height float64,
) authorityCapsuleProxy {
	radius := authorityPlayerRadius - authorityPlayerSkinWidth
	return authorityCapsuleProxy{
		Center: authorityVector{
			X: position.X,
			Y: position.Y + height*0.5,
			Z: position.Z,
		},
		Radius: radius,
		Height: height,
	}
}

func authorityTargetCapsule(
	position authorityVector,
) authorityCapsuleProxy {
	return authorityCapsuleProxy{
		Center: authorityVector{
			X: position.X,
			Y: position.Y + authorityTargetHeight*0.5,
			Z: position.Z,
		},
		Radius: authorityTargetRadius,
		Height: authorityTargetHeight,
	}
}

func authorityCapsuleIntersectsStatic(
	capsule authorityCapsuleProxy,
) bool {
	lower, upper := capsule.axis()
	for _, building := range officialAuthorityGeometry.Buildings {
		localCenter := building.worldToLocal(capsule.Center)
		if verticalCapsuleIntersectsBox(
			localCenter,
			lower-building.Center.Y,
			upper-building.Center.Y,
			capsule.Radius,
			building.HalfExtent,
		) {
			return true
		}
	}
	for _, tree := range officialAuthorityGeometry.Trees {
		if verticalCapsulesIntersect(capsule, tree) {
			return true
		}
	}
	for _, boundary := range officialAuthorityGeometry.Boundaries {
		center := boundary.Min.add(boundary.Max).scale(0.5)
		half := boundary.Max.subtract(boundary.Min).scale(0.5)
		if verticalCapsuleIntersectsBox(
			capsule.Center.subtract(center),
			lower-center.Y,
			upper-center.Y,
			capsule.Radius,
			half,
		) {
			return true
		}
	}
	return false
}

func verticalCapsuleIntersectsBox(
	center authorityVector,
	lower float64,
	upper float64,
	radius float64,
	half authorityVector,
) bool {
	distanceX := math.Max(math.Abs(center.X)-half.X, 0)
	distanceZ := math.Max(math.Abs(center.Z)-half.Z, 0)
	distanceY := intervalDistance(lower, upper, -half.Y, half.Y)
	return distanceX*distanceX+
		distanceY*distanceY+
		distanceZ*distanceZ <
		radius*radius-authorityCollisionEpsilon
}

func intervalDistance(
	firstMin float64,
	firstMax float64,
	secondMin float64,
	secondMax float64,
) float64 {
	if firstMax < secondMin {
		return secondMin - firstMax
	}
	if secondMax < firstMin {
		return firstMin - secondMax
	}
	return 0
}

func verticalCapsulesIntersect(
	left authorityCapsuleProxy,
	right authorityCapsuleProxy,
) bool {
	leftLower, leftUpper := left.axis()
	rightLower, rightUpper := right.axis()
	distanceX := left.Center.X - right.Center.X
	distanceZ := left.Center.Z - right.Center.Z
	distanceY := intervalDistance(
		leftLower,
		leftUpper,
		rightLower,
		rightUpper,
	)
	radius := left.Radius + right.Radius
	return distanceX*distanceX+
		distanceY*distanceY+
		distanceZ*distanceZ <
		radius*radius-authorityCollisionEpsilon
}

func authorityMovementIntersectsStatic(
	start authorityVector,
	end authorityVector,
	height float64,
) bool {
	distance := end.subtract(start).length()
	steps := int(math.Ceil(distance / authoritySweepStep))
	if steps < 1 {
		steps = 1
	}
	for index := 1; index <= steps; index++ {
		position := start.add(
			end.subtract(start).scale(float64(index) / float64(steps)),
		)
		if authorityCapsuleIntersectsStatic(
			authorityPlayerCapsule(position, height),
		) {
			return true
		}
	}
	return false
}

func firstAuthorityStaticRayHit(
	origin authorityVector,
	direction authorityVector,
	maximumDistance float64,
) (float64, bool) {
	nearest := maximumDistance
	found := false
	for _, building := range officialAuthorityGeometry.Buildings {
		distance, hit := rayBoxIntersection(
			building.worldToLocal(origin),
			building.directionToLocal(direction),
			building.HalfExtent.scale(-1),
			building.HalfExtent,
			maximumDistance,
		)
		if hit && distance < nearest {
			nearest = distance
			found = true
		}
	}
	for _, tree := range officialAuthorityGeometry.Trees {
		distance, hit := rayCapsuleIntersection(
			origin,
			direction,
			tree,
			maximumDistance,
		)
		if hit && distance < nearest {
			nearest = distance
			found = true
		}
	}
	for _, boundary := range officialAuthorityGeometry.Boundaries {
		distance, hit := rayBoxIntersection(
			origin,
			direction,
			boundary.Min,
			boundary.Max,
			maximumDistance,
		)
		if hit && distance < nearest {
			nearest = distance
			found = true
		}
	}
	return nearest, found
}

func rayBoxIntersection(
	origin authorityVector,
	direction authorityVector,
	minimum authorityVector,
	maximum authorityVector,
	maximumDistance float64,
) (float64, bool) {
	entry := 0.0
	exit := maximumDistance
	for _, axis := range [][4]float64{
		{origin.X, direction.X, minimum.X, maximum.X},
		{origin.Y, direction.Y, minimum.Y, maximum.Y},
		{origin.Z, direction.Z, minimum.Z, maximum.Z},
	} {
		if math.Abs(axis[1]) < authorityRayEpsilon {
			if axis[0] < axis[2] || axis[0] > axis[3] {
				return 0, false
			}
			continue
		}
		first := (axis[2] - axis[0]) / axis[1]
		second := (axis[3] - axis[0]) / axis[1]
		if first > second {
			first, second = second, first
		}
		entry = math.Max(entry, first)
		exit = math.Min(exit, second)
		if entry > exit {
			return 0, false
		}
	}
	if exit < 0 || entry > maximumDistance {
		return 0, false
	}
	return math.Max(entry, 0), true
}

func rayCapsuleIntersection(
	origin authorityVector,
	direction authorityVector,
	capsule authorityCapsuleProxy,
	maximumDistance float64,
) (float64, bool) {
	lower, upper := capsule.axis()
	if pointCapsuleDistanceSquared(origin, capsule) <=
		capsule.Radius*capsule.Radius {
		return 0, true
	}
	nearest := maximumDistance
	found := false
	offsetX := origin.X - capsule.Center.X
	offsetZ := origin.Z - capsule.Center.Z
	quadraticA := direction.X*direction.X + direction.Z*direction.Z
	if quadraticA > authorityRayEpsilon {
		quadraticB := 2 * (offsetX*direction.X + offsetZ*direction.Z)
		quadraticC := offsetX*offsetX +
			offsetZ*offsetZ -
			capsule.Radius*capsule.Radius
		discriminant := quadraticB*quadraticB -
			4*quadraticA*quadraticC
		if discriminant >= 0 {
			root := math.Sqrt(discriminant)
			for _, distance := range []float64{
				(-quadraticB - root) / (2 * quadraticA),
				(-quadraticB + root) / (2 * quadraticA),
			} {
				height := origin.Y + direction.Y*distance
				if distance >= 0 &&
					distance <= nearest &&
					height >= lower &&
					height <= upper {
					nearest = distance
					found = true
				}
			}
		}
	}
	for _, centerY := range []float64{lower, upper} {
		distance, hit := raySphereIntersection(
			origin,
			direction,
			authorityVector{
				X: capsule.Center.X,
				Y: centerY,
				Z: capsule.Center.Z,
			},
			capsule.Radius,
			nearest,
		)
		if hit && distance <= nearest {
			nearest = distance
			found = true
		}
	}
	return nearest, found
}

func pointCapsuleDistanceSquared(
	point authorityVector,
	capsule authorityCapsuleProxy,
) float64 {
	lower, upper := capsule.axis()
	nearestY := math.Max(lower, math.Min(upper, point.Y))
	distanceX := point.X - capsule.Center.X
	distanceY := point.Y - nearestY
	distanceZ := point.Z - capsule.Center.Z
	return distanceX*distanceX +
		distanceY*distanceY +
		distanceZ*distanceZ
}

func raySphereIntersection(
	origin authorityVector,
	direction authorityVector,
	center authorityVector,
	radius float64,
	maximumDistance float64,
) (float64, bool) {
	offset := origin.subtract(center)
	quadraticB := 2 * (offset.X*direction.X +
		offset.Y*direction.Y +
		offset.Z*direction.Z)
	quadraticC := offset.X*offset.X +
		offset.Y*offset.Y +
		offset.Z*offset.Z -
		radius*radius
	discriminant := quadraticB*quadraticB - 4*quadraticC
	if discriminant < 0 {
		return 0, false
	}
	root := math.Sqrt(discriminant)
	first := (-quadraticB - root) * 0.5
	second := (-quadraticB + root) * 0.5
	if first >= 0 && first <= maximumDistance {
		return first, true
	}
	if second >= 0 && second <= maximumDistance {
		return second, true
	}
	return 0, false
}
