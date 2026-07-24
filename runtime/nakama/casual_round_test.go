package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestAssignCasualHidingSlotsKeepsTargetsPrivateAndUnique(t *testing.T) {
	t.Parallel()

	assignments := []roundRoleAssignment{
		{PlayerID: "hunter", Role: "hunter"},
		{PlayerID: "hider-a", Role: "hider"},
		{PlayerID: "hider-b", Role: "hider"},
	}
	targetSlots, err := assignCasualHidingSlots(
		assignments,
		bytes.NewReader(make([]byte, 32)),
	)
	if err != nil {
		t.Fatalf("assign Casual hiding slots: %v", err)
	}
	if targetSlots != 4 {
		t.Fatalf("target slot count = %d, expected 4", targetSlots)
	}
	if assignments[0].HidingSlot != 0 {
		t.Fatal("Hunter received a private Hider slot")
	}
	if assignments[1].HidingSlot < 1 ||
		assignments[2].HidingSlot < 1 ||
		assignments[1].HidingSlot == assignments[2].HidingSlot {
		t.Fatalf("Hider slots are invalid: %#v", assignments)
	}
}

func TestCasualRoundAdvancesFromPreparingToAuthoritativeTimeout(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	state, err := newCasualRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round state: %v", err)
	}
	if phases := state.Advance(round.StartedAt.Add(time.Second)); len(phases) != 0 {
		t.Fatalf("round advanced before preparing deadline: %#v", phases)
	}
	phases := state.Advance(round.StartedAt.Add(casualPreparingDuration))
	if len(phases) != 1 || phases[0] != "hiding" {
		t.Fatalf("unexpected preparing transition: %#v", phases)
	}
	phases = state.Advance(
		round.StartedAt.Add(casualPreparingDuration + 10*time.Second),
	)
	if len(phases) != 1 || phases[0] != "hunting" {
		t.Fatalf("unexpected hiding transition: %#v", phases)
	}
	phases = state.Advance(
		round.StartedAt.Add(casualPreparingDuration + 40*time.Second),
	)
	if len(phases) != 1 || phases[0] != "terminal" {
		t.Fatalf("unexpected hunting transition: %#v", phases)
	}
	if state.WinningSide != "hiders" || state.CompletionReason != "hunt_timeout" {
		t.Fatalf("unexpected timeout outcome: %#v", state)
	}
	state.Apply(&round)
	if round.Status != "terminal" ||
		round.WinningSide != "hiders" ||
		round.HidersRemaining != 1 ||
		round.PhaseDeadline != nil {
		t.Fatalf("unexpected public timeout state: %#v", round.Public())
	}
}

func TestCasualHunterFireIsServerValidatedAndIdempotent(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	state, err := newCasualRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round state: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)

	miss, discovery := state.HandleFire(
		"hunter",
		hunterFireCommand{CommandID: "shot-1", AimSlot: 1},
		huntStarted,
	)
	if !miss.Accepted || miss.Hit || miss.Reason != "miss" || discovery != nil {
		t.Fatalf("unexpected authoritative miss: %#v, %#v", miss, discovery)
	}
	if miss.ShellsRemaining != 2 {
		t.Fatalf("miss left %d shells, expected 2", miss.ShellsRemaining)
	}

	replayed, discovery := state.HandleFire(
		"hunter",
		hunterFireCommand{CommandID: "shot-1", AimSlot: 2},
		huntStarted.Add(time.Second),
	)
	if replayed.AimSlot != 1 || replayed.ShellsRemaining != 2 || discovery != nil {
		t.Fatalf("duplicate command changed its authoritative result: %#v", replayed)
	}

	reloading, discovery := state.HandleFire(
		"hunter",
		hunterFireCommand{CommandID: "shot-2", AimSlot: 2},
		huntStarted.Add(50*time.Millisecond),
	)
	if reloading.Accepted || reloading.Reason != "reloading" || discovery != nil {
		t.Fatalf("reload constraint was not enforced: %#v", reloading)
	}

	hit, discovery := state.HandleFire(
		"hunter",
		hunterFireCommand{CommandID: "shot-3", AimSlot: 2},
		huntStarted.Add(100*time.Millisecond),
	)
	if !hit.Accepted ||
		!hit.Hit ||
		hit.HiderPlayerID != "hider" ||
		!hit.RoundIsTerminal ||
		discovery == nil ||
		discovery.Sequence != 1 {
		t.Fatalf("unexpected authoritative hit: %#v, %#v", hit, discovery)
	}
	if state.WinningSide != "hunters" ||
		state.CompletionReason != "all_hiders_found" {
		t.Fatalf("unexpected all-found outcome: %#v", state)
	}
}

func TestCasualRoundRejectsClientDeclaredHitOrTargetPlayer(t *testing.T) {
	t.Parallel()

	for _, payload := range []string{
		`{"command_id":"shot-1","aim_slot":2,"hit":true}`,
		`{"command_id":"shot-1","aim_slot":2,"hider_player_id":"hider"}`,
	} {
		if _, err := decodeHunterFireCommand([]byte(payload)); err == nil {
			t.Fatalf("accepted client-declared authoritative outcome: %s", payload)
		}
	}
	command, err := decodeHunterFireCommand(
		[]byte(`{"command_id":"shot-1","aim_slot":2}`),
	)
	if err != nil || command.CommandID != "shot-1" || command.AimSlot != 2 {
		t.Fatalf("valid fire intent was rejected: %#v, %v", command, err)
	}
}

func TestCasualHiderCannotFire(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	state, err := newCasualRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round state: %v", err)
	}
	state.Advance(round.StartedAt.Add(casualPreparingDuration + 10*time.Second))
	result, discovery := state.HandleFire(
		"hider",
		hunterFireCommand{CommandID: "forged-shot", AimSlot: 2},
		round.StartedAt.Add(casualPreparingDuration+11*time.Second),
	)
	if result.Accepted || result.Reason != "not_hunter" || discovery != nil {
		t.Fatalf("Hider fire intent was accepted: %#v", result)
	}
}

func TestCasualPublicSnapshotDoesNotExposeHidingSlots(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	payload, err := json.Marshal(round.Public())
	if err != nil {
		t.Fatalf("encode public Casual round: %v", err)
	}
	if bytes.Contains(payload, []byte("hiding_slot")) ||
		bytes.Contains(payload, []byte(`"hider"`)) ||
		bytes.Contains(payload, []byte(`"hunter"`)) {
		t.Fatalf("public Casual snapshot leaked private assignment data: %s", payload)
	}
}

func casualRoundFixture() roundSnapshot {
	startedAt := time.Date(2026, time.July, 24, 15, 0, 0, 0, time.UTC)
	return roundSnapshot{
		ID:                       "01900000-0000-7000-8000-000000000001",
		SequenceNumber:           1,
		Mode:                     "casual",
		Status:                   "preparing",
		StartedAt:                startedAt,
		TargetSlotCount:          3,
		HidersTotal:              1,
		HidersRemaining:          1,
		DiscoveredHiderPlayerIDs: make([]string, 0),
		HidingDurationSeconds:    10,
		HuntingDurationSeconds:   30,
		ShellLimit:               3,
		ReloadDurationMS:         100,
		RoleAssignments: []roundRoleAssignment{
			{
				RoundID:  "01900000-0000-7000-8000-000000000001",
				PlayerID: "hunter",
				Role:     "hunter",
			},
			{
				RoundID:    "01900000-0000-7000-8000-000000000001",
				PlayerID:   "hider",
				Role:       "hider",
				HidingSlot: 2,
			},
		},
	}
}
