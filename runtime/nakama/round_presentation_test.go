package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestAnswerCheckLikeIsEligibleNonSelfAndIdempotent(t *testing.T) {
	t.Parallel()

	round, state := completedCasualRoundFixture(t)
	hunterID := round.RoleAssignments[0].PlayerID
	hiderID := round.RoleAssignments[1].PlayerID
	now := state.TerminalAt.Add(time.Second)

	self := state.HandleLike(
		hiderID,
		answerCheckLikeCommand{
			CommandID:           "like-self",
			TargetHiderPlayerID: hiderID,
		},
		now,
	)
	if self.Accepted || self.Reason != "cannot_like_self" {
		t.Fatalf("self-like was not rejected: %#v", self)
	}
	accepted := state.HandleLike(
		hunterID,
		answerCheckLikeCommand{
			CommandID:           "like-1",
			TargetHiderPlayerID: hiderID,
		},
		now,
	)
	if !accepted.Accepted || accepted.Reason != "accepted" {
		t.Fatalf("eligible like was rejected: %#v", accepted)
	}
	replay := state.HandleLike(
		hunterID,
		answerCheckLikeCommand{
			CommandID:           "like-1",
			TargetHiderPlayerID: hiderID,
		},
		now.Add(time.Second),
	)
	if replay != accepted || len(state.Likes) != 1 {
		t.Fatalf("like replay changed its result: %#v, %#v", replay, state.Likes)
	}
	second := state.HandleLike(
		hunterID,
		answerCheckLikeCommand{
			CommandID:           "like-2",
			TargetHiderPlayerID: hiderID,
		},
		now.Add(time.Second),
	)
	if second.Accepted || second.Reason != "already_liked" {
		t.Fatalf("second like was not rejected: %#v", second)
	}

	score, err := state.Score(&round, hiderID)
	if err != nil {
		t.Fatalf("score liked Hider: %v", err)
	}
	var breakdown struct {
		DisguiseLikes int `json:"disguise_likes"`
	}
	if err := json.Unmarshal(score.Breakdown, &breakdown); err != nil {
		t.Fatalf("decode score breakdown: %v", err)
	}
	if breakdown.DisguiseLikes != 100 {
		t.Fatalf("like score = %d, expected 100", breakdown.DisguiseLikes)
	}
}

func TestAnswerCheckHoldsForRevealWindowBeforeCommit(t *testing.T) {
	t.Parallel()

	_, state := completedCasualRoundFixture(t)
	if state.ReadyToCommit(state.PhaseDeadline.Add(-time.Nanosecond)) {
		t.Fatal("round became committable before Answer Check deadline")
	}
	if !state.ReadyToCommit(state.PhaseDeadline) {
		t.Fatal("round did not become committable at Answer Check deadline")
	}
	closed := state.HandleLike(
		"01900000-0000-7000-8000-000000000011",
		answerCheckLikeCommand{
			CommandID:           "late-like",
			TargetHiderPlayerID: "01900000-0000-7000-8000-000000000013",
		},
		state.PhaseDeadline.Add(time.Nanosecond),
	)
	if closed.Accepted || closed.Reason != "answer_check_closed" {
		t.Fatalf("late like was not rejected: %#v", closed)
	}
}

func TestSpectatorVisibilityIsPrivateToEligibleViewers(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	round.RoleAssignments[0].PlayerID =
		"01900000-0000-7000-8000-000000000011"
	round.RoleAssignments[1].PlayerID =
		"01900000-0000-7000-8000-000000000013"
	round.RoleAssignments = append(round.RoleAssignments, roundRoleAssignment{
		RoundID:  round.ID,
		PlayerID: "01900000-0000-7000-8000-000000000015",
		Role:     "hider",
	})
	round.HidersTotal = 2
	round.HidersRemaining = 2
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create round: %v", err)
	}
	active := state.SpectatorState(round.RoleAssignments[0].PlayerID)
	if active.Eligible || len(active.VisibleHiderPlayerIDs) != 0 {
		t.Fatalf("active Hunter received spectator visibility: %#v", active)
	}
	joined := state.SpectatorState(
		"01900000-0000-7000-8000-000000000099",
	)
	if !joined.Eligible ||
		joined.Reason != "joined_in_progress" ||
		len(joined.CameraModes) != 3 ||
		joined.Phase != "preparing" ||
		len(joined.VisibleHiderPlayerIDs) != 2 ||
		len(joined.Players) != 3 {
		t.Fatalf("join-in-progress spectator state is invalid: %#v", joined)
	}

	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	joined = state.SpectatorState(
		"01900000-0000-7000-8000-000000000099",
	)
	if joined.Phase != "hunting" ||
		len(joined.VisibleHiderPlayerIDs) != 2 ||
		len(joined.Players) != 3 {
		t.Fatalf("spectator did not receive authoritative Hunting state: %#v", joined)
	}
	state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "find",
			TargetPlayerID: round.RoleAssignments[1].PlayerID,
		},
		huntStarted,
	)
	found := state.SpectatorState(round.RoleAssignments[1].PlayerID)
	if !found.Eligible || found.Reason != "found_hider" {
		t.Fatalf("found Casual Hider did not become spectator: %#v", found)
	}
	state.BeginAnswerCheck("hiders", "test_terminal", huntStarted.Add(time.Second))
	answerCheckHunter := state.SpectatorState(round.RoleAssignments[0].PlayerID)
	if answerCheckHunter.Eligible ||
		answerCheckHunter.Reason != "answer_check_hunter" ||
		answerCheckHunter.Phase != "answer_check" ||
		len(answerCheckHunter.Players) != 0 {
		t.Fatalf(
			"original Hunter lost control during Answer Check: %#v",
			answerCheckHunter,
		)
	}
	answerCheckHider := state.SpectatorState(round.RoleAssignments[1].PlayerID)
	if !answerCheckHider.Eligible ||
		answerCheckHider.Reason != "answer_check_hider" ||
		answerCheckHider.Phase != "answer_check" ||
		len(answerCheckHider.Players) != 3 ||
		len(answerCheckHider.VisiblePlayerNameIDs) != 3 {
		t.Fatalf(
			"original Hider did not receive full Answer Check spectator state: %#v",
			answerCheckHider,
		)
	}
}

func TestAnswerCheckCarriesLastAuthoritativeHumanoidState(t *testing.T) {
	t.Parallel()

	round, state := completedCasualRoundFixture(t)
	hiderID := round.RoleAssignments[1].PlayerID
	occurredAt := state.TerminalAt.Add(-time.Second)
	answerCheck := state.AnswerCheck(map[string]roundAvatarStateSnapshot{
		hiderID: {
			RoundID:    round.ID,
			PlayerID:   hiderID,
			Role:       "hider",
			Status:     "active",
			PositionX:  8.5,
			PositionY:  1,
			PositionZ:  -3.25,
			Yaw:        135,
			BodyR:      0.2,
			BodyG:      0.3,
			BodyB:      0.4,
			AccentR:    0.7,
			AccentG:    0.8,
			AccentB:    0.9,
			Pose:       "crouching",
			Sequence:   7,
			OccurredAt: occurredAt,
		},
	})
	if len(answerCheck.Reveals) != 1 {
		t.Fatalf("Answer Check reveal count = %d, expected 1", len(answerCheck.Reveals))
	}
	reveal := answerCheck.Reveals[0]
	if reveal.PlayerID != hiderID ||
		reveal.Role != "hider" ||
		reveal.Status != "found" ||
		reveal.Cue != "found" ||
		!reveal.Found ||
		!reveal.AvatarStateAvailable ||
		reveal.PositionX != 8.5 ||
		reveal.PositionZ != -3.25 ||
		reveal.Pose != "crouching" ||
		reveal.AvatarSequence != 7 ||
		reveal.AvatarOccurredAt == nil ||
		!reveal.AvatarOccurredAt.Equal(occurredAt) {
		t.Fatalf("Answer Check humanoid reveal is invalid: %#v", reveal)
	}

	stale := state.AnswerCheck(map[string]roundAvatarStateSnapshot{
		hiderID: {
			RoundID:  "01900000-0000-7000-8000-000000000099",
			PlayerID: hiderID,
			Sequence: 8,
		},
	})
	if stale.Reveals[0].AvatarStateAvailable {
		t.Fatal("Answer Check accepted avatar state from another round")
	}
}

func TestAuthoritativeScoreBatchesUseThirtySecondCadenceAndFinalTransition(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	lobby := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
	}
	initial, err := lobby.initializeScoreCache(round.StartedAt)
	if err != nil {
		t.Fatalf("initialize score cache: %v", err)
	}
	if initial.Final ||
		initial.BatchSequence != 1 ||
		initial.Phase != "preparing" ||
		len(initial.Entries) != 1 ||
		initial.Entries[0].PlayerID != "hider" ||
		initial.Entries[0].Outcome != "in_progress" {
		t.Fatalf("initial provisional score is invalid: %#v", initial)
	}
	if lobby.scoreBatchDue(
		round.StartedAt.Add(liveScoreBatchInterval - time.Nanosecond),
	) {
		t.Fatal("score batch became due before 30 seconds")
	}
	batchAt := round.StartedAt.Add(liveScoreBatchInterval)
	authoritative.Advance(batchAt)
	if !lobby.scoreBatchDue(batchAt) {
		t.Fatal("score batch was not due at 30 seconds")
	}
	batch, err := lobby.refreshProvisionalScore(batchAt)
	if err != nil {
		t.Fatalf("refresh provisional score: %v", err)
	}
	if batch.Final ||
		batch.BatchSequence != 2 ||
		batch.Phase != "hunting" ||
		lobby.CachedScore == nil ||
		lobby.CachedScore.BatchSequence != batch.BatchSequence ||
		!lobby.NextScoreBatchAt.Equal(batchAt.Add(liveScoreBatchInterval)) {
		t.Fatalf("30-second score batch is invalid: %#v", batch)
	}
	hiderScore := batch.Entries[0]
	if hiderScore.PlayerID != "hider" ||
		hiderScore.Outcome != "in_progress" ||
		hiderScore.Total != "180.0000" {
		t.Fatalf("provisional survival score is invalid: %#v", hiderScore)
	}
	cachedSequence := lobby.CachedScore.BatchSequence
	if lobby.scoreBatchDue(batchAt.Add(time.Second)) ||
		lobby.CachedScore.BatchSequence != cachedSequence {
		t.Fatal("reconnect-time cache read would force an early score refresh")
	}

	authoritative.BeginAnswerCheck(
		"hiders",
		"hunt_timeout",
		round.StartedAt.Add(
			casualPreparingDuration+
				time.Duration(round.HidingDurationSeconds)*time.Second+
				time.Duration(round.HuntingDurationSeconds)*time.Second,
		),
	)
	authoritative.Apply(&round)
	final, err := authoritative.ScoreSnapshot(&round, authoritative.TerminalAt)
	if err != nil {
		t.Fatalf("compute final score: %v", err)
	}
	final = lobby.cacheFinalScore(final)
	if !final.Final ||
		final.BatchSequence != 3 ||
		final.Entries[0].Outcome != "hider_survived" ||
		!lobby.NextScoreBatchAt.IsZero() {
		t.Fatalf("final score transition is invalid: %#v", final)
	}
	closed := authoritative.HandleLike(
		round.RoleAssignments[0].PlayerID,
		answerCheckLikeCommand{
			CommandID:           "deadline-like",
			TargetHiderPlayerID: round.RoleAssignments[1].PlayerID,
		},
		authoritative.PhaseDeadline,
	)
	if closed.Accepted || closed.Reason != "answer_check_closed" {
		t.Fatalf("Answer Check deadline was not exclusive: %#v", closed)
	}
}

func TestTerminalResultIncludesLikesAndVersionedScores(t *testing.T) {
	t.Parallel()

	round, state := completedCasualRoundFixture(t)
	hunterID := round.RoleAssignments[0].PlayerID
	hiderID := round.RoleAssignments[1].PlayerID
	result := state.HandleLike(
		hunterID,
		answerCheckLikeCommand{
			CommandID:           "favorite",
			TargetHiderPlayerID: hiderID,
		},
		state.TerminalAt.Add(time.Second),
	)
	if !result.Accepted {
		t.Fatalf("fixture like was rejected: %#v", result)
	}
	terminal, err := buildAuthoritativeTerminalResult(&round, state)
	if err != nil {
		t.Fatalf("build terminal result: %v", err)
	}
	if len(terminal.Likes) != 1 ||
		terminal.Likes[0].VoterPlayerID != hunterID ||
		terminal.Likes[0].TargetHiderPlayerID != hiderID {
		t.Fatalf("terminal like evidence is invalid: %#v", terminal.Likes)
	}
	for _, participant := range terminal.Participants {
		if participant.FinalScore == "0.0000" ||
			len(participant.ScoreBreakdown) == 0 {
			t.Fatalf("participant score was not computed: %#v", participant)
		}
	}
}

func TestDecodeAnswerCheckLikeRejectsClientDeclaredOutcome(t *testing.T) {
	t.Parallel()

	if _, err := decodeAnswerCheckLikeCommand([]byte(
		`{"command_id":"like-1","target_hider_player_id":"01900000-0000-7000-8000-000000000013","accepted":true}`,
	)); err == nil {
		t.Fatal("accepted a client-declared like outcome")
	}
}
