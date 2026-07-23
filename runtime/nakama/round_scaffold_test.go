package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestSelectRoundRolesPrioritizesAuthenticatedVolunteer(t *testing.T) {
	t.Parallel()

	assignments, err := selectRoundRoles(
		[]string{"player-a", "player-b", "player-c"},
		map[string]bool{"player-b": true},
		1,
		bytes.NewReader(make([]byte, 32)),
	)
	if err != nil {
		t.Fatalf("select round roles: %v", err)
	}
	assertRoundRole(t, assignments, "player-a", "hider", false)
	assertRoundRole(t, assignments, "player-b", "hunter", true)
	assertRoundRole(t, assignments, "player-c", "hider", false)
}

func TestSelectRoundRolesFillsUnclaimedHunterSlotsServerSide(t *testing.T) {
	t.Parallel()

	assignments, err := selectRoundRoles(
		[]string{"player-a", "player-b", "player-c"},
		nil,
		2,
		bytes.NewReader(make([]byte, 32)),
	)
	if err != nil {
		t.Fatalf("select round roles: %v", err)
	}
	hunters := 0
	for _, assignment := range assignments {
		if assignment.Role == "hunter" {
			hunters++
		}
		if assignment.HunterVolunteer {
			t.Fatalf("server-generated fallback assignment was marked as a volunteer")
		}
	}
	if hunters != 2 {
		t.Fatalf("selected %d hunters, expected 2", hunters)
	}
}

func TestSelectRoundRolesRejectsInvalidMembership(t *testing.T) {
	t.Parallel()

	if _, err := selectRoundRoles(
		[]string{"same-player", "same-player"},
		nil,
		1,
		bytes.NewReader(make([]byte, 32)),
	); err == nil {
		t.Fatal("duplicate round membership was accepted")
	}
	if _, err := selectRoundRoles(
		[]string{"player-a", "player-b"},
		nil,
		2,
		bytes.NewReader(make([]byte, 32)),
	); err == nil {
		t.Fatal("role assignment accepted no remaining hider")
	}
}

func TestNominationPayloadCannotSupplyAPlayerOrRole(t *testing.T) {
	t.Parallel()

	var request nominateHunterRequest
	assertLobbyProblemCode(
		t,
		decodeLobbyPayload(
			`{"lobby_id":"01900000-0000-7000-8000-000000000001",`+
				`"expected_lobby_version":1,"nominated":true,"role":"hunter"}`,
			&request,
		),
		grpcInvalidArgument,
	)
	assertLobbyProblemCode(
		t,
		decodeLobbyPayload(
			`{"lobby_id":"01900000-0000-7000-8000-000000000001",`+
				`"expected_lobby_version":1,"nominated":true,"player_id":`+
				`"01900000-0000-7000-8000-000000000002"}`,
			&request,
		),
		grpcInvalidArgument,
	)
}

func TestPublicRoundSnapshotDoesNotExposeAssignments(t *testing.T) {
	t.Parallel()

	round := roundSnapshot{
		ID:             "01900000-0000-7000-8000-000000000010",
		SequenceNumber: 1,
		Status:         "preparing",
		StartedAt:      time.Unix(1_784_821_000, 0).UTC(),
		RoleAssignments: []roundRoleAssignment{{
			PlayerID: "01900000-0000-7000-8000-000000000001",
			Role:     "hunter",
		}},
	}
	payload, err := json.Marshal(round.Public())
	if err != nil {
		t.Fatalf("encode public round: %v", err)
	}
	if bytes.Contains(payload, []byte("hunter")) ||
		bytes.Contains(payload, []byte("player_id")) {
		t.Fatalf("public round leaked a private role assignment: %s", payload)
	}
}

func assertRoundRole(
	t *testing.T,
	assignments []roundRoleAssignment,
	playerID string,
	role string,
	volunteer bool,
) {
	t.Helper()
	for _, assignment := range assignments {
		if assignment.PlayerID == playerID {
			if assignment.Role != role || assignment.HunterVolunteer != volunteer {
				t.Fatalf("unexpected assignment for %s: %#v", playerID, assignment)
			}
			return
		}
	}
	t.Fatalf("missing assignment for %s", playerID)
}
