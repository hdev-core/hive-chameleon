package main

import (
	"testing"
	"time"
)

func TestReconnectRestoresAuthoritativeRoleAndMarksTerminalEvidence(t *testing.T) {
	round := casualRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create authoritative round: %v", err)
	}
	hiderID := round.RoleAssignments[1].PlayerID
	now := round.StartedAt.Add(time.Second)
	lobby := &persistentLobbyState{
		AuthoritativeRound:    state,
		ReconnectReservations: make(map[string]roundReconnectReservation),
		PendingLeaves:         make(map[string]string),
		Presences:             make(map[string]lobbyPresence),
	}

	if !lobby.reserveReconnect(hiderID, now) {
		t.Fatal("active round participant was not reserved")
	}
	probe, available := lobby.reconnectProbe(hiderID, now.Add(30*time.Second))
	if !available ||
		probe.Status != "reserved" ||
		probe.Role != "hider" ||
		!probe.OutcomePreserved {
		t.Fatalf("unexpected reconnect probe: %#v", probe)
	}
	restored, available := lobby.restoreReconnect(
		hiderID,
		now.Add(59*time.Second),
	)
	if !available ||
		restored.Status != "restored" ||
		restored.Role != "hider" ||
		!state.ReconnectedPlayers[hiderID] {
		t.Fatalf("authoritative reconnect was not restored: %#v", restored)
	}
	if _, reserved := lobby.ReconnectReservations[hiderID]; reserved {
		t.Fatal("restored reconnect reservation was not consumed")
	}
}

func TestReconnectExpiryQueuesDurableLobbyDeparture(t *testing.T) {
	round := casualRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create authoritative round: %v", err)
	}
	playerID := round.RoleAssignments[0].PlayerID
	now := round.StartedAt.Add(time.Second)
	lobby := &persistentLobbyState{
		AuthoritativeRound:    state,
		ReconnectReservations: make(map[string]roundReconnectReservation),
		PendingLeaves:         make(map[string]string),
		Presences:             make(map[string]lobbyPresence),
	}
	if !lobby.reserveReconnect(playerID, now) {
		t.Fatal("active round participant was not reserved")
	}

	lobby.expireReconnectReservations(now.Add(reconnectReservationDuration))
	if lobby.PendingLeaves[playerID] != "host_disconnected" {
		t.Fatal("expired reconnect did not queue the authoritative departure")
	}
	if _, reserved := lobby.ReconnectReservations[playerID]; reserved {
		t.Fatal("expired reconnect reservation was retained")
	}
	if _, restored := lobby.restoreReconnect(
		playerID,
		now.Add(reconnectReservationDuration),
	); restored {
		t.Fatal("expired reconnect was restored")
	}
}

func TestCrashRecoveryReservationsUseCheckpointDeadlineAndNeverExtend(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create authoritative round: %v", err)
	}
	checkpointAt := round.StartedAt.Add(5 * time.Second)
	hunterID := round.RoleAssignments[0].PlayerID
	hiderID := round.RoleAssignments[1].PlayerID
	existing := roundReconnectReservation{
		PlayerID:       hiderID,
		RoundID:        round.ID,
		DisconnectedAt: checkpointAt.Add(-time.Second),
		ExpiresAt:      checkpointAt.Add(30 * time.Second),
	}
	lobby := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		Snapshot: lobbySnapshot{
			Members: []lobbyMemberSnapshot{
				{PlayerID: hunterID},
				{PlayerID: hiderID},
			},
		},
		ReconnectReservations: map[string]roundReconnectReservation{
			hiderID: existing,
		},
	}

	lobby.synthesizeCrashReconnectReservations(checkpointAt)
	hunterReservation := lobby.ReconnectReservations[hunterID]
	if !hunterReservation.DisconnectedAt.Equal(checkpointAt) ||
		!hunterReservation.ExpiresAt.Equal(
			checkpointAt.Add(reconnectReservationDuration),
		) ||
		lobby.ReconnectReservations[hiderID] != existing ||
		!lobby.LiveStateDirty {
		t.Fatalf("crash recovery reservation is invalid: %#v", lobby.ReconnectReservations)
	}

	lobby.synthesizeCrashReconnectReservations(checkpointAt.Add(10 * time.Second))
	if lobby.ReconnectReservations[hunterID] != hunterReservation {
		t.Fatal("a second MatchInit extended the crash-recovery deadline")
	}
	if _, available := lobby.reconnectProbe(
		hunterID,
		checkpointAt.Add(reconnectReservationDuration),
	); available {
		t.Fatal("crash-recovery reservation remained valid at its exclusive deadline")
	}
}

func TestReconnectPreservesConvertedInfectionRoleAndAvatar(t *testing.T) {
	t.Parallel()

	round := infectionRoundFixture()
	state, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Infection round: %v", err)
	}
	huntStarted := round.StartedAt.Add(casualPreparingDuration + 10*time.Second)
	state.Advance(huntStarted)
	convertedID := round.RoleAssignments[1].PlayerID
	state.HandleFire(
		round.RoleAssignments[0].PlayerID,
		hunterFireCommand{
			CommandID:      "reconnect-conversion",
			TargetPlayerID: convertedID,
		},
		huntStarted,
	)
	avatar := roundAvatarStateSnapshot{
		RoundID:    round.ID,
		PlayerID:   convertedID,
		Role:       "hunter",
		Status:     "converted",
		PositionX:  4,
		PositionY:  1,
		PositionZ:  -7,
		Pose:       "aiming",
		Sequence:   3,
		OccurredAt: huntStarted,
	}
	lobby := &persistentLobbyState{
		Round:                 &round,
		AuthoritativeRound:    state,
		AvatarStates:          map[string]roundAvatarStateSnapshot{convertedID: avatar},
		ReconnectReservations: make(map[string]roundReconnectReservation),
		PendingLeaves:         make(map[string]string),
		Presences:             make(map[string]lobbyPresence),
	}
	if !lobby.reserveReconnect(convertedID, huntStarted) {
		t.Fatal("converted Hunter was not reserved")
	}
	probe, available := lobby.reconnectProbe(
		convertedID,
		huntStarted.Add(30*time.Second),
	)
	if !available ||
		probe.Role != "hunter" ||
		probe.PlayerStatus != "converted" {
		t.Fatalf("converted reconnect probe lost authoritative state: %#v", probe)
	}
	restored, available := lobby.restoreReconnect(
		convertedID,
		huntStarted.Add(59*time.Second),
	)
	if !available ||
		restored.Role != "hunter" ||
		restored.PlayerStatus != "converted" ||
		lobby.AvatarStates[convertedID] != avatar {
		t.Fatalf("converted reconnect did not restore state: %#v", restored)
	}
}

func TestColdReconnectImmediatelyFencesThePreviousPlayerSession(t *testing.T) {
	t.Parallel()

	const playerID = "01900000-0000-7000-8000-000000000701"
	const otherPlayerID = "01900000-0000-7000-8000-000000000702"
	oldPresence := testPresence{sessionID: "old-session"}
	otherPresence := testPresence{sessionID: "other-session"}
	newPresence := testPresence{sessionID: "new-session"}
	lobby := &persistentLobbyState{
		Presences: map[string]lobbyPresence{
			oldPresence.sessionID: {
				PlayerID: playerID,
				Presence: oldPresence,
			},
			otherPresence.sessionID: {
				PlayerID: otherPlayerID,
				Presence: otherPresence,
			},
		},
	}

	replaced := replacePlayerPresence(lobby, playerID, newPresence)

	if len(replaced) != 1 || replaced[0].GetSessionId() != oldPresence.sessionID {
		t.Fatalf("unexpected replaced presences: %#v", replaced)
	}
	if _, retained := lobby.Presences[oldPresence.sessionID]; retained {
		t.Fatal("the superseded player session retained command authority")
	}
	if lobby.Presences[newPresence.sessionID].PlayerID != playerID {
		t.Fatal("the cold reconnect session did not receive player authority")
	}
	if lobby.Presences[otherPresence.sessionID].PlayerID != otherPlayerID {
		t.Fatal("another player's presence was changed during handoff")
	}
}
