package main

import (
	"math"
	"sort"
	"testing"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

type testPresence struct {
	sessionID string
}

func (p testPresence) GetHidden() bool      { return false }
func (p testPresence) GetPersistence() bool { return true }
func (p testPresence) GetUsername() string  { return p.sessionID }
func (p testPresence) GetStatus() string    { return "" }
func (p testPresence) GetReason() runtime.PresenceReason {
	return runtime.PresenceReasonUnknown
}
func (p testPresence) GetUserId() string    { return p.sessionID }
func (p testPresence) GetSessionId() string { return p.sessionID }
func (p testPresence) GetNodeId() string    { return "node" }

func TestAvatarStateCommandIsFlatStrictAndBounded(t *testing.T) {
	t.Parallel()

	command, err := decodeAvatarStateCommand([]byte(`{
		"position_x":8.5,
		"position_y":1,
		"position_z":-8.25,
		"yaw":-30,
		"pitch":-25,
		"body_r":0.1,
		"body_g":0.2,
		"body_b":0.3,
		"accent_r":0.8,
		"accent_g":0.9,
		"accent_b":1,
		"pose":"crouching"
	}`))
	if err != nil {
		t.Fatalf("decode valid avatar state: %v", err)
	}
	if command.Yaw != 330 ||
		command.Pitch != -25 ||
		command.Pose != "crouching" {
		t.Fatalf("avatar state was not normalized: %#v", command)
	}

	for _, payload := range []string{
		`{"position_x":0,"position_y":0,"position_z":0,"yaw":0,"body_r":2,"body_g":0,"body_b":0,"accent_r":0,"accent_g":0,"accent_b":0,"pose":"idle"}`,
		`{"position_x":1001,"position_y":0,"position_z":0,"yaw":0,"body_r":0,"body_g":0,"body_b":0,"accent_r":0,"accent_g":0,"accent_b":0,"pose":"idle"}`,
		`{"position_x":0,"position_y":0,"position_z":0,"yaw":0,"body_r":0,"body_g":0,"body_b":0,"accent_r":0,"accent_g":0,"accent_b":0,"pose":"flying"}`,
		`{"position_x":0,"position_y":0,"position_z":0,"yaw":0,"pitch":90,"body_r":0,"body_g":0,"body_b":0,"accent_r":0,"accent_g":0,"accent_b":0,"pose":"idle"}`,
		`{"position_x":0,"position_y":0,"position_z":0,"yaw":0,"body_r":0,"body_g":0,"body_b":0,"accent_r":0,"accent_g":0,"accent_b":0,"pose":"idle","player_id":"forged"}`,
	} {
		if _, err := decodeAvatarStateCommand([]byte(payload)); err == nil {
			t.Fatalf("accepted invalid avatar state: %s", payload)
		}
	}
}

func TestAvatarStateUsesServerIdentityRoleStatusAndSequence(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates:       initializeRoundAvatarStates(&round, authoritative),
	}
	now := round.StartedAt.Add(time.Second)
	spawn := officialSpawnForPlayer("hider", "hider")
	command := avatarStateCommand{
		PositionX: spawn[0],
		PositionY: spawn[1],
		PositionZ: spawn[2],
		Yaw:       90,
		BodyR:     0.2,
		BodyG:     0.3,
		BodyB:     0.4,
		AccentR:   0.8,
		AccentG:   0.7,
		AccentB:   0.6,
		Pose:      "idle",
	}
	first, err := state.applyAvatarState("hider", command, now)
	if err != nil {
		t.Fatalf("apply Hider avatar state: %v", err)
	}
	if first.RoundID != round.ID ||
		first.PlayerID != "hider" ||
		first.Role != "hider" ||
		first.Status != "active" ||
		first.Sequence != 2 ||
		!first.OccurredAt.Equal(now) {
		t.Fatalf("avatar authority fields are invalid: %#v", first)
	}
	second, err := state.applyAvatarState(
		"hider",
		command,
		now.Add(time.Millisecond),
	)
	if err != nil || second.Sequence != 3 {
		t.Fatalf("avatar sequence did not advance: %#v, %v", second, err)
	}
	if _, err := state.applyAvatarState("spectator", command, now); err == nil {
		t.Fatal("nonparticipant published an avatar state")
	}

	authoritative.Phase = "hiding"
	if recipients, restricted := avatarStateRecipients(state, second); !restricted ||
		len(recipients) != 0 {
		t.Fatalf("Hider hiding-state visibility was not restricted: %#v", recipients)
	}
	hunter := second
	hunter.Role = "hunter"
	if _, restricted := avatarStateRecipients(state, hunter); restricted {
		t.Fatal("Hunter avatar was hidden during the hiding phase")
	}

	authoritative.FoundHiders["hider"] = roundDiscoverySnapshot{
		RoundID:       round.ID,
		HiderPlayerID: "hider",
	}
	if _, err := state.applyAvatarState("hider", command, now); err == nil {
		t.Fatal("found Casual Hider retained movement authority")
	}
}

func TestAvatarStateRejectsTeleportAndYawSpoof(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates:       initializeRoundAvatarStates(&round, authoritative),
	}
	previous := state.AvatarStates["hider"]
	now := previous.OccurredAt.Add(10 * time.Millisecond)
	teleport := avatarStateCommand{
		PositionX: previous.PositionX + 10,
		PositionY: previous.PositionY,
		PositionZ: previous.PositionZ,
		Yaw:       previous.Yaw,
		Pose:      "running",
	}
	if _, err := state.applyAvatarState("hider", teleport, now); err == nil {
		t.Fatal("accepted a client teleport beyond the server movement envelope")
	}

	yawSpoof := avatarStateCommand{
		PositionX: previous.PositionX,
		PositionY: previous.PositionY,
		PositionZ: previous.PositionZ,
		Yaw:       previous.Yaw + 90,
		Pose:      "standing",
	}
	if _, err := state.applyAvatarState("hider", yawSpoof, now); err == nil {
		t.Fatal("accepted a client yaw spike beyond the server rotation envelope")
	}
}

func TestAvatarStateRejectsGeometrySweepAndPitchSpoof(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	previous := roundAvatarStateSnapshot{
		PlayerID:   "hider",
		PositionX:  -10,
		PositionY:  0.05,
		PositionZ:  -13.4,
		Yaw:        90,
		Pitch:      0,
		Pose:       "standing",
		Sequence:   2,
		OccurredAt: now,
	}
	crossBuilding := avatarStateCommand{
		PositionX: 10,
		PositionY: 0.05,
		PositionZ: -13.4,
		Yaw:       90,
		Pitch:     0,
		Pose:      "standing",
	}
	if err := validateAvatarMotion(
		"hider",
		"hider",
		previous,
		crossBuilding,
		now.Add(2*time.Second),
	); err == nil {
		t.Fatal("accepted movement swept through Building02")
	}

	pitchSpoof := avatarStateCommand{
		PositionX: previous.PositionX,
		PositionY: previous.PositionY,
		PositionZ: previous.PositionZ,
		Yaw:       previous.Yaw,
		Pitch:     maximumAvatarPitch,
		Pose:      "standing",
	}
	if err := validateAvatarMotion(
		"hider",
		"hider",
		previous,
		pitchSpoof,
		now.Add(time.Millisecond),
	); err == nil {
		t.Fatal("accepted a client pitch spike beyond the server rotation envelope")
	}
}

func TestAvatarStateRejectsUnassignedInitialSpawn(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates:       make(map[string]roundAvatarStateSnapshot),
	}
	spawn := officialSpawnForPlayer("hider", "hider")
	command := avatarStateCommand{
		PositionX: spawn[0] + maximumInitialSpawnDistance + 1,
		PositionY: spawn[1],
		PositionZ: spawn[2],
		Yaw:       180,
		Pose:      "standing",
	}
	if _, err := state.applyAvatarState(
		"hider",
		command,
		round.StartedAt.Add(time.Second),
	); err == nil {
		t.Fatal("accepted an initial position outside the assigned role spawn")
	}
}

func TestFireTargetRequiresRecentHunterAndRetainsLastHiderState(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	now := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	authoritative.Advance(now)
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates: map[string]roundAvatarStateSnapshot{
			"hunter": {
				RoundID:    round.ID,
				PlayerID:   "hunter",
				PositionX:  -7,
				PositionY:  0.05,
				PositionZ:  0,
				Yaw:        90,
				Sequence:   2,
				OccurredAt: now,
			},
			"hider": {
				RoundID:    round.ID,
				PlayerID:   "hider",
				PositionX:  -5,
				PositionY:  0.05,
				PositionZ:  0,
				Sequence:   4,
				OccurredAt: now,
			},
		},
	}
	command := hunterFireCommand{
		CommandID:      "validated-target",
		TargetPlayerID: "hider",
	}
	if authorized := state.authorizeFireTarget("hunter", command, now); authorized.TargetPlayerID != "hider" {
		t.Fatalf("recent in-range target was removed: %#v", authorized)
	}

	far := state.AvatarStates["hider"]
	far.PositionX = maximumHunterFireRange + 1
	state.AvatarStates["hider"] = far
	if authorized := state.authorizeFireTarget("hunter", command, now); authorized.TargetPlayerID != "" {
		t.Fatalf("out-of-range target was authorized: %#v", authorized)
	}

	stale := far
	stale.PositionX = -5
	stale.OccurredAt = now.Add(-maximumFireAvatarAge)
	state.AvatarStates["hider"] = stale
	if authorized := state.authorizeFireTarget(
		"hunter",
		command,
		now.Add(time.Nanosecond),
	); authorized.TargetPlayerID != "hider" {
		t.Fatalf("last accepted Hider state stopped being targetable: %#v", authorized)
	}

	staleHunter := state.AvatarStates["hunter"]
	staleHunter.OccurredAt = now.Add(-maximumFireAvatarAge)
	state.AvatarStates["hunter"] = staleHunter
	if authorized := state.authorizeFireTarget(
		"hunter",
		command,
		now.Add(time.Nanosecond),
	); authorized.TargetPlayerID != "" {
		t.Fatalf("stale Hunter state was authorized: %#v", authorized)
	}

	delete(state.AvatarStates, "hunter")
	if authorized := state.authorizeFireTarget("hunter", command, now); authorized.TargetPlayerID != "" {
		t.Fatalf("target without Hunter position was authorized: %#v", authorized)
	}
}

func TestFireTargetRequiresPitchAwareTargetIntersectionAndStaticLOS(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	now := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	authoritative.Advance(now)
	hunter := roundAvatarStateSnapshot{
		RoundID:    round.ID,
		PlayerID:   "hunter",
		PositionX:  -6,
		PositionY:  0.05,
		Yaw:        0,
		Pitch:      0,
		Pose:       "standing",
		Sequence:   1,
		OccurredAt: now,
	}
	// Elevated, but still inside the arena. The arena has a ceiling at 3.6 m, so
	// a target above that is unreachable and unshootable by construction; this
	// case is about pitch, not about firing through the roof.
	elevatedTarget := roundAvatarStateSnapshot{
		RoundID:    round.ID,
		PlayerID:   "hider",
		PositionX:  -6,
		PositionY:  2,
		PositionZ:  4,
		Pose:       "standing",
		Sequence:   1,
		OccurredAt: now,
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates: map[string]roundAvatarStateSnapshot{
			"hunter": hunter,
			"hider":  elevatedTarget,
		},
	}
	command := hunterFireCommand{
		CommandID:      "pitch-aware-shot",
		TargetPlayerID: "hider",
	}
	if authorized := state.authorizeFireTarget(
		"hunter",
		command,
		now,
	); authorized.TargetPlayerID != "" {
		t.Fatal("horizontal aim hit an elevated target")
	}

	hunter.Pitch = -math.Atan2(
		elevatedTarget.PositionY+
			authorityTargetHeight*0.5-
			(hunter.PositionY+authorityPlayerStandingEyeY),
		elevatedTarget.PositionZ-hunter.PositionZ,
	) * 180 / math.Pi
	state.AvatarStates["hunter"] = hunter
	if authorized := state.authorizeFireTarget(
		"hunter",
		command,
		now,
	); authorized.TargetPlayerID != "hider" {
		t.Fatalf("pitch-aligned target was rejected: %#v", authorized)
	}

	hunter.PositionX = 0
	hunter.PositionY = 0.05
	hunter.PositionZ = 0
	hunter.Yaw = 90
	hunter.Pitch = 0
	blockedTarget := elevatedTarget
	blockedTarget.PositionX = 4
	blockedTarget.PositionY = 0.05
	blockedTarget.PositionZ = 0
	state.AvatarStates["hunter"] = hunter
	state.AvatarStates["hider"] = blockedTarget
	blocked := state.authorizeFireTarget("hunter", command, now)
	result, discovery := authoritative.HandleFire("hunter", blocked, now)
	if !result.Accepted ||
		result.Hit ||
		result.Reason != "miss" ||
		result.TargetPlayerID != "" ||
		result.ShellsRemaining != round.ShellLimit-1 ||
		discovery != nil {
		t.Fatalf("occluded shot was not an ammo-consuming miss: %#v", result)
	}
}

func TestAnswerCheckAvatarAuthorityRemainsWithOriginalHunter(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	authoritative.Advance(huntStarted)
	originalHunterID := round.RoleAssignments[0].PlayerID
	convertedHiderID := round.RoleAssignments[1].PlayerID
	survivingHiderID := round.RoleAssignments[2].PlayerID
	authoritative.HandleFire(
		originalHunterID,
		hunterFireCommand{
			CommandID:      "convert",
			TargetPlayerID: convertedHiderID,
		},
		huntStarted,
	)
	authoritative.BeginAnswerCheck(
		"hiders",
		"hunt_timeout",
		huntStarted.Add(time.Second),
	)
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates:       initializeRoundAvatarStates(&round, authoritative),
	}
	spawn := officialSpawnForPlayer(originalHunterID, "hunter")
	command := avatarStateCommand{
		PositionX: spawn[0],
		PositionY: spawn[1],
		PositionZ: spawn[2],
		Pose:      "running",
	}
	snapshot, err := state.applyAvatarState(
		originalHunterID,
		command,
		huntStarted.Add(2*time.Second),
	)
	if err != nil ||
		snapshot.Role != "hunter" ||
		snapshot.Status != "active" {
		t.Fatalf("original Hunter lost Answer Check movement authority: %#v, %v", snapshot, err)
	}
	if _, err := state.applyAvatarState(
		convertedHiderID,
		command,
		huntStarted.Add(2*time.Second),
	); err == nil {
		t.Fatal("converted original Hider retained movement authority in Answer Check")
	}
	if _, err := state.applyAvatarState(
		survivingHiderID,
		command,
		huntStarted.Add(2*time.Second),
	); err == nil {
		t.Fatal("surviving Hider retained movement authority in Answer Check")
	}
}

func TestInfectionAvatarVisibilityHidesActiveHidersFromOneAnother(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	senderID := round.RoleAssignments[1].PlayerID
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		Presences: map[string]lobbyPresence{
			"hunter-session": {
				PlayerID: round.RoleAssignments[0].PlayerID,
				Presence: testPresence{sessionID: "hunter-session"},
			},
			"sender-session": {
				PlayerID: senderID,
				Presence: testPresence{sessionID: "sender-session"},
			},
			"other-hider-session": {
				PlayerID: round.RoleAssignments[2].PlayerID,
				Presence: testPresence{sessionID: "other-hider-session"},
			},
			"spectator-session": {
				PlayerID: "01900000-0000-7000-8000-000000000199",
				Presence: testPresence{sessionID: "spectator-session"},
			},
		},
	}
	snapshot := roundAvatarStateSnapshot{
		RoundID:  round.ID,
		PlayerID: senderID,
		Role:     "hider",
	}

	authoritative.Advance(round.StartedAt.Add(casualPreparingDuration))
	hidingRecipients, restricted := avatarStateRecipients(state, snapshot)
	if !restricted {
		t.Fatal("Infection Hider state was unrestricted during Hiding")
	}
	if sessions := sortedPresenceSessions(hidingRecipients); len(sessions) != 2 ||
		sessions[0] != "sender-session" ||
		sessions[1] != "spectator-session" {
		t.Fatalf("unexpected Infection Hiding recipients: %#v", sessions)
	}

	authoritative.Advance(
		round.StartedAt.Add(casualPreparingDuration + 10*time.Second),
	)
	huntingRecipients, restricted := avatarStateRecipients(state, snapshot)
	if !restricted {
		t.Fatal("Infection Hider state was unrestricted during Hunting")
	}
	if sessions := sortedPresenceSessions(huntingRecipients); len(sessions) != 3 ||
		sessions[0] != "hunter-session" ||
		sessions[1] != "sender-session" ||
		sessions[2] != "spectator-session" {
		t.Fatalf("unexpected Infection Hunting recipients: %#v", sessions)
	}
}

func sortedPresenceSessions(presences []runtime.Presence) []string {
	sessions := make([]string, 0, len(presences))
	for _, presence := range presences {
		sessions = append(sessions, presence.GetSessionId())
	}
	sort.Strings(sessions)
	return sessions
}
