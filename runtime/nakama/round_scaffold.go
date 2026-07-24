package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math/big"
	"sort"
	"time"
)

const (
	gameServerBuildVersion = "hive-chameleon-m4-dev"
	matchProtocolVersion   = "m4-v1"
	resultSchemaVersion    = "match-result-1"
	scoringRuleVersion     = "scoring-1"
)

type roundRoleAssignment struct {
	RoundID         string `json:"round_id"`
	PlayerID        string `json:"player_id"`
	Role            string `json:"role"`
	HunterVolunteer bool   `json:"hunter_volunteer"`
}

type roundSnapshot struct {
	ID              string                `json:"id"`
	SequenceNumber  int                   `json:"sequence_number"`
	Status          string                `json:"status"`
	StartedAt       time.Time             `json:"started_at"`
	RoleAssignments []roundRoleAssignment `json:"-"`
}

type roundPublicSnapshot struct {
	ID             string    `json:"id"`
	SequenceNumber int       `json:"sequence_number"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
}

func (r roundSnapshot) Public() roundPublicSnapshot {
	return roundPublicSnapshot{
		ID:             r.ID,
		SequenceNumber: r.SequenceNumber,
		Status:         r.Status,
		StartedAt:      r.StartedAt,
	}
}

func (s *postgresLobbyStore) RecordNominationChange(
	ctx context.Context,
	playerID string,
	request nominateHunterRequest,
) (lobbySnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var currentVersion int64
	var closedAt sql.NullTime
	if err := tx.QueryRowContext(
		ctx,
		`SELECT row_version, closed_at
		   FROM game.lobby
		  WHERE id = $1
		  FOR UPDATE`,
		request.LobbyID,
	).Scan(&currentVersion, &closedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbySnapshot{}, newLobbyProblem(grpcNotFound, "lobby not found")
		}
		return lobbySnapshot{}, fmt.Errorf("lock lobby for hunter nomination: %w", err)
	}
	if closedAt.Valid {
		return lobbySnapshot{}, newLobbyProblem(grpcFailedPrecondition, "lobby is closed")
	}
	if currentVersion != request.ExpectedLobbyVersion {
		return lobbySnapshot{}, newLobbyProblem(
			grpcAborted,
			"lobby version changed; refresh state and retry",
		)
	}

	var member bool
	if err := tx.QueryRowContext(
		ctx,
		`SELECT EXISTS (
		   SELECT 1
		     FROM game.lobby_membership
		    WHERE lobby_id = $1
		      AND player_id = $2
		      AND left_at IS NULL
		 )`,
		request.LobbyID,
		playerID,
	).Scan(&member); err != nil {
		return lobbySnapshot{}, fmt.Errorf("check hunter nomination membership: %w", err)
	}
	if !member {
		return lobbySnapshot{}, newLobbyProblem(
			grpcPermissionDenied,
			"open lobby membership required",
		)
	}
	if active, err := activeRoundExists(ctx, tx, request.LobbyID); err != nil {
		return lobbySnapshot{}, err
	} else if active {
		return lobbySnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"hunter nomination is closed after round start",
		)
	}

	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby
		    SET row_version = row_version + 1
		  WHERE id = $1`,
		request.LobbyID,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("advance lobby version after hunter nomination: %w", err)
	}
	snapshot, err := loadLobbySnapshot(ctx, tx, request.LobbyID)
	if err != nil {
		return lobbySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("commit hunter nomination: %w", err)
	}
	return snapshot, nil
}

func (s *postgresLobbyStore) StartRound(
	ctx context.Context,
	playerID string,
	request startLobbyRequest,
	nominations map[string]bool,
) (lobbySnapshot, roundSnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	configuration, _, err := lockHostConfiguration(
		ctx,
		tx,
		request.LobbyID,
		playerID,
		request.ExpectedLobbyVersion,
	)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, err
	}
	if configuration.MapVersionID == nil {
		return lobbySnapshot{}, roundSnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"select a published map version before starting",
		)
	}
	var mapStatus string
	if err := tx.QueryRowContext(
		ctx,
		`SELECT status::text
		   FROM content.map_version
		  WHERE id = $1`,
		*configuration.MapVersionID,
	).Scan(&mapStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbySnapshot{}, roundSnapshot{}, newLobbyProblem(
				grpcFailedPrecondition,
				"selected map version is unavailable",
			)
		}
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("load selected map version: %w", err)
	}
	if mapStatus != "published" {
		return lobbySnapshot{}, roundSnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"selected map version is not published",
		)
	}
	if active, err := activeRoundExists(ctx, tx, request.LobbyID); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, err
	} else if active {
		return lobbySnapshot{}, roundSnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"lobby already has an active round",
		)
	}

	rows, err := tx.QueryContext(
		ctx,
		`SELECT player_id::text
		   FROM game.lobby_membership
		  WHERE lobby_id = $1
		    AND left_at IS NULL
		  ORDER BY joined_at, id
		  FOR UPDATE`,
		request.LobbyID,
	)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("lock round participants: %w", err)
	}
	members := make([]string, 0, lobbyMaximumPlayers)
	for rows.Next() {
		var memberID string
		if err := rows.Scan(&memberID); err != nil {
			_ = rows.Close()
			return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("scan round participant: %w", err)
		}
		members = append(members, memberID)
	}
	if err := rows.Close(); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("close round participant rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("read round participants: %w", err)
	}
	if len(members) < int(configuration.HunterCount)+1 {
		return lobbySnapshot{}, roundSnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"lobby needs the configured hunters plus at least one hider",
		)
	}
	assignments, err := selectRoundRoles(
		members,
		nominations,
		int(configuration.HunterCount),
		rand.Reader,
	)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("assign authoritative round roles: %w", err)
	}

	var sequenceNumber int
	if err := tx.QueryRowContext(
		ctx,
		`SELECT COALESCE(max(sequence_number), 0) + 1
		   FROM game.game_round
		  WHERE lobby_id = $1`,
		request.LobbyID,
	).Scan(&sequenceNumber); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("allocate round sequence: %w", err)
	}
	startedAt := s.now().UTC()
	roundID, err := newUUIDV7(startedAt)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, err
	}
	for index := range assignments {
		assignments[index].RoundID = roundID
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.game_round
		  (id, lobby_id, sequence_number, mode, map_version_id, hunter_count,
		   hiding_duration_seconds, hunting_duration_seconds, taunt_enabled,
		   taunt_interval_seconds, shell_limit, reload_duration_ms, auto_start_enabled,
		   auto_start_threshold, game_server_build_version, protocol_version, status,
		   result_schema_version, scoring_rule_version, started_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
		         $15, $16, 'preparing', $17, $18, $19)`,
		roundID,
		request.LobbyID,
		sequenceNumber,
		configuration.Mode,
		*configuration.MapVersionID,
		configuration.HunterCount,
		configuration.HidingDurationSeconds,
		configuration.HuntingDurationSeconds,
		configuration.TauntEnabled,
		nullableInt(configuration.TauntIntervalSeconds),
		configuration.ShellLimit,
		configuration.ReloadDurationMS,
		configuration.AutoStartEnabled,
		configuration.AutoStartThreshold,
		gameServerBuildVersion,
		matchProtocolVersion,
		resultSchemaVersion,
		scoringRuleVersion,
		startedAt,
	); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("insert round header: %w", err)
	}
	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby
		    SET row_version = row_version + 1
		  WHERE id = $1`,
		request.LobbyID,
	); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("advance lobby version for round start: %w", err)
	}
	snapshot, err := loadLobbySnapshot(ctx, tx, request.LobbyID)
	if err != nil {
		return lobbySnapshot{}, roundSnapshot{}, err
	}
	round := roundSnapshot{
		ID:              roundID,
		SequenceNumber:  sequenceNumber,
		Status:          "preparing",
		StartedAt:       startedAt,
		RoleAssignments: assignments,
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, roundSnapshot{}, fmt.Errorf("commit round start: %w", err)
	}
	return snapshot, round, nil
}

func (s *postgresLobbyStore) ActiveRound(
	ctx context.Context,
	lobbyID string,
) (*roundSnapshot, error) {
	var round roundSnapshot
	if err := s.database.QueryRowContext(
		ctx,
		`SELECT id::text, sequence_number, status::text, started_at
		   FROM game.game_round
		  WHERE lobby_id = $1
		    AND status NOT IN ('completed', 'aborted')
		  ORDER BY sequence_number DESC
		  LIMIT 1`,
		lobbyID,
	).Scan(&round.ID, &round.SequenceNumber, &round.Status, &round.StartedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("load active round: %w", err)
	}
	round.RoleAssignments = make([]roundRoleAssignment, 0)
	return &round, nil
}

func activeRoundExists(ctx context.Context, queryer lobbyQueryer, lobbyID string) (bool, error) {
	var active bool
	if err := queryer.QueryRowContext(
		ctx,
		`SELECT EXISTS (
		   SELECT 1
		     FROM game.game_round
		    WHERE lobby_id = $1
		      AND status NOT IN ('completed', 'aborted')
		 )`,
		lobbyID,
	).Scan(&active); err != nil {
		return false, fmt.Errorf("check active lobby round: %w", err)
	}
	return active, nil
}

func selectRoundRoles(
	members []string,
	nominations map[string]bool,
	hunterCount int,
	random io.Reader,
) ([]roundRoleAssignment, error) {
	if hunterCount < 1 || hunterCount >= len(members) {
		return nil, errors.New("hunter count must leave at least one hider")
	}
	seen := make(map[string]struct{}, len(members))
	volunteers := make([]string, 0, len(members))
	others := make([]string, 0, len(members))
	orderedMembers := append([]string(nil), members...)
	for _, playerID := range orderedMembers {
		if playerID == "" {
			return nil, errors.New("round member ID is required")
		}
		if _, exists := seen[playerID]; exists {
			return nil, errors.New("round members must be unique")
		}
		seen[playerID] = struct{}{}
		if nominations[playerID] {
			volunteers = append(volunteers, playerID)
		} else {
			others = append(others, playerID)
		}
	}
	sort.Strings(volunteers)
	sort.Strings(others)
	if err := shuffleStrings(volunteers, random); err != nil {
		return nil, err
	}
	if err := shuffleStrings(others, random); err != nil {
		return nil, err
	}
	candidates := append(volunteers, others...)
	hunters := make(map[string]struct{}, hunterCount)
	for _, playerID := range candidates[:hunterCount] {
		hunters[playerID] = struct{}{}
	}
	assignments := make([]roundRoleAssignment, 0, len(orderedMembers))
	for _, playerID := range orderedMembers {
		role := "hider"
		if _, hunter := hunters[playerID]; hunter {
			role = "hunter"
		}
		assignments = append(assignments, roundRoleAssignment{
			PlayerID:        playerID,
			Role:            role,
			HunterVolunteer: nominations[playerID],
		})
	}
	return assignments, nil
}

func shuffleStrings(values []string, random io.Reader) error {
	for index := len(values) - 1; index > 0; index-- {
		selected, err := rand.Int(random, big.NewInt(int64(index+1)))
		if err != nil {
			return fmt.Errorf("read role assignment randomness: %w", err)
		}
		swap := int(selected.Int64())
		values[index], values[swap] = values[swap], values[index]
	}
	return nil
}
