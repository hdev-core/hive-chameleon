package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"time"
)

const (
	avatarStateCommandOpcode     = 14
	roundAvatarStateOpcode       = 15
	maximumAvatarStateBytes      = 1024
	maximumAvatarPoseLength      = 24
	maximumHunterFireRange       = 80
	maximumFireAvatarAge         = 3 * time.Second
	officialArenaHorizontalLimit = 27.2
	officialArenaMinimumY        = -2.0
	officialArenaMaximumY        = 20.0
	minimumAvatarPitch           = -58.0
	maximumAvatarPitch           = 62.0
	maximumAvatarHorizontalSpeed = 12.0
	maximumAvatarVerticalSpeed   = 20.0
	maximumAvatarYawRate         = 1080.0
	maximumAvatarPitchRate       = 720.0
	avatarMotionDistanceSlack    = 0.75
	avatarMotionYawSlack         = 20.0
	avatarMotionPitchSlack       = 15.0
	maximumInitialSpawnDistance  = 4.0
)

var officialHunterSpawns = [][3]float64{
	{0, 0.15, 6},
	{2.4, 0.15, 7.2},
}

var officialHiderSpawns = [][3]float64{
	{-12.4, 0.05, -7.4},
	{5.7, 0.05, -7.8},
	{12.7, 0.05, 11.6},
	{-12.8, 0.05, 9.8},
	{19.2, 0.05, 5.2},
	{-19.1, 0.05, 5.4},
	{8.2, 0.05, -18.7},
	{-8.1, 0.05, -18.4},
}

type avatarStateCommand struct {
	PositionX float64 `json:"position_x"`
	PositionY float64 `json:"position_y"`
	PositionZ float64 `json:"position_z"`
	Yaw       float64 `json:"yaw"`
	Pitch     float64 `json:"pitch"`
	BodyR     float64 `json:"body_r"`
	BodyG     float64 `json:"body_g"`
	BodyB     float64 `json:"body_b"`
	AccentR   float64 `json:"accent_r"`
	AccentG   float64 `json:"accent_g"`
	AccentB   float64 `json:"accent_b"`
	Pose      string  `json:"pose"`
}

type roundAvatarStateSnapshot struct {
	RoundID     string    `json:"round_id"`
	PlayerID    string    `json:"player_id"`
	DisplayName string    `json:"display_name,omitempty"`
	Role        string    `json:"role"`
	Status      string    `json:"status"`
	PositionX   float64   `json:"position_x"`
	PositionY   float64   `json:"position_y"`
	PositionZ   float64   `json:"position_z"`
	Yaw         float64   `json:"yaw"`
	Pitch       float64   `json:"pitch"`
	BodyR       float64   `json:"body_r"`
	BodyG       float64   `json:"body_g"`
	BodyB       float64   `json:"body_b"`
	AccentR     float64   `json:"accent_r"`
	AccentG     float64   `json:"accent_g"`
	AccentB     float64   `json:"accent_b"`
	Pose        string    `json:"pose"`
	Sequence    uint64    `json:"sequence"`
	OccurredAt  time.Time `json:"occurred_at"`
	Correction  bool      `json:"correction,omitempty"`
}

func decodeAvatarStateCommand(payload []byte) (avatarStateCommand, error) {
	var command avatarStateCommand
	if len(payload) == 0 || len(payload) > maximumAvatarStateBytes {
		return command, errors.New("invalid avatar state command")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		return command, errors.New("invalid avatar state command")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return command, errors.New("invalid avatar state command")
	}
	if !validAvatarPosition(
		command.PositionX,
		command.PositionY,
		command.PositionZ,
	) ||
		!finiteNumber(command.Yaw) ||
		!validAvatarPitch(command.Pitch) ||
		!validAvatarColor(command.BodyR) ||
		!validAvatarColor(command.BodyG) ||
		!validAvatarColor(command.BodyB) ||
		!validAvatarColor(command.AccentR) ||
		!validAvatarColor(command.AccentG) ||
		!validAvatarColor(command.AccentB) ||
		len(command.Pose) > maximumAvatarPoseLength ||
		!validAvatarPose(command.Pose) {
		return avatarStateCommand{}, errors.New("invalid avatar state command")
	}
	command.Yaw = normalizeAvatarYaw(command.Yaw)
	return command, nil
}

func (s *persistentLobbyState) applyAvatarState(
	playerID string,
	command avatarStateCommand,
	now time.Time,
) (roundAvatarStateSnapshot, error) {
	if s == nil || s.AuthoritativeRound == nil || s.Round == nil {
		return roundAvatarStateSnapshot{}, errors.New("active round required")
	}
	playerState, participant := s.AuthoritativeRound.PlayerState(playerID)
	if !participant {
		return roundAvatarStateSnapshot{}, errors.New("round participant required")
	}
	activeRoundPhase := s.AuthoritativeRound.Phase == "preparing" ||
		s.AuthoritativeRound.Phase == "hiding" ||
		s.AuthoritativeRound.Phase == "hunting"
	answerCheckHunter := s.AuthoritativeRound.Phase == "answer_check" &&
		playerState.InitialRole == "hunter"
	if !activeRoundPhase && !answerCheckHunter {
		return roundAvatarStateSnapshot{}, errors.New("avatar state phase is closed")
	}
	if playerState.Status == "found" {
		return roundAvatarStateSnapshot{}, errors.New("found Hider cannot move")
	}
	if s.AvatarStates == nil {
		s.AvatarStates = make(map[string]roundAvatarStateSnapshot)
	}
	previous := s.AvatarStates[playerID]
	assignment := s.AuthoritativeRound.Assignments[playerID]
	if err := validateAvatarMotion(
		playerID,
		assignment.Role,
		previous,
		command,
		now,
	); err != nil {
		return roundAvatarStateSnapshot{}, err
	}
	sequence := previous.Sequence + 1
	snapshot := roundAvatarStateSnapshot{
		RoundID:     s.AuthoritativeRound.RoundID,
		PlayerID:    playerID,
		DisplayName: assignment.DisplayName,
		Role:        playerState.Role,
		Status:      playerState.Status,
		PositionX:   command.PositionX,
		PositionY:   command.PositionY,
		PositionZ:   command.PositionZ,
		Yaw:         command.Yaw,
		Pitch:       command.Pitch,
		BodyR:       command.BodyR,
		BodyG:       command.BodyG,
		BodyB:       command.BodyB,
		AccentR:     command.AccentR,
		AccentG:     command.AccentG,
		AccentB:     command.AccentB,
		Pose:        command.Pose,
		Sequence:    sequence,
		OccurredAt:  now.UTC(),
	}
	s.AvatarStates[playerID] = snapshot
	return snapshot, nil
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func validAvatarPosition(x float64, y float64, z float64) bool {
	return finiteNumber(x) &&
		finiteNumber(y) &&
		finiteNumber(z) &&
		x >= -officialArenaHorizontalLimit &&
		x <= officialArenaHorizontalLimit &&
		z >= -officialArenaHorizontalLimit &&
		z <= officialArenaHorizontalLimit &&
		y >= officialArenaMinimumY &&
		y <= officialArenaMaximumY
}

func validAvatarColor(value float64) bool {
	return finiteNumber(value) && value >= 0 && value <= 1
}

func validAvatarPitch(value float64) bool {
	return finiteNumber(value) &&
		value >= minimumAvatarPitch &&
		value <= maximumAvatarPitch
}

func validAvatarPose(pose string) bool {
	switch pose {
	case "idle", "standing", "running", "crouching", "aiming", "painting":
		return true
	default:
		return false
	}
}

func normalizeAvatarYaw(yaw float64) float64 {
	yaw = math.Mod(yaw, 360)
	if yaw < 0 {
		yaw += 360
	}
	return yaw
}

func initializeRoundAvatarStates(
	round *roundSnapshot,
	authoritative *authoritativeRoundState,
) map[string]roundAvatarStateSnapshot {
	states := make(map[string]roundAvatarStateSnapshot)
	if round == nil || authoritative == nil {
		return states
	}
	for playerID, assignment := range authoritative.Assignments {
		spawn := officialSpawnForPlayer(playerID, assignment.Role)
		states[playerID] = roundAvatarStateSnapshot{
			RoundID:     round.ID,
			PlayerID:    playerID,
			DisplayName: assignment.DisplayName,
			Role:        assignment.Role,
			Status:      "active",
			PositionX:   spawn[0],
			PositionY:   spawn[1],
			PositionZ:   spawn[2],
			Yaw:         180,
			Pitch:       0,
			BodyR:       0.68,
			BodyG:       0.76,
			BodyB:       0.78,
			AccentR:     0.16,
			AccentG:     0.87,
			AccentB:     0.88,
			Pose:        "standing",
			Sequence:    1,
			OccurredAt:  round.StartedAt.UTC(),
		}
	}
	return states
}

func synchronizeAvatarAuthority(state *persistentLobbyState) {
	if state == nil || state.AuthoritativeRound == nil {
		return
	}
	for playerID, snapshot := range state.AvatarStates {
		playerState, available := state.AuthoritativeRound.PlayerState(playerID)
		if !available {
			delete(state.AvatarStates, playerID)
			continue
		}
		snapshot.DisplayName = playerState.DisplayName
		snapshot.Role = playerState.Role
		snapshot.Status = playerState.Status
		state.AvatarStates[playerID] = snapshot
	}
}

func validateAvatarMotion(
	playerID string,
	initialRole string,
	previous roundAvatarStateSnapshot,
	command avatarStateCommand,
	now time.Time,
) error {
	if !validAvatarPosition(
		command.PositionX,
		command.PositionY,
		command.PositionZ,
	) {
		return errors.New("avatar position is outside the official arena")
	}
	commandPosition := authorityVector{
		X: command.PositionX,
		Y: command.PositionY,
		Z: command.PositionZ,
	}
	commandHeight := authorityPlayerHeight(command.Pose)
	if authorityCapsuleIntersectsStatic(
		authorityPlayerCapsule(commandPosition, commandHeight),
	) {
		return errors.New("avatar position intersects official arena geometry")
	}
	if previous.Sequence == 0 {
		spawn := officialSpawnForPlayer(playerID, initialRole)
		distance := math.Sqrt(
			math.Pow(command.PositionX-spawn[0], 2) +
				math.Pow(command.PositionY-spawn[1], 2) +
				math.Pow(command.PositionZ-spawn[2], 2),
		)
		if distance > maximumInitialSpawnDistance {
			return errors.New("initial avatar position is outside the assigned spawn")
		}
		return nil
	}
	if previous.PlayerID != playerID ||
		previous.OccurredAt.IsZero() ||
		previous.OccurredAt.After(now) {
		return errors.New("previous avatar state is invalid")
	}
	elapsed := now.Sub(previous.OccurredAt).Seconds()
	horizontalDistance := math.Hypot(
		command.PositionX-previous.PositionX,
		command.PositionZ-previous.PositionZ,
	)
	if horizontalDistance >
		maximumAvatarHorizontalSpeed*elapsed+avatarMotionDistanceSlack {
		return errors.New("avatar horizontal movement exceeded the server limit")
	}
	verticalDistance := math.Abs(command.PositionY - previous.PositionY)
	if verticalDistance >
		maximumAvatarVerticalSpeed*elapsed+avatarMotionDistanceSlack {
		return errors.New("avatar vertical movement exceeded the server limit")
	}
	yawDistance := shortestYawDistance(previous.Yaw, command.Yaw)
	if yawDistance > maximumAvatarYawRate*elapsed+avatarMotionYawSlack {
		return errors.New("avatar rotation exceeded the server limit")
	}
	pitchDistance := math.Abs(previous.Pitch - command.Pitch)
	if pitchDistance >
		maximumAvatarPitchRate*elapsed+avatarMotionPitchSlack {
		return errors.New("avatar pitch exceeded the server limit")
	}
	previousPosition := authorityVector{
		X: previous.PositionX,
		Y: previous.PositionY,
		Z: previous.PositionZ,
	}
	sweepHeight := math.Max(
		authorityPlayerHeight(previous.Pose),
		commandHeight,
	)
	if authorityMovementIntersectsStatic(
		previousPosition,
		commandPosition,
		sweepHeight,
	) {
		return errors.New("avatar movement intersects official arena geometry")
	}
	return nil
}

func shortestYawDistance(left float64, right float64) float64 {
	difference := math.Abs(normalizeAvatarYaw(left) - normalizeAvatarYaw(right))
	if difference > 180 {
		return 360 - difference
	}
	return difference
}

func officialSpawnForPlayer(playerID string, role string) [3]float64 {
	spawns := officialHiderSpawns
	if role == "hunter" {
		spawns = officialHunterSpawns
	}
	hash := int64(17)
	for _, character := range playerID {
		hash = int64(int32(hash*31 + int64(character)))
	}
	hash32 := int32(hash)
	if hash32 == math.MinInt32 {
		hash32 = 0
	} else if hash32 < 0 {
		hash32 = -hash32
	}
	return spawns[int(hash32)%len(spawns)]
}

func (s *persistentLobbyState) authorizeFireTarget(
	hunterPlayerID string,
	command hunterFireCommand,
	now time.Time,
) hunterFireCommand {
	if command.TargetPlayerID == "" {
		return command
	}
	if s == nil || s.AuthoritativeRound == nil {
		command.TargetPlayerID = ""
		return command
	}
	hunter, hunterAvailable := s.AvatarStates[hunterPlayerID]
	target, targetAvailable := s.AvatarStates[command.TargetPlayerID]
	if !hunterAvailable ||
		!targetAvailable ||
		!validFireAvatarState(
			hunter,
			s.AuthoritativeRound.RoundID,
			hunterPlayerID,
			now,
			true,
		) ||
		!validFireAvatarState(
			target,
			s.AuthoritativeRound.RoundID,
			command.TargetPlayerID,
			now,
			false,
		) {
		command.TargetPlayerID = ""
		return command
	}
	firingHunter := hunter
	if command.AimYaw != nil && command.AimPitch != nil {
		elapsed := now.Sub(hunter.OccurredAt).Seconds()
		if elapsed < 0 ||
			shortestYawDistance(hunter.Yaw, *command.AimYaw) >
				maximumAvatarYawRate*elapsed+avatarMotionYawSlack ||
			math.Abs(hunter.Pitch-*command.AimPitch) >
				maximumAvatarPitchRate*elapsed+avatarMotionPitchSlack {
			command.TargetPlayerID = ""
			return command
		}
		firingHunter.Yaw = *command.AimYaw
		firingHunter.Pitch = *command.AimPitch
	}
	if !withinHunterFireLineOfSight(firingHunter, target) {
		command.TargetPlayerID = ""
	}
	return command
}

func withinHunterFireLineOfSight(
	hunter roundAvatarStateSnapshot,
	target roundAvatarStateSnapshot,
) bool {
	origin := authorityVector{
		X: hunter.PositionX,
		Y: hunter.PositionY + authorityPlayerEyeHeight(hunter.Pose),
		Z: hunter.PositionZ,
	}
	yawRadians := hunter.Yaw * math.Pi / 180
	pitchRadians := hunter.Pitch * math.Pi / 180
	cosinePitch := math.Cos(pitchRadians)
	direction := authorityVector{
		X: math.Sin(yawRadians) * cosinePitch,
		Y: -math.Sin(pitchRadians),
		Z: math.Cos(yawRadians) * cosinePitch,
	}
	targetDistance, targetHit := rayCapsuleIntersection(
		origin,
		direction,
		authorityTargetCapsule(authorityVector{
			X: target.PositionX,
			Y: target.PositionY,
			Z: target.PositionZ,
		}),
		maximumHunterFireRange,
	)
	if !targetHit {
		return false
	}
	staticDistance, staticHit := firstAuthorityStaticRayHit(
		origin,
		direction,
		targetDistance,
	)
	return !staticHit ||
		staticDistance+authorityRayEpsilon >= targetDistance
}

func withinHunterFireAimCone(
	hunter roundAvatarStateSnapshot,
	target roundAvatarStateSnapshot,
) bool {
	// Kept as a narrow compatibility seam for tests and callers during the
	// protocol transition; fire authority is now pitch-aware and proves LOS.
	return withinHunterFireLineOfSight(hunter, target)
}

func validFireAvatarState(
	state roundAvatarStateSnapshot,
	roundID string,
	playerID string,
	now time.Time,
	requireRecent bool,
) bool {
	if state.RoundID != roundID ||
		state.PlayerID != playerID ||
		state.Sequence == 0 ||
		!validAvatarPitch(state.Pitch) ||
		state.OccurredAt.After(now) {
		return false
	}
	return !requireRecent || now.Sub(state.OccurredAt) <= maximumFireAvatarAge
}
