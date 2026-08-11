package main

import "time"

const (
	reconnectReservationDuration           = 60 * time.Second
	reconnectWindowExpiredRoundAbortReason = "reconnect_window_expired"
)

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

// queueUnreachableRoundParticipants restores the active-round presence
// invariant after lifecycle races: every participant must either have a live
// presence, own an unexpired reconnect reservation, or be queued for a durable
// lobby departure. A participant that never reached MatchJoin (or whose
// presence was lost without a corresponding MatchLeave callback) must not keep
// the authoritative round alive forever.
func (s *persistentLobbyState) queueUnreachableRoundParticipants(now time.Time) bool {
	if s == nil || s.AuthoritativeRound == nil || !s.reconnectManagedPhase() {
		return false
	}
	if s.PendingLeaves == nil {
		s.PendingLeaves = make(map[string]string)
	}
	changed := false
	for playerID := range s.AuthoritativeRound.Assignments {
		if len(presencesForPlayer(s, playerID)) > 0 {
			continue
		}
		if reservation, reserved := s.ReconnectReservations[playerID]; reserved {
			if now.Before(reservation.ExpiresAt) {
				continue
			}
			delete(s.ReconnectReservations, playerID)
		}
		if _, queued := s.PendingLeaves[playerID]; queued {
			continue
		}
		s.PendingLeaves[playerID] = "host_disconnected"
		changed = true
	}
	if changed {
		s.markLiveRoundDirty()
	}
	return changed
}

// noReachableRoundParticipants reports whether a live, pre-terminal round has
// nobody who can still play or reconnect. Join-in-progress spectators are not
// round participants and therefore do not make an otherwise abandoned round
// continue ticking.
func (s *persistentLobbyState) noReachableRoundParticipants(now time.Time) bool {
	if s == nil || s.Round == nil || s.AuthoritativeRound == nil ||
		!s.reconnectManagedPhase() ||
		len(s.AuthoritativeRound.Assignments) == 0 {
		return false
	}
	for playerID := range s.AuthoritativeRound.Assignments {
		if len(presencesForPlayer(s, playerID)) > 0 {
			return false
		}
		if reservation, reserved := s.ReconnectReservations[playerID]; reserved &&
			now.Before(reservation.ExpiresAt) {
			return false
		}
	}
	return true
}

func (s *persistentLobbyState) reconnectManagedPhase() bool {
	if s == nil || s.AuthoritativeRound == nil {
		return false
	}
	switch s.AuthoritativeRound.Phase {
	case "preparing", "hiding", "hunting":
		return true
	default:
		return false
	}
}
