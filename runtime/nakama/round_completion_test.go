package main

import (
	"bytes"
	"context"
	"testing"
	"time"
)

type recordingTerminalRoundStore struct {
	phase string
	input terminalResultCommit
}

func (s *recordingTerminalRoundStore) UpdateRoundPhase(
	_ context.Context,
	_ string,
	phase string,
) error {
	s.phase = phase
	return nil
}

func (s *recordingTerminalRoundStore) CommitTerminalResult(
	_ context.Context,
	input terminalResultCommit,
) (terminalResultCommitOutcome, error) {
	s.input = input
	return terminalResultCommitted, nil
}

func TestBuildCasualTerminalResultIsCanonicalAcrossRetries(t *testing.T) {
	t.Parallel()

	round, state := completedCasualRoundFixture(t)
	state.ReconnectedPlayers[round.RoleAssignments[1].PlayerID] = true
	first, err := buildAuthoritativeTerminalResult(&round, state)
	if err != nil {
		t.Fatalf("build first terminal result: %v", err)
	}
	second, err := buildAuthoritativeTerminalResult(&round, state)
	if err != nil {
		t.Fatalf("build replay terminal result: %v", err)
	}
	if !bytes.Equal(first.CanonicalCompleteResult, second.CanonicalCompleteResult) {
		t.Fatalf(
			"canonical bytes changed across retry:\n%s\n%s",
			first.CanonicalCompleteResult,
			second.CanonicalCompleteResult,
		)
	}
	if first.RevisionID != second.RevisionID ||
		first.Participants[0].ID != second.Participants[0].ID ||
		first.Participants[1].ID != second.Participants[1].ID ||
		first.Discoveries[0].ID != second.Discoveries[0].ID {
		t.Fatalf("terminal evidence IDs changed across retry: %#v, %#v", first, second)
	}
	if len(first.Participants) != 2 ||
		first.Participants[0].PlayerID !=
			"01900000-0000-7000-8000-000000000011" ||
		first.Participants[1].Outcome != "hider_found" ||
		!first.Participants[1].Reconnected ||
		!bytes.Contains(
			first.CanonicalCompleteResult,
			[]byte(`"reconnected":true`),
		) {
		t.Fatalf("unexpected terminal participants: %#v", first.Participants)
	}
	if first.Participants[1].SurvivalDurationMS == nil ||
		*first.Participants[1].SurvivalDurationMS != 1000 {
		t.Fatalf(
			"Hider survival duration was not measured from Hunt start: %#v",
			first.Participants[1].SurvivalDurationMS,
		)
	}
	if len(first.Discoveries) != 1 || len(first.Likes) != 0 {
		t.Fatalf("unexpected terminal evidence: %#v", first)
	}
}

func TestDeterministicTerminalUUIDsPreserveV7ShapeAndScope(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 29, 10, 0, 0, 0, time.UTC)
	first, err := deterministicUUIDV7(now, "round|participant|one")
	if err != nil {
		t.Fatalf("derive deterministic UUIDv7: %v", err)
	}
	replay, err := deterministicUUIDV7(now, "round|participant|one")
	if err != nil {
		t.Fatalf("replay deterministic UUIDv7: %v", err)
	}
	other, err := deterministicUUIDV7(now, "round|participant|two")
	if err != nil {
		t.Fatalf("derive scoped deterministic UUIDv7: %v", err)
	}
	if first != replay || first == other {
		t.Fatalf("deterministic UUIDv7 scope is invalid: %q, %q, %q", first, replay, other)
	}
	if _, err := canonicalUUIDV7ToCompact(first); err != nil {
		t.Fatalf("deterministic identifier is not canonical UUIDv7: %v", err)
	}
}

func TestFinalizeCasualRoundPersistsCanonicalResultAndCompletesPublicState(t *testing.T) {
	t.Parallel()

	round, state := completedCasualRoundFixture(t)
	store := &recordingTerminalRoundStore{}
	outcome, err := finalizeAuthoritativeRound(
		context.Background(),
		store,
		&round,
		state,
	)
	if err != nil {
		t.Fatalf("finalize Casual round: %v", err)
	}
	if outcome != terminalResultCommitted || store.phase != "answer_check" {
		t.Fatalf("unexpected terminal transition: %q, %q", outcome, store.phase)
	}
	if round.Status != "completed" ||
		round.ResultRevisionID == "" ||
		len(store.input.CanonicalCompleteResult) == 0 {
		t.Fatalf("unexpected completed public round: %#v", round.Public())
	}
}

func completedCasualRoundFixture(
	t *testing.T,
) (roundSnapshot, *authoritativeRoundState) {
	t.Helper()

	round := casualRoundFixture()
	round.RoleAssignments[0].PlayerID =
		"01900000-0000-7000-8000-000000000011"
	round.RoleAssignments[1].PlayerID =
		"01900000-0000-7000-8000-000000000013"
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual state: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	result, discovery := state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "terminal-shot",
			TargetPlayerID: round.RoleAssignments[1].PlayerID,
		},
		huntStarted.Add(time.Second),
	)
	if !result.RoundIsTerminal || discovery == nil {
		t.Fatalf("fixture did not reach terminal outcome: %#v", result)
	}
	state.Apply(&round)
	return round, state
}
