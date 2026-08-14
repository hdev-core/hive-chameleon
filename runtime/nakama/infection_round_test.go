package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestInfectionRoundConvertsHidersIntoAuthoritativeHunters(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)

	first, conversion := state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "convert-1",
			TargetPlayerID: round.RoleAssignments[1].PlayerID,
		},
		huntStarted,
	)
	if !first.Hit ||
		conversion == nil ||
		!conversion.CausedInfectionConversion ||
		first.RoundIsTerminal {
		t.Fatalf("unexpected first Infection conversion: %#v, %#v", first, conversion)
	}
	convertedID := round.RoleAssignments[1].PlayerID
	convertedState, available := state.PlayerState(convertedID)
	if !available ||
		convertedState.InitialRole != "hider" ||
		convertedState.Role != "hunter" ||
		convertedState.Status != "converted" ||
		convertedState.ShellsRemaining != round.ShellLimit {
		t.Fatalf("converted Hider did not receive Hunter authority: %#v", convertedState)
	}

	second, finalConversion := state.HandleFire(
		convertedID,
		hunterFireCommand{
			CommandID:      "convert-2",
			TargetPlayerID: round.RoleAssignments[2].PlayerID,
		},
		huntStarted.Add(time.Second),
	)
	if !second.Hit ||
		!second.RoundIsTerminal ||
		finalConversion == nil ||
		finalConversion.HunterPlayerID != convertedID ||
		!finalConversion.CausedInfectionConversion {
		t.Fatalf("converted Hunter could not finish the round: %#v, %#v", second, finalConversion)
	}
	if state.WinningSide != "hunters" ||
		state.CompletionReason != "all_hiders_found" ||
		state.Phase != "answer_check" {
		t.Fatalf("unexpected Infection terminal state: %#v", state)
	}
	terminalSpectator := state.SpectatorState(convertedID)
	if !terminalSpectator.Eligible ||
		terminalSpectator.Reason != "answer_check_hider" ||
		len(terminalSpectator.Players) != 3 {
		t.Fatalf(
			"converted participant did not receive terminal spectator state: %#v",
			terminalSpectator,
		)
	}
}

func TestInfectionTerminalResultPreservesInitialAndFinalRoles(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "convert-1",
			TargetPlayerID: round.RoleAssignments[1].PlayerID,
		},
		huntStarted,
	)
	state.HandleFire(
		round.RoleAssignments[1].PlayerID,
		hunterFireCommand{
			CommandID:      "convert-2",
			TargetPlayerID: round.RoleAssignments[2].PlayerID,
		},
		huntStarted.Add(time.Second),
	)
	state.Apply(&round)

	result, err := buildAuthoritativeTerminalResult(&round, state)
	if err != nil {
		t.Fatalf("build Infection terminal result: %v", err)
	}
	converted := 0
	for _, participant := range result.Participants {
		if participant.InitialRole == "hider" {
			if participant.FinalRole != "hunter" ||
				participant.Outcome != "hider_converted" {
				t.Fatalf("conversion lineage was lost: %#v", participant)
			}
			converted++
		}
	}
	if converted != 2 {
		t.Fatalf("converted participant count = %d, expected 2", converted)
	}
	for _, discovery := range result.Discoveries {
		if !discovery.CausedInfectionConversion {
			t.Fatalf("Infection discovery lost conversion marker: %#v", discovery)
		}
	}
}

func TestHunterFireOnlyHitsAnActiveHiderPlayer(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	hunterID := round.RoleAssignments[0].PlayerID
	hiderID := round.RoleAssignments[1].PlayerID

	hunterTarget, discovery := state.HandleFire(
		hunterID,
		hunterFireCommand{
			CommandID:      "hunter-target",
			TargetPlayerID: hunterID,
		},
		huntStarted,
	)
	if !hunterTarget.Accepted ||
		hunterTarget.Hit ||
		hunterTarget.Reason != "miss" ||
		discovery != nil {
		t.Fatalf("targeting a Hunter was not an accepted miss: %#v", hunterTarget)
	}
	firstHit, discovery := state.HandleFire(
		hunterID,
		hunterFireCommand{
			CommandID:      "active-hider",
			TargetPlayerID: hiderID,
		},
		huntStarted.Add(100*time.Millisecond),
	)
	if !firstHit.Hit || discovery == nil {
		t.Fatalf("active Hider target was not discovered: %#v", firstHit)
	}
	convertedTarget, discovery := state.HandleFire(
		hunterID,
		hunterFireCommand{
			CommandID:      "converted-target",
			TargetPlayerID: hiderID,
		},
		huntStarted.Add(200*time.Millisecond),
	)
	if !convertedTarget.Accepted ||
		convertedTarget.Hit ||
		convertedTarget.Reason != "miss" ||
		discovery != nil {
		t.Fatalf("converted Hider was not treated as a miss: %#v", convertedTarget)
	}
}

func TestInfectionTimeoutPreservesConversionAndScoresFinalSurvivor(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	hunterID := round.RoleAssignments[0].PlayerID
	convertedID := round.RoleAssignments[1].PlayerID
	survivorID := round.RoleAssignments[2].PlayerID
	state.HandleFire(
		hunterID,
		hunterFireCommand{
			CommandID:      "convert-before-timeout",
			TargetPlayerID: convertedID,
		},
		huntStarted.Add(time.Second),
	)

	spectator := state.SpectatorState(
		"01900000-0000-7000-8000-000000000199",
	)
	if !spectator.Eligible ||
		len(spectator.Players) != 3 ||
		spectator.Players[1].PlayerID != convertedID ||
		spectator.Players[1].Role != "hunter" ||
		spectator.Players[1].Status != "converted" {
		t.Fatalf("spectator missed authoritative Infection conversion: %#v", spectator)
	}
	converted := state.SpectatorState(convertedID)
	if converted.Eligible {
		t.Fatalf("active converted Hunter became a spectator: %#v", converted)
	}

	phases := state.Advance(huntStarted.Add(30 * time.Second))
	if len(phases) != 1 || phases[0] != "answer_check" {
		t.Fatalf("Infection timeout did not enter Answer Check: %#v", phases)
	}
	if state.WinningSide != "hiders" ||
		state.CompletionReason != "hunt_timeout" ||
		len(state.FoundHiders) != 1 {
		t.Fatalf("unexpected Infection timeout outcome: %#v", state)
	}
	state.Apply(&round)
	snapshot, err := state.ScoreSnapshot(&round, state.TerminalAt)
	if err != nil {
		t.Fatalf("build Infection scoreboard: %v", err)
	}
	if len(snapshot.Entries) != 2 {
		t.Fatalf(
			"Infection scoreboard entry count = %d, expected the two initial Hiders: %#v",
			len(snapshot.Entries),
			snapshot.Entries,
		)
	}
	for _, entry := range snapshot.Entries {
		if entry.PlayerID == hunterID {
			t.Fatalf("initial Hunter appeared in the Infection scoreboard: %#v", entry)
		}
	}
	if snapshot.Entries[0].PlayerID != survivorID &&
		snapshot.Entries[1].PlayerID != survivorID {
		t.Fatalf("surviving Hider is absent from the Infection scoreboard: %#v", snapshot)
	}
	if snapshot.Entries[0].PlayerID != convertedID &&
		snapshot.Entries[1].PlayerID != convertedID {
		t.Fatalf("converted initial Hider lost their scoreboard entry: %#v", snapshot)
	}
	score, err := state.Score(&round, survivorID)
	if err != nil {
		t.Fatalf("score final Infection survivor: %v", err)
	}
	var breakdown struct {
		SurvivedTimeout        int `json:"survived_timeout"`
		InfectionFinalSurvivor int `json:"infection_final_survivor"`
	}
	if err := json.Unmarshal(score.Breakdown, &breakdown); err != nil {
		t.Fatalf("decode Infection score: %v", err)
	}
	if breakdown.SurvivedTimeout != 500 ||
		breakdown.InfectionFinalSurvivor != 250 {
		t.Fatalf("final Infection survivor bonuses are invalid: %#v", breakdown)
	}

	answerCheck := state.AnswerCheck(nil)
	if len(answerCheck.Reveals) != 2 ||
		answerCheck.Reveals[0].Cue != "converted" ||
		answerCheck.Reveals[0].Role != "hunter" ||
		answerCheck.Reveals[1].Cue != "survived" ||
		answerCheck.Reveals[1].Role != "hider" {
		t.Fatalf("Infection Answer Check reveal is invalid: %#v", answerCheck)
	}
}

func TestFinalizeInfectionRoundQueuesCompleteTerminalEvidence(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "convert-first",
			TargetPlayerID: round.RoleAssignments[1].PlayerID,
		},
		huntStarted,
	)
	state.HandleFire(
		round.RoleAssignments[1].PlayerID,
		hunterFireCommand{
			CommandID:      "convert-final",
			TargetPlayerID: round.RoleAssignments[2].PlayerID,
		},
		huntStarted.Add(time.Second),
	)
	state.Apply(&round)

	store := &recordingTerminalRoundStore{}
	outcome, err := finalizeAuthoritativeRound(
		context.Background(),
		store,
		&round,
		state,
	)
	if err != nil {
		t.Fatalf("finalize Infection round: %v", err)
	}
	if outcome != terminalResultCommitted ||
		round.Status != "completed" ||
		round.ResultRevisionID == "" ||
		len(store.input.Participants) != 3 ||
		len(store.input.Discoveries) != 2 {
		t.Fatalf("Infection terminal result bundle is invalid: %#v", store.input)
	}
	if _, err := validateTerminalResult(store.input); err != nil {
		t.Fatalf("validate Infection terminal bundle: %v", err)
	}
}

func infectionRoundFixture() roundSnapshot {
	startedAt := time.Date(2026, time.July, 28, 15, 0, 0, 0, time.UTC)
	arena := defaultOfficialArenaTestDefinition()
	return roundSnapshot{
		ID:                       "01900000-0000-7000-8000-000000000101",
		SequenceNumber:           2,
		Mode:                     "infection",
		MapSlug:                  arena.Slug,
		MapContentVersion:        arena.ContentVersion,
		GameServerBuildVersion:   gameServerBuildVersion,
		ProtocolVersion:          matchProtocolVersion,
		AuthorityGeometryVersion: arena.Geometry.Version,
		AuthorityGeometryDigest:  arena.GeometryDigest,
		Status:                   "preparing",
		StartedAt:                startedAt,
		HidersTotal:              2,
		HidersRemaining:          2,
		DiscoveredHiderPlayerIDs: make([]string, 0),
		HidingDurationSeconds:    10,
		HuntingDurationSeconds:   30,
		ShellLimit:               3,
		ReloadDurationMS:         100,
		RoleAssignments: []roundRoleAssignment{
			{
				RoundID:  "01900000-0000-7000-8000-000000000101",
				PlayerID: "01900000-0000-7000-8000-000000000111",
				Role:     "hunter",
			},
			{
				RoundID:  "01900000-0000-7000-8000-000000000101",
				PlayerID: "01900000-0000-7000-8000-000000000112",
				Role:     "hider",
			},
			{
				RoundID:  "01900000-0000-7000-8000-000000000101",
				PlayerID: "01900000-0000-7000-8000-000000000113",
				Role:     "hider",
			},
		},
	}
}
