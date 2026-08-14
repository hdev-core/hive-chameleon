package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	liveRoundCheckpointFormatVersion = 3
	maximumLiveRoundCheckpointBytes  = 2 * 1024 * 1024
	liveRoundCheckpointInterval      = 250 * time.Millisecond
	liveRoundCheckpointHeartbeat     = time.Second
)

var errLiveRoundCheckpointWriteRejected = errors.New(
	"live round checkpoint write rejected as stale or inactive",
)

type liveRoundCheckpoint struct {
	Version                  int                                  `json:"version"`
	RoundID                  string                               `json:"round_id"`
	AuthorityGeometryVersion string                               `json:"authority_geometry_version"`
	AuthorityGeometryDigest  string                               `json:"authority_geometry_digest"`
	AuthoritativeRound       *authoritativeRoundState             `json:"authoritative_round"`
	AvatarStates             map[string]roundAvatarStateSnapshot  `json:"avatar_states"`
	PaintStates              map[string]*roundPlayerPaintState    `json:"paint_states"`
	CachedScore              *roundScoreSnapshot                  `json:"cached_score,omitempty"`
	NextScoreBatchAt         time.Time                            `json:"next_score_batch_at,omitempty"`
	ScoreBatchSequence       uint64                               `json:"score_batch_sequence"`
	ReconnectReservations    map[string]roundReconnectReservation `json:"reconnect_reservations"`
}

func encodeLiveRoundCheckpoint(
	state *persistentLobbyState,
) ([]byte, error) {
	if state == nil ||
		state.Round == nil ||
		state.AuthoritativeRound == nil ||
		state.Round.ID != state.AuthoritativeRound.RoundID {
		return nil, errors.New("active authoritative round checkpoint is required")
	}
	synchronizeAvatarAuthority(state)
	if state.PaintStates == nil {
		state.PaintStates = initializeRoundPaintStates(state.AuthoritativeRound)
	}
	checkpoint := liveRoundCheckpoint{
		Version:                  liveRoundCheckpointFormatVersion,
		RoundID:                  state.Round.ID,
		AuthorityGeometryVersion: state.Round.AuthorityGeometryVersion,
		AuthorityGeometryDigest:  state.Round.AuthorityGeometryDigest,
		AuthoritativeRound:       state.AuthoritativeRound,
		AvatarStates:             state.AvatarStates,
		PaintStates:              state.PaintStates,
		CachedScore:              state.CachedScore,
		NextScoreBatchAt:         state.NextScoreBatchAt,
		ScoreBatchSequence:       state.ScoreBatchSequence,
		ReconnectReservations:    state.ReconnectReservations,
	}
	payload, err := json.Marshal(checkpoint)
	if err != nil {
		return nil, fmt.Errorf("encode live round checkpoint: %w", err)
	}
	if len(payload) == 0 || len(payload) > maximumLiveRoundCheckpointBytes {
		return nil, errors.New("live round checkpoint size is invalid")
	}
	return payload, nil
}

func decodeLiveRoundCheckpoint(
	payload []byte,
	round *roundSnapshot,
) (*liveRoundCheckpoint, error) {
	if len(payload) == 0 || len(payload) > maximumLiveRoundCheckpointBytes {
		return nil, errors.New("live round checkpoint size is invalid")
	}
	var checkpoint liveRoundCheckpoint
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&checkpoint); err != nil {
		return nil, fmt.Errorf("decode live round checkpoint: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("live round checkpoint has trailing data")
	}
	if err := validateLiveRoundCheckpoint(&checkpoint, round); err != nil {
		return nil, err
	}
	return &checkpoint, nil
}

func validateLiveRoundCheckpoint(
	checkpoint *liveRoundCheckpoint,
	round *roundSnapshot,
) error {
	arena, arenaError := officialArenaForRound(round)
	if checkpoint == nil ||
		checkpoint.Version != liveRoundCheckpointFormatVersion ||
		round == nil ||
		arenaError != nil ||
		round.ID == "" ||
		checkpoint.RoundID != round.ID ||
		checkpoint.AuthorityGeometryVersion != arena.Geometry.Version ||
		checkpoint.AuthorityGeometryDigest != arena.GeometryDigest ||
		round.AuthorityGeometryVersion != arena.Geometry.Version ||
		round.AuthorityGeometryDigest != arena.GeometryDigest ||
		checkpoint.AuthoritativeRound == nil {
		return errors.New("live round checkpoint identity is invalid")
	}
	authoritative := checkpoint.AuthoritativeRound
	if authoritative.RoundID != round.ID ||
		authoritative.Mode != round.Mode ||
		authoritative.HidingDuration !=
			time.Duration(round.HidingDurationSeconds)*time.Second ||
		authoritative.HuntingDuration !=
			time.Duration(round.HuntingDurationSeconds)*time.Second ||
		authoritative.ReloadDuration !=
			time.Duration(round.ReloadDurationMS)*time.Millisecond ||
		authoritative.ShellLimit != round.ShellLimit {
		return errors.New("live round checkpoint rules do not match the durable round")
	}
	switch authoritative.Phase {
	case "preparing", "hiding", "hunting":
		if authoritative.PhaseDeadline.IsZero() ||
			!authoritative.TerminalAt.IsZero() ||
			authoritative.WinningSide != "" {
			return errors.New("active live round checkpoint phase is invalid")
		}
	case "answer_check":
		if authoritative.PhaseDeadline.IsZero() ||
			authoritative.TerminalAt.IsZero() ||
			(authoritative.WinningSide != "hunters" &&
				authoritative.WinningSide != "hiders" &&
				authoritative.WinningSide != "none") ||
			authoritative.CompletionReason == "" {
			return errors.New("Answer Check checkpoint outcome is invalid")
		}
	default:
		return errors.New("live round checkpoint phase is invalid")
	}

	if len(authoritative.Assignments) < lobbyMinimumPlayers ||
		len(authoritative.Assignments) > lobbyMaximumPlayers {
		return errors.New("live round checkpoint participant count is invalid")
	}
	initialHiders := make(map[string]struct{})
	expectedCurrentRoles := make(map[string]string, len(authoritative.Assignments))
	for playerID, assignment := range authoritative.Assignments {
		if playerID == "" ||
			assignment.PlayerID != playerID ||
			assignment.RoundID != round.ID ||
			(assignment.Role != "hunter" && assignment.Role != "hider") {
			return errors.New("live round checkpoint assignment is invalid")
		}
		expectedCurrentRoles[playerID] = assignment.Role
		if assignment.Role == "hider" {
			initialHiders[playerID] = struct{}{}
		}
	}
	if len(initialHiders) == 0 ||
		len(initialHiders) == len(authoritative.Assignments) ||
		len(authoritative.Hiders) != len(initialHiders) {
		return errors.New("live round checkpoint role split is invalid")
	}
	for playerID := range initialHiders {
		if _, exists := authoritative.Hiders[playerID]; !exists {
			return errors.New("live round checkpoint Hider set is invalid")
		}
	}

	if len(authoritative.Discoveries) != len(authoritative.FoundHiders) {
		return errors.New("live round checkpoint discoveries are inconsistent")
	}
	seenHiders := make(map[string]struct{}, len(authoritative.Discoveries))
	for index, discovery := range authoritative.Discoveries {
		if discovery.RoundID != round.ID ||
			discovery.Sequence != index+1 ||
			discovery.HunterPlayerID == discovery.HiderPlayerID ||
			discovery.OccurredAt.IsZero() {
			return errors.New("live round checkpoint discovery is invalid")
		}
		if expectedCurrentRoles[discovery.HunterPlayerID] != "hunter" {
			return errors.New("live round checkpoint discovery Hunter is invalid")
		}
		if _, hider := initialHiders[discovery.HiderPlayerID]; !hider {
			return errors.New("live round checkpoint discovery Hider is invalid")
		}
		if _, duplicate := seenHiders[discovery.HiderPlayerID]; duplicate {
			return errors.New("live round checkpoint discovered a Hider more than once")
		}
		if discovery.CausedInfectionConversion != (round.Mode == "infection") {
			return errors.New("live round checkpoint conversion flag is invalid")
		}
		stored, found := authoritative.FoundHiders[discovery.HiderPlayerID]
		if !found ||
			stored.RoundID != discovery.RoundID ||
			stored.Sequence != discovery.Sequence ||
			stored.HunterPlayerID != discovery.HunterPlayerID ||
			stored.HiderPlayerID != discovery.HiderPlayerID ||
			!stored.OccurredAt.Equal(discovery.OccurredAt) {
			return errors.New("live round checkpoint found-Hider index is invalid")
		}
		seenHiders[discovery.HiderPlayerID] = struct{}{}
		if round.Mode == "infection" {
			expectedCurrentRoles[discovery.HiderPlayerID] = "hunter"
		}
	}
	if len(authoritative.CurrentRoles) != len(expectedCurrentRoles) {
		return errors.New("live round checkpoint current roles are invalid")
	}
	expectedHunters := 0
	for playerID, expectedRole := range expectedCurrentRoles {
		if authoritative.CurrentRoles[playerID] != expectedRole {
			return errors.New("live round checkpoint current role is invalid")
		}
		if expectedRole == "hunter" {
			expectedHunters++
		}
	}
	if len(authoritative.Hunters) != expectedHunters {
		return errors.New("live round checkpoint Hunter state count is invalid")
	}
	for playerID, hunter := range authoritative.Hunters {
		if expectedCurrentRoles[playerID] != "hunter" ||
			hunter == nil ||
			hunter.ShellsRemaining < 0 ||
			hunter.ShellsRemaining > authoritative.ShellLimit ||
			len(hunter.Commands) > maximumProcessedCommands {
			return errors.New("live round checkpoint Hunter state is invalid")
		}
		for commandID, result := range hunter.Commands {
			if commandID == "" ||
				!roundCommandIDPattern.MatchString(commandID) ||
				result.RoundID != round.ID ||
				result.CommandID != commandID ||
				result.ShellsRemaining < 0 ||
				result.ShellsRemaining > authoritative.ShellLimit {
				return errors.New("live round checkpoint fire command cache is invalid")
			}
		}
	}

	for voterPlayerID, like := range authoritative.Likes {
		target, targetExists := authoritative.Assignments[like.TargetHiderPlayerID]
		if _, voterExists := authoritative.Assignments[voterPlayerID]; !voterExists ||
			like.VoterPlayerID != voterPlayerID ||
			!targetExists ||
			target.Role != "hider" ||
			like.VoterPlayerID == like.TargetHiderPlayerID ||
			like.CreatedAt.IsZero() {
			return errors.New("live round checkpoint like is invalid")
		}
	}
	for playerID, commands := range authoritative.LikeCommands {
		if _, participant := authoritative.Assignments[playerID]; !participant ||
			len(commands) > maximumLikeCommands {
			return errors.New("live round checkpoint like command cache is invalid")
		}
		for commandID, result := range commands {
			if commandID == "" ||
				!roundCommandIDPattern.MatchString(commandID) ||
				result.RoundID != round.ID ||
				result.CommandID != commandID {
				return errors.New("live round checkpoint like command is invalid")
			}
		}
	}
	for playerID := range authoritative.ReconnectedPlayers {
		if _, participant := authoritative.Assignments[playerID]; !participant {
			return errors.New("live round checkpoint reconnect evidence is invalid")
		}
	}

	if len(checkpoint.AvatarStates) != len(authoritative.Assignments) {
		return errors.New("live round checkpoint avatar state count is invalid")
	}
	for playerID, avatar := range checkpoint.AvatarStates {
		assignment, participant := authoritative.Assignments[playerID]
		playerState, playerStateAvailable := authoritative.PlayerState(playerID)
		if !participant || !playerStateAvailable {
			return fmt.Errorf(
				"live round checkpoint avatar participant %q is invalid",
				playerID,
			)
		}
		if avatar.RoundID != round.ID ||
			avatar.PlayerID != playerID {
			return fmt.Errorf(
				"live round checkpoint avatar identity %q is invalid",
				playerID,
			)
		}
		if avatar.DisplayName != assignment.DisplayName ||
			avatar.Role != playerState.Role ||
			avatar.Status != playerState.Status {
			return fmt.Errorf(
				"live round checkpoint avatar authority %q is invalid",
				playerID,
			)
		}
		if avatar.Sequence == 0 ||
			avatar.OccurredAt.IsZero() ||
			avatar.OccurredAt.Before(round.StartedAt.Add(-time.Microsecond)) {
			return fmt.Errorf(
				"live round checkpoint avatar sequence/time %q is invalid",
				playerID,
			)
		}
		if !validAvatarPositionForArena(
			avatar.PositionX,
			avatar.PositionY,
			avatar.PositionZ,
			arena,
		) {
			return fmt.Errorf(
				"live round checkpoint avatar position %q is invalid",
				playerID,
			)
		}
		if !finiteNumber(avatar.Yaw) ||
			avatar.Yaw < 0 ||
			avatar.Yaw >= 360 ||
			!validAvatarPitch(avatar.Pitch) ||
			!validAvatarColor(avatar.BodyR) ||
			!validAvatarColor(avatar.BodyG) ||
			!validAvatarColor(avatar.BodyB) ||
			!validAvatarColor(avatar.AccentR) ||
			!validAvatarColor(avatar.AccentG) ||
			!validAvatarColor(avatar.AccentB) ||
			len(avatar.Pose) > maximumAvatarPoseLength ||
			!validAvatarPose(avatar.Pose) {
			return fmt.Errorf(
				"live round checkpoint avatar presentation %q is invalid",
				playerID,
			)
		}
		if authorityCapsuleIntersectsStatic(
			authorityPlayerCapsule(
				authorityVector{
					X: avatar.PositionX,
					Y: avatar.PositionY,
					Z: avatar.PositionZ,
				},
				authorityPlayerHeight(avatar.Pose),
			),
			&arena.Geometry,
		) {
			return fmt.Errorf(
				"live round checkpoint avatar geometry %q is invalid",
				playerID,
			)
		}
	}
	if err := validateRoundPaintStates(
		checkpoint.PaintStates,
		round,
		authoritative,
	); err != nil {
		return err
	}
	if checkpoint.CachedScore != nil {
		if checkpoint.CachedScore.RoundID != round.ID ||
			checkpoint.CachedScore.BatchSequence != checkpoint.ScoreBatchSequence ||
			len(checkpoint.CachedScore.Entries) != len(initialHiders) {
			return errors.New("live round checkpoint score cache is invalid")
		}
		scorePlayers := make(map[string]struct{}, len(checkpoint.CachedScore.Entries))
		for _, entry := range checkpoint.CachedScore.Entries {
			assignment, participant := authoritative.Assignments[entry.PlayerID]
			if !participant ||
				assignment.Role != "hider" ||
				entry.DisplayName != assignment.DisplayName ||
				entry.Rank < 1 ||
				entry.Rank > len(initialHiders) {
				return errors.New("live round checkpoint score entry is invalid")
			}
			if _, duplicate := scorePlayers[entry.PlayerID]; duplicate {
				return errors.New("live round checkpoint score player is duplicated")
			}
			scorePlayers[entry.PlayerID] = struct{}{}
		}
	} else if checkpoint.ScoreBatchSequence != 0 {
		return errors.New("live round checkpoint score sequence has no cache")
	}
	for playerID, reservation := range checkpoint.ReconnectReservations {
		if _, participant := authoritative.Assignments[playerID]; !participant ||
			reservation.PlayerID != playerID ||
			reservation.RoundID != round.ID ||
			reservation.DisconnectedAt.IsZero() ||
			!reservation.ExpiresAt.After(reservation.DisconnectedAt) {
			return errors.New("live round checkpoint reconnect reservation is invalid")
		}
	}
	return nil
}

func applyLiveRoundCheckpoint(
	state *persistentLobbyState,
	round *roundSnapshot,
	checkpoint *liveRoundCheckpoint,
	storedAt time.Time,
) {
	round.RoleAssignments = make(
		[]roundRoleAssignment,
		0,
		len(checkpoint.AuthoritativeRound.Assignments),
	)
	for _, playerID := range sortedPlayerIDs(checkpoint.AuthoritativeRound.Assignments) {
		round.RoleAssignments = append(
			round.RoleAssignments,
			checkpoint.AuthoritativeRound.Assignments[playerID],
		)
	}
	checkpoint.AuthoritativeRound.Apply(round)
	state.Round = round
	state.AuthoritativeRound = checkpoint.AuthoritativeRound
	state.AvatarStates = checkpoint.AvatarStates
	if state.AvatarStates == nil {
		state.AvatarStates = make(map[string]roundAvatarStateSnapshot)
	}
	state.PaintStates = checkpoint.PaintStates
	if state.PaintStates == nil {
		state.PaintStates = make(map[string]*roundPlayerPaintState)
	}
	state.CachedScore = checkpoint.CachedScore
	state.NextScoreBatchAt = checkpoint.NextScoreBatchAt
	state.ScoreBatchSequence = checkpoint.ScoreBatchSequence
	state.ReconnectReservations = checkpoint.ReconnectReservations
	if state.ReconnectReservations == nil {
		state.ReconnectReservations = make(map[string]roundReconnectReservation)
	}
	state.LiveStateDirty = false
	state.LiveStatePersistedAt = storedAt.UTC()
}

func (s *postgresLobbyStore) LoadLiveRoundCheckpoint(
	ctx context.Context,
	roundID string,
) ([]byte, time.Time, error) {
	var formatVersion int
	var payload []byte
	var updatedAt time.Time
	if err := s.database.QueryRowContext(
		ctx,
		`SELECT format_version, private_state::text, updated_at
		   FROM game.round_live_checkpoint
		  WHERE round_id = $1`,
		roundID,
	).Scan(&formatVersion, &payload, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, time.Time{}, nil
		}
		return nil, time.Time{}, fmt.Errorf("load live round checkpoint: %w", err)
	}
	if formatVersion != liveRoundCheckpointFormatVersion {
		return nil, time.Time{}, errors.New("live round checkpoint format is unsupported")
	}
	return payload, updatedAt.UTC(), nil
}

func (s *postgresLobbyStore) SaveLiveRoundCheckpoint(
	ctx context.Context,
	roundID string,
	payload []byte,
	expectedUpdatedAt time.Time,
	updatedAt time.Time,
) error {
	return persistLiveRoundCheckpoint(
		ctx,
		s.database,
		roundID,
		payload,
		expectedUpdatedAt,
		updatedAt,
	)
}

func (s *postgresLobbyStore) DeleteLiveRoundCheckpoint(
	ctx context.Context,
	roundID string,
) error {
	if _, err := s.database.ExecContext(
		ctx,
		`DELETE FROM game.round_live_checkpoint WHERE round_id = $1`,
		roundID,
	); err != nil {
		return fmt.Errorf("delete live round checkpoint: %w", err)
	}
	return nil
}

type liveRoundCheckpointExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func persistLiveRoundCheckpoint(
	ctx context.Context,
	execer liveRoundCheckpointExecer,
	roundID string,
	payload []byte,
	expectedUpdatedAt time.Time,
	updatedAt time.Time,
) error {
	if execer == nil ||
		roundID == "" ||
		len(payload) == 0 ||
		len(payload) > maximumLiveRoundCheckpointBytes ||
		!json.Valid(payload) ||
		updatedAt.IsZero() {
		return errors.New("valid live round checkpoint is required")
	}
	result, err := execer.ExecContext(
		ctx,
		`INSERT INTO game.round_live_checkpoint (
		   round_id, format_version, private_state, created_at, updated_at
		 )
		 SELECT id, $2, $3::jsonb, $4, $4
		   FROM game.game_round
		  WHERE id = $1
		    AND status NOT IN ('completed', 'aborted')
		 ON CONFLICT (round_id) DO UPDATE
		       SET format_version = EXCLUDED.format_version,
		           private_state = EXCLUDED.private_state,
		           updated_at = EXCLUDED.updated_at
		     WHERE game.round_live_checkpoint.updated_at < EXCLUDED.updated_at
		       AND (
		             $5::timestamptz IS NULL
		          OR game.round_live_checkpoint.updated_at = $5::timestamptz
		       )`,
		roundID,
		liveRoundCheckpointFormatVersion,
		string(payload),
		updatedAt.UTC(),
		nullableCheckpointTimestamp(expectedUpdatedAt),
	)
	if err != nil {
		return fmt.Errorf("persist live round checkpoint: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read live round checkpoint update count: %w", err)
	}
	if updated != 1 {
		return errLiveRoundCheckpointWriteRejected
	}
	return nil
}

func nullableCheckpointTimestamp(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UTC()
}

func (s *persistentLobbyState) markLiveRoundDirty() {
	if s != nil && s.Round != nil && s.AuthoritativeRound != nil {
		s.LiveStateDirty = true
	}
}

func (m *persistentLobbyMatch) persistLiveRoundState(
	ctx context.Context,
	state *persistentLobbyState,
	now time.Time,
	force bool,
) error {
	if state == nil || state.Round == nil || state.AuthoritativeRound == nil {
		return nil
	}
	if state.Round.Status == "completed" ||
		state.AuthoritativeRound.Phase == "completed" {
		state.LiveStateDirty = false
		return nil
	}
	if !state.LiveStateDirty && !force {
		return nil
	}
	if !force &&
		!state.LiveStatePersistedAt.IsZero() &&
		now.Before(state.LiveStatePersistedAt.Add(liveRoundCheckpointInterval)) {
		return nil
	}
	if err := state.ensureFinalScoreCache(); err != nil {
		return err
	}
	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		return err
	}
	updatedAt := now.UTC()
	if !state.LiveStatePersistedAt.IsZero() &&
		!updatedAt.After(state.LiveStatePersistedAt) {
		updatedAt = state.LiveStatePersistedAt.Add(time.Nanosecond)
	}
	if err := m.store.SaveLiveRoundCheckpoint(
		ctx,
		state.Round.ID,
		payload,
		state.LiveStatePersistedAt,
		updatedAt,
	); err != nil {
		return err
	}
	state.LiveStateDirty = false
	state.LiveStatePersistedAt = updatedAt
	return nil
}
