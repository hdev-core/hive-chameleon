package main

import "time"

const reconnectReservationDuration = 60 * time.Second

type roundReconnectReservation struct {
	PlayerID       string
	RoundID        string
	DisconnectedAt time.Time
	ExpiresAt      time.Time
}

type roundReconnectSnapshot struct {
	RoundID          string    `json:"round_id"`
	PlayerID         string    `json:"player_id"`
	DisplayName      string    `json:"display_name,omitempty"`
	Status           string    `json:"status"`
	ExpiresAt        time.Time `json:"expires_at"`
	Role             string    `json:"role"`
	PlayerStatus     string    `json:"player_status"`
	OutcomePreserved bool      `json:"outcome_preserved"`
}

func (s *persistentLobbyState) reserveReconnect(
	playerID string,
	now time.Time,
) bool {
	if s == nil ||
		s.AuthoritativeRound == nil ||
		s.AuthoritativeRound.Phase == "completed" {
		return false
	}
	if _, participant := s.AuthoritativeRound.Assignments[playerID]; !participant {
		return false
	}
	if s.ReconnectReservations == nil {
		s.ReconnectReservations = make(map[string]roundReconnectReservation)
	}
	if reservation, reserved := s.ReconnectReservations[playerID]; reserved {
		if reservation.RoundID == s.AuthoritativeRound.RoundID &&
			now.Before(reservation.ExpiresAt) {
			return true
		}
		delete(s.ReconnectReservations, playerID)
	}
	s.ReconnectReservations[playerID] = roundReconnectReservation{
		PlayerID:       playerID,
		RoundID:        s.AuthoritativeRound.RoundID,
		DisconnectedAt: now.UTC(),
		ExpiresAt:      now.UTC().Add(reconnectReservationDuration),
	}
	s.markLiveRoundDirty()
	return true
}

func (s *persistentLobbyState) synthesizeCrashReconnectReservations(
	checkpointAt time.Time,
) {
	if s == nil ||
		s.AuthoritativeRound == nil ||
		s.AuthoritativeRound.Phase == "completed" ||
		checkpointAt.IsZero() {
		return
	}
	if s.ReconnectReservations == nil {
		s.ReconnectReservations = make(map[string]roundReconnectReservation)
	}
	openMembers := make(map[string]struct{}, len(s.Snapshot.Members))
	for _, member := range s.Snapshot.Members {
		openMembers[member.PlayerID] = struct{}{}
	}
	for playerID := range s.AuthoritativeRound.Assignments {
		if _, open := openMembers[playerID]; !open {
			continue
		}
		if _, reserved := s.ReconnectReservations[playerID]; reserved {
			continue
		}
		s.ReconnectReservations[playerID] = roundReconnectReservation{
			PlayerID:       playerID,
			RoundID:        s.AuthoritativeRound.RoundID,
			DisconnectedAt: checkpointAt.UTC(),
			ExpiresAt: checkpointAt.
				UTC().
				Add(reconnectReservationDuration),
		}
		s.markLiveRoundDirty()
	}
}

func (s *persistentLobbyState) restoreReconnect(
	playerID string,
	now time.Time,
) (roundReconnectSnapshot, bool) {
	reservation, exists := s.ReconnectReservations[playerID]
	if !exists ||
		!now.Before(reservation.ExpiresAt) ||
		s.AuthoritativeRound == nil ||
		s.AuthoritativeRound.RoundID != reservation.RoundID {
		return roundReconnectSnapshot{}, false
	}
	snapshot, available := s.reconnectSnapshot(
		playerID,
		"restored",
		reservation.ExpiresAt,
	)
	if !available {
		return roundReconnectSnapshot{}, false
	}
	delete(s.ReconnectReservations, playerID)
	if s.AuthoritativeRound.ReconnectedPlayers == nil {
		s.AuthoritativeRound.ReconnectedPlayers = make(map[string]bool)
	}
	s.AuthoritativeRound.ReconnectedPlayers[playerID] = true
	s.markLiveRoundDirty()
	return snapshot, true
}

func (s *persistentLobbyState) reconnectProbe(
	playerID string,
	now time.Time,
) (roundReconnectSnapshot, bool) {
	if reservation, exists := s.ReconnectReservations[playerID]; exists {
		if !now.Before(reservation.ExpiresAt) {
			return roundReconnectSnapshot{}, false
		}
		return s.reconnectSnapshot(playerID, "reserved", reservation.ExpiresAt)
	}
	if len(presencesForPlayer(s, playerID)) > 0 {
		return s.reconnectSnapshot(
			playerID,
			"handoff",
			now.UTC().Add(reconnectReservationDuration),
		)
	}
	return roundReconnectSnapshot{}, false
}

func (s *persistentLobbyState) reconnectSnapshot(
	playerID string,
	status string,
	expiresAt time.Time,
) (roundReconnectSnapshot, bool) {
	if s.AuthoritativeRound == nil {
		return roundReconnectSnapshot{}, false
	}
	playerState, available := s.AuthoritativeRound.PlayerState(playerID)
	if !available {
		return roundReconnectSnapshot{}, false
	}
	return roundReconnectSnapshot{
		RoundID:          s.AuthoritativeRound.RoundID,
		PlayerID:         playerID,
		DisplayName:      playerState.DisplayName,
		Status:           status,
		ExpiresAt:        expiresAt.UTC(),
		Role:             playerState.Role,
		PlayerStatus:     playerState.Status,
		OutcomePreserved: true,
	}, true
}

func (s *persistentLobbyState) expireReconnectReservations(now time.Time) {
	for playerID, reservation := range s.ReconnectReservations {
		if now.Before(reservation.ExpiresAt) ||
			len(presencesForPlayer(s, playerID)) > 0 {
			continue
		}
		delete(s.ReconnectReservations, playerID)
		s.PendingLeaves[playerID] = "host_disconnected"
		s.markLiveRoundDirty()
	}
}
