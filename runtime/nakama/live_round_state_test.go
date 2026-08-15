package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestLiveRoundCheckpointRehydratesPrivateAuthoritativeState(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	round.MapVersionID = "019fab2b-c400-7000-8000-000000000002"
	round.MapContentVersion = defaultOfficialMapContentVersion
	round.RoleAssignments[0].DisplayName = "Hunter Prime"
	round.RoleAssignments[1].DisplayName = "Copper Ghost"
	round.RoleAssignments[2].DisplayName = "Violet Ghost"
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	hunterID := round.RoleAssignments[0].PlayerID
	convertedID := round.RoleAssignments[1].PlayerID
	survivingID := round.RoleAssignments[2].PlayerID
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	authoritative.Advance(huntStarted)

	state := &persistentLobbyState{
		Round:                 &round,
		AuthoritativeRound:    authoritative,
		AvatarStates:          initializeRoundAvatarStates(&round, authoritative),
		ReconnectReservations: make(map[string]roundReconnectReservation),
	}
	if _, err := state.initializeScoreCache(huntStarted); err != nil {
		t.Fatalf("initialize score cache: %v", err)
	}
	avatar := state.AvatarStates[hunterID]
	if _, err := state.applyAvatarState(
		hunterID,
		avatarStateCommand{
			PositionX: avatar.PositionX + 1,
			PositionY: avatar.PositionY,
			PositionZ: avatar.PositionZ,
			Yaw:       avatar.Yaw + 5,
			Pitch:     -12,
			BodyR:     avatar.BodyR,
			BodyG:     avatar.BodyG,
			BodyB:     avatar.BodyB,
			AccentR:   avatar.AccentR,
			AccentG:   avatar.AccentG,
			AccentB:   avatar.AccentB,
			Pose:      "aiming",
		},
		huntStarted.Add(time.Second),
	); err != nil {
		t.Fatalf("record authoritative Hunter avatar: %v", err)
	}
	fire, discovery := authoritative.HandleFire(
		hunterID,
		hunterFireCommand{
			CommandID:      "checkpoint-conversion",
			TargetPlayerID: convertedID,
		},
		huntStarted.Add(2*time.Second),
	)
	if !fire.Hit || discovery == nil || !discovery.CausedInfectionConversion {
		t.Fatalf("prepare Infection conversion: %#v, %#v", fire, discovery)
	}
	convertedMiss, convertedDiscovery := authoritative.HandleFire(
		convertedID,
		hunterFireCommand{CommandID: "checkpoint-miss"},
		huntStarted.Add(3*time.Second),
	)
	if !convertedMiss.Accepted || convertedMiss.Hit || convertedDiscovery != nil {
		t.Fatalf("prepare converted Hunter command cache: %#v", convertedMiss)
	}
	authoritative.BeginAnswerCheck(
		"hiders",
		"hunt_timeout",
		huntStarted.Add(4*time.Second),
	)
	authoritative.Apply(&round)
	like := authoritative.HandleLike(
		hunterID,
		answerCheckLikeCommand{
			CommandID:           "checkpoint-like",
			TargetHiderPlayerID: survivingID,
		},
		authoritative.TerminalAt.Add(time.Second),
	)
	if !like.Accepted {
		t.Fatalf("prepare Answer Check like: %#v", like)
	}
	finalScore, err := authoritative.ScoreSnapshot(&round, authoritative.TerminalAt)
	if err != nil {
		t.Fatalf("prepare final score cache: %v", err)
	}
	state.cacheFinalScore(finalScore)
	if !state.reserveReconnect(convertedID, authoritative.TerminalAt.Add(2*time.Second)) {
		t.Fatal("prepare reconnect reservation")
	}

	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		t.Fatalf("encode live checkpoint: %v", err)
	}
	checkpoint, err := decodeLiveRoundCheckpoint(payload, &round)
	if err != nil {
		t.Fatalf("decode live checkpoint: %v", err)
	}
	rehydrated := &persistentLobbyState{}
	storedAt := authoritative.TerminalAt.Add(3 * time.Second)
	applyLiveRoundCheckpoint(rehydrated, &round, checkpoint, storedAt)

	converted, available := rehydrated.AuthoritativeRound.PlayerState(convertedID)
	if !available ||
		converted.InitialRole != "hider" ||
		converted.Role != "hunter" ||
		converted.Status != "converted" ||
		converted.DisplayName != "Copper Ghost" {
		t.Fatalf("conversion identity was not rehydrated: %#v", converted)
	}
	convertedHunter := rehydrated.AuthoritativeRound.Hunters[convertedID]
	if convertedHunter == nil ||
		convertedHunter.ShellsRemaining != round.ShellLimit-1 ||
		convertedHunter.ReloadUntil.IsZero() ||
		convertedHunter.Commands["checkpoint-miss"].Reason != "miss" {
		t.Fatalf("ammo, reload, or fire idempotency was not rehydrated: %#v", convertedHunter)
	}
	if len(rehydrated.AuthoritativeRound.Discoveries) != 1 ||
		len(rehydrated.AuthoritativeRound.Likes) != 1 ||
		rehydrated.AuthoritativeRound.Likes[hunterID].TargetHiderPlayerID != survivingID {
		t.Fatalf("discovery or like state was not rehydrated: %#v", rehydrated.AuthoritativeRound)
	}
	rehydratedAvatar := rehydrated.AvatarStates[hunterID]
	if rehydratedAvatar.Sequence != 2 ||
		rehydratedAvatar.Pose != "aiming" ||
		rehydratedAvatar.Pitch != -12 ||
		rehydratedAvatar.DisplayName != "Hunter Prime" {
		t.Fatalf("avatar state was not rehydrated: %#v", rehydratedAvatar)
	}
	if rehydrated.CachedScore == nil ||
		!rehydrated.CachedScore.Final ||
		rehydrated.CachedScore.BatchSequence != state.ScoreBatchSequence ||
		len(rehydrated.CachedScore.Entries) != round.HidersTotal {
		t.Fatalf("score cache was not rehydrated: %#v", rehydrated.CachedScore)
	}
	reservation := rehydrated.ReconnectReservations[convertedID]
	if reservation.RoundID != round.ID ||
		!reservation.ExpiresAt.Equal(
			authoritative.TerminalAt.
				Add(2*time.Second).
				Add(reconnectReservationDuration),
		) {
		t.Fatalf("reconnect reservation was not rehydrated: %#v", reservation)
	}
	if rehydrated.LiveStateDirty ||
		!rehydrated.LiveStatePersistedAt.Equal(storedAt) {
		t.Fatalf("checkpoint persistence cursor was not restored: %#v", rehydrated)
	}
}

func TestLiveRoundCheckpointRejectsDifferentAuthorityGeometry(t *testing.T) {
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
	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		t.Fatalf("encode live checkpoint: %v", err)
	}
	var checkpoint liveRoundCheckpoint
	if err := json.Unmarshal(payload, &checkpoint); err != nil {
		t.Fatalf("decode checkpoint fixture: %v", err)
	}
	checkpoint.AuthorityGeometryDigest = "sha256:stale"
	payload, err = json.Marshal(checkpoint)
	if err != nil {
		t.Fatalf("encode stale geometry checkpoint: %v", err)
	}
	if _, err := decodeLiveRoundCheckpoint(payload, &round); err == nil {
		t.Fatal("accepted a checkpoint from different authority geometry")
	}
}

func TestLiveRoundCheckpointRejectsMissingAvatarState(t *testing.T) {
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
	delete(state.AvatarStates, "hider")
	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		t.Fatalf("encode malformed live checkpoint fixture: %v", err)
	}
	if _, err := decodeLiveRoundCheckpoint(payload, &round); err == nil {
		t.Fatal("accepted a live checkpoint that would make a participant untargetable")
	}
}

func TestLiveRoundCheckpointAllowsPostgresTimestampRounding(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	round.StartedAt = round.StartedAt.Add(600 * time.Nanosecond)
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		AvatarStates:       initializeRoundAvatarStates(&round, authoritative),
	}
	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		t.Fatalf("encode live checkpoint: %v", err)
	}
	durableRound := round
	durableRound.StartedAt = round.StartedAt.Round(time.Microsecond)
	if _, err := decodeLiveRoundCheckpoint(payload, &durableRound); err != nil {
		t.Fatalf("PostgreSQL timestamp precision invalidated checkpoint: %v", err)
	}
}

func TestLiveRoundCheckpointWriteRejectsStaleCAS(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	roundID := "01900000-0000-7000-8000-000000000001"
	expected := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	updated := expected.Add(time.Second)
	mock.ExpectExec("INSERT INTO game.round_live_checkpoint").
		WithArgs(
			roundID,
			liveRoundCheckpointFormatVersion,
			`{"version":1}`,
			updated,
			expected,
		).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err = persistLiveRoundCheckpoint(
		context.Background(),
		database,
		roundID,
		[]byte(`{"version":1}`),
		expected,
		updated,
	)
	if !errors.Is(err, errLiveRoundCheckpointWriteRejected) {
		t.Fatalf("stale checkpoint CAS returned %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestCompletedRoundHeartbeatDoesNotRecreateCheckpointOrKillMatch(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	authoritative.BeginAnswerCheck(
		"hiders",
		"hunt_timeout",
		round.StartedAt.Add(20*time.Second),
	)
	authoritative.Phase = "completed"
	authoritative.Apply(&round)
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		LiveStateDirty:     true,
	}
	match := &persistentLobbyMatch{}
	if err := match.persistLiveRoundState(
		context.Background(),
		state,
		round.StartedAt.Add(time.Minute),
		true,
	); err != nil {
		t.Fatalf("completed round heartbeat attempted persistence: %v", err)
	}
	if state.LiveStateDirty {
		t.Fatal("completed round retained a checkpoint-dirty marker")
	}
}
