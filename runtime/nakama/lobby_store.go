package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
	"github.com/lib/pq"
	"golang.org/x/crypto/bcrypt"
)

const (
	lobbyDatabaseURLEnv = "HC_NAKAMA_DATABASE_URL"
	lobbyPasswordCost   = 12
)

type lobbyQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type postgresLobbyStore struct {
	database *sql.DB
	now      func() time.Time
}

func newPostgresLobbyStoreFromContext(ctx context.Context) (*postgresLobbyStore, error) {
	environment, ok := ctx.Value(runtimeContextEnvironmentKey()).(map[string]string)
	if !ok {
		return nil, errors.New("runtime environment is unavailable")
	}
	connectionString := strings.TrimSpace(environment[lobbyDatabaseURLEnv])
	if connectionString == "" {
		return nil, fmt.Errorf("%s is required", lobbyDatabaseURLEnv)
	}

	database, err := sql.Open("postgres", connectionString)
	if err != nil {
		return nil, fmt.Errorf("open application PostgreSQL: %w", err)
	}
	database.SetMaxOpenConns(10)
	database.SetMaxIdleConns(5)
	database.SetConnMaxIdleTime(30 * time.Second)

	pingContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := database.PingContext(pingContext); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("connect application PostgreSQL: %w", err)
	}
	return &postgresLobbyStore{database: database, now: time.Now}, nil
}

// runtimeContextEnvironmentKey keeps the runtime constant at the package boundary and makes the
// application database setup explicit about not using Nakama's injected internal *sql.DB.
func runtimeContextEnvironmentKey() any {
	return runtime.RUNTIME_CTX_ENV
}

func hashLobbyPassword(password string) (string, error) {
	if password == "" {
		return "", nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), lobbyPasswordCost)
	if err != nil {
		return "", fmt.Errorf("hash lobby password: %w", err)
	}
	return string(hash), nil
}

func (s *postgresLobbyStore) Create(
	ctx context.Context,
	playerID string,
	request createLobbyRequest,
	passwordHash string,
) (lobbySnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var existingLobbyID string
	err = tx.QueryRowContext(
		ctx,
		`SELECT lobby_id::text
		   FROM game.lobby_membership
		  WHERE player_id = $1
		    AND left_at IS NULL`,
		playerID,
	).Scan(&existingLobbyID)
	if err == nil {
		snapshot, loadErr := loadLobbySnapshot(ctx, tx, existingLobbyID)
		if loadErr != nil {
			return lobbySnapshot{}, loadErr
		}
		if err := tx.Commit(); err != nil {
			return lobbySnapshot{}, fmt.Errorf("commit existing lobby lookup: %w", err)
		}
		return snapshot, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return lobbySnapshot{}, fmt.Errorf("check current lobby membership: %w", err)
	}

	now := s.now().UTC()
	lobbyID, err := newUUIDV7(now)
	if err != nil {
		return lobbySnapshot{}, err
	}
	membershipID, err := newUUIDV7(now)
	if err != nil {
		return lobbySnapshot{}, err
	}
	assignmentID, err := newUUIDV7(now)
	if err != nil {
		return lobbySnapshot{}, err
	}

	var storedPassword any
	if request.Visibility == "private" {
		if passwordHash == "" {
			return lobbySnapshot{}, errors.New("private lobby password hash is unavailable")
		}
		storedPassword = passwordHash
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.lobby
		  (id, name, current_host_player_id, visibility, password_hash, max_players,
		   region_code, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		lobbyID,
		request.Name,
		playerID,
		request.Visibility,
		storedPassword,
		request.MaxPlayers,
		request.RegionCode,
		now,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("insert lobby: %w", err)
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.lobby_membership
		  (id, lobby_id, player_id, join_source, joined_at)
		 VALUES ($1, $2, $3, 'server_browser', $4)`,
		membershipID,
		lobbyID,
		playerID,
		now,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("insert lobby creator membership: %w", err)
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.lobby_host_assignment
		  (id, lobby_id, host_player_id, reason, started_at)
		 VALUES ($1, $2, $3, 'creator', $4)`,
		assignmentID,
		lobbyID,
		playerID,
		now,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("insert lobby creator host assignment: %w", err)
	}
	autoStartThreshold := int16(7)
	if request.MaxPlayers < autoStartThreshold {
		autoStartThreshold = request.MaxPlayers
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.lobby_configuration
		  (lobby_id, mode, hunter_count, hiding_duration_seconds, hunting_duration_seconds,
		   taunt_enabled, taunt_interval_seconds, shell_limit, reload_duration_ms,
		   auto_start_enabled, auto_start_threshold, updated_at)
		 VALUES ($1, 'casual', 1, 60, 180, true, 30, 6, 2000, true, $2, $3)`,
		lobbyID,
		autoStartThreshold,
		now,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("insert default lobby configuration: %w", err)
	}

	snapshot, err := loadLobbySnapshot(ctx, tx, lobbyID)
	if err != nil {
		return lobbySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("commit lobby creation: %w", err)
	}
	return snapshot, nil
}

func (s *postgresLobbyStore) Join(
	ctx context.Context,
	playerID string,
	request joinLobbyRequest,
) (lobbySnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var visibility string
	var passwordHash sql.NullString
	var maxPlayers int16
	var closedAt sql.NullTime
	if err := tx.QueryRowContext(
		ctx,
		`SELECT visibility::text, password_hash, max_players, closed_at
		   FROM game.lobby
		  WHERE id = $1
		  FOR UPDATE`,
		request.LobbyID,
	).Scan(&visibility, &passwordHash, &maxPlayers, &closedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbySnapshot{}, newLobbyProblem(grpcNotFound, "lobby not found")
		}
		return lobbySnapshot{}, fmt.Errorf("lock lobby for join: %w", err)
	}
	if closedAt.Valid {
		return lobbySnapshot{}, newLobbyProblem(grpcFailedPrecondition, "lobby is closed")
	}
	if visibility == "private" {
		if !passwordHash.Valid ||
			bcrypt.CompareHashAndPassword([]byte(passwordHash.String), []byte(request.Password)) != nil {
			return lobbySnapshot{}, newLobbyProblem(grpcPermissionDenied, "invalid lobby password")
		}
	}

	var currentLobbyID string
	err = tx.QueryRowContext(
		ctx,
		`SELECT lobby_id::text
		   FROM game.lobby_membership
		  WHERE player_id = $1
		    AND left_at IS NULL`,
		playerID,
	).Scan(&currentLobbyID)
	if err == nil {
		if currentLobbyID != request.LobbyID {
			return lobbySnapshot{}, newLobbyProblem(
				grpcFailedPrecondition,
				"player already belongs to another open lobby",
			)
		}
		snapshot, loadErr := loadLobbySnapshot(ctx, tx, request.LobbyID)
		if loadErr != nil {
			return lobbySnapshot{}, loadErr
		}
		if err := tx.Commit(); err != nil {
			return lobbySnapshot{}, fmt.Errorf("commit existing membership lookup: %w", err)
		}
		return snapshot, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return lobbySnapshot{}, fmt.Errorf("check current player membership: %w", err)
	}

	var activeMembers int
	if err := tx.QueryRowContext(
		ctx,
		`SELECT count(*)::integer
		   FROM game.lobby_membership
		  WHERE lobby_id = $1
		    AND left_at IS NULL`,
		request.LobbyID,
	).Scan(&activeMembers); err != nil {
		return lobbySnapshot{}, fmt.Errorf("count lobby members: %w", err)
	}
	if activeMembers >= int(maxPlayers) {
		return lobbySnapshot{}, newLobbyProblem(grpcFailedPrecondition, "lobby is full")
	}

	membershipID, err := newUUIDV7(s.now().UTC())
	if err != nil {
		return lobbySnapshot{}, err
	}
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.lobby_membership
		  (id, lobby_id, player_id, join_source)
		 VALUES ($1, $2, $3, $4)`,
		membershipID,
		request.LobbyID,
		playerID,
		request.JoinSource,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("insert lobby membership: %w", err)
	}
	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby
		    SET row_version = row_version + 1
		  WHERE id = $1`,
		request.LobbyID,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("advance lobby version after join: %w", err)
	}

	snapshot, err := loadLobbySnapshot(ctx, tx, request.LobbyID)
	if err != nil {
		return lobbySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("commit lobby join: %w", err)
	}
	return snapshot, nil
}

func (s *postgresLobbyStore) Snapshot(
	ctx context.Context,
	lobbyID string,
) (lobbySnapshot, error) {
	return loadLobbySnapshot(ctx, s.database, lobbyID)
}

func (s *postgresLobbyStore) IsOpenMember(
	ctx context.Context,
	lobbyID string,
	playerID string,
) (bool, error) {
	var member bool
	if err := s.database.QueryRowContext(
		ctx,
		`SELECT EXISTS (
		   SELECT 1
		     FROM game.lobby AS lobby
		     JOIN game.lobby_membership AS membership
		       ON membership.lobby_id = lobby.id
		      AND membership.player_id = $2
		      AND membership.left_at IS NULL
		    WHERE lobby.id = $1
		      AND lobby.closed_at IS NULL
		 )`,
		lobbyID,
		playerID,
	).Scan(&member); err != nil {
		return false, fmt.Errorf("check open lobby membership: %w", err)
	}
	return member, nil
}

func (s *postgresLobbyStore) UpdateConfiguration(
	ctx context.Context,
	playerID string,
	request updateLobbyConfigurationRequest,
) (lobbySnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	current, maxPlayers, err := lockHostConfiguration(
		ctx,
		tx,
		request.LobbyID,
		playerID,
		request.ExpectedLobbyVersion,
	)
	if err != nil {
		return lobbySnapshot{}, err
	}
	next, err := applyConfigurationPatch(current, request, maxPlayers)
	if err != nil {
		return lobbySnapshot{}, err
	}
	now := s.now().UTC()
	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby_configuration
		    SET mode = $2,
		        map_version_id = $3,
		        hunter_count = $4,
		        hiding_duration_seconds = $5,
		        hunting_duration_seconds = $6,
		        taunt_enabled = $7,
		        taunt_interval_seconds = $8,
		        shell_limit = $9,
		        reload_duration_ms = $10,
		        auto_start_enabled = $11,
		        auto_start_threshold = $12,
		        updated_at = $13,
		        row_version = row_version + 1
		  WHERE lobby_id = $1`,
		request.LobbyID,
		next.Mode,
		nullableString(next.MapVersionID),
		next.HunterCount,
		next.HidingDurationSeconds,
		next.HuntingDurationSeconds,
		next.TauntEnabled,
		nullableInt(next.TauntIntervalSeconds),
		next.ShellLimit,
		next.ReloadDurationMS,
		next.AutoStartEnabled,
		next.AutoStartThreshold,
		now,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("update lobby configuration: %w", err)
	}
	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby
		    SET row_version = row_version + 1
		  WHERE id = $1`,
		request.LobbyID,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("advance lobby version after configuration: %w", err)
	}

	snapshot, err := loadLobbySnapshot(ctx, tx, request.LobbyID)
	if err != nil {
		return lobbySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("commit lobby configuration: %w", err)
	}
	return snapshot, nil
}

func (s *postgresLobbyStore) AcceptStart(
	ctx context.Context,
	playerID string,
	request startLobbyRequest,
) (lobbySnapshot, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, err
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
		return lobbySnapshot{}, err
	}
	var activeMembers int
	if err := tx.QueryRowContext(
		ctx,
		`SELECT count(*)::integer
		   FROM game.lobby_membership
		  WHERE lobby_id = $1
		    AND left_at IS NULL`,
		request.LobbyID,
	).Scan(&activeMembers); err != nil {
		return lobbySnapshot{}, fmt.Errorf("count start-eligible lobby members: %w", err)
	}
	if activeMembers < int(configuration.HunterCount)+1 {
		return lobbySnapshot{}, newLobbyProblem(
			grpcFailedPrecondition,
			"lobby needs the configured hunters plus at least one hider",
		)
	}
	if _, err := tx.ExecContext(
		ctx,
		`UPDATE game.lobby
		    SET row_version = row_version + 1
		  WHERE id = $1`,
		request.LobbyID,
	); err != nil {
		return lobbySnapshot{}, fmt.Errorf("advance lobby version for start: %w", err)
	}
	snapshot, err := loadLobbySnapshot(ctx, tx, request.LobbyID)
	if err != nil {
		return lobbySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("commit lobby start acceptance: %w", err)
	}
	return snapshot, nil
}

func (s *postgresLobbyStore) Leave(
	ctx context.Context,
	lobbyID string,
	playerIDs []string,
	hostReason string,
) (lobbySnapshot, bool, error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return lobbySnapshot{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var currentHostID string
	var closedAt sql.NullTime
	if err := tx.QueryRowContext(
		ctx,
		`SELECT current_host_player_id::text, closed_at
		   FROM game.lobby
		  WHERE id = $1
		  FOR UPDATE`,
		lobbyID,
	).Scan(&currentHostID, &closedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbySnapshot{}, false, newLobbyProblem(grpcNotFound, "lobby not found")
		}
		return lobbySnapshot{}, false, fmt.Errorf("lock lobby for leave: %w", err)
	}
	if closedAt.Valid {
		snapshot, loadErr := loadLobbySnapshot(ctx, tx, lobbyID)
		return snapshot, true, loadErr
	}
	if len(playerIDs) == 0 {
		snapshot, loadErr := loadLobbySnapshot(ctx, tx, lobbyID)
		return snapshot, false, loadErr
	}

	now := s.now().UTC()
	rows, err := tx.QueryContext(
		ctx,
		`UPDATE game.lobby_membership
		    SET left_at = $3
		  WHERE lobby_id = $1
		    AND player_id = ANY($2::uuid[])
		    AND left_at IS NULL
		RETURNING player_id::text`,
		lobbyID,
		pq.Array(playerIDs),
		now,
	)
	if err != nil {
		return lobbySnapshot{}, false, fmt.Errorf("close lobby memberships: %w", err)
	}
	affected := make(map[string]struct{}, len(playerIDs))
	for rows.Next() {
		var playerID string
		if err := rows.Scan(&playerID); err != nil {
			_ = rows.Close()
			return lobbySnapshot{}, false, fmt.Errorf("read closed lobby membership: %w", err)
		}
		affected[playerID] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return lobbySnapshot{}, false, fmt.Errorf("close membership result: %w", err)
	}
	if len(affected) == 0 {
		snapshot, loadErr := loadLobbySnapshot(ctx, tx, lobbyID)
		if loadErr != nil {
			return lobbySnapshot{}, false, loadErr
		}
		if err := tx.Commit(); err != nil {
			return lobbySnapshot{}, false, fmt.Errorf("commit idempotent lobby leave: %w", err)
		}
		return snapshot, snapshot.Closed, nil
	}

	_, hostDeparted := affected[currentHostID]
	closed := false
	if hostDeparted {
		if hostReason != "host_left" && hostReason != "host_disconnected" {
			return lobbySnapshot{}, false, errors.New("invalid host departure reason")
		}
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE game.lobby_host_assignment
			    SET ended_at = $2
			  WHERE lobby_id = $1
			    AND ended_at IS NULL`,
			lobbyID,
			now,
		); err != nil {
			return lobbySnapshot{}, false, fmt.Errorf("close current host assignment: %w", err)
		}

		var replacementHostID string
		err := tx.QueryRowContext(
			ctx,
			`SELECT player_id::text
			   FROM game.lobby_membership
			  WHERE lobby_id = $1
			    AND left_at IS NULL
			  ORDER BY joined_at, id
			  LIMIT 1`,
			lobbyID,
		).Scan(&replacementHostID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			closed = true
			if _, err := tx.ExecContext(
				ctx,
				`UPDATE game.lobby
				    SET closed_at = $2,
				        row_version = row_version + 1
				  WHERE id = $1`,
				lobbyID,
				now,
			); err != nil {
				return lobbySnapshot{}, false, fmt.Errorf("close empty lobby: %w", err)
			}
		case err != nil:
			return lobbySnapshot{}, false, fmt.Errorf("select replacement lobby host: %w", err)
		default:
			assignmentID, idErr := newUUIDV7(now)
			if idErr != nil {
				return lobbySnapshot{}, false, idErr
			}
			if _, err := tx.ExecContext(
				ctx,
				`INSERT INTO game.lobby_host_assignment
				  (id, lobby_id, host_player_id, reason, started_at)
				 VALUES ($1, $2, $3, $4, $5)`,
				assignmentID,
				lobbyID,
				replacementHostID,
				hostReason,
				now,
			); err != nil {
				return lobbySnapshot{}, false, fmt.Errorf("insert replacement host assignment: %w", err)
			}
			if _, err := tx.ExecContext(
				ctx,
				`UPDATE game.lobby
				    SET current_host_player_id = $2,
				        row_version = row_version + 1
				  WHERE id = $1`,
				lobbyID,
				replacementHostID,
			); err != nil {
				return lobbySnapshot{}, false, fmt.Errorf("assign replacement lobby host: %w", err)
			}
		}
	} else {
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE game.lobby
			    SET row_version = row_version + 1
			  WHERE id = $1`,
			lobbyID,
		); err != nil {
			return lobbySnapshot{}, false, fmt.Errorf("advance lobby version after leave: %w", err)
		}
	}

	snapshot, err := loadLobbySnapshot(ctx, tx, lobbyID)
	if err != nil {
		return lobbySnapshot{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return lobbySnapshot{}, false, fmt.Errorf("commit lobby leave: %w", err)
	}
	return snapshot, closed, nil
}

func (s *postgresLobbyStore) begin(ctx context.Context) (*sql.Tx, error) {
	tx, err := s.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("begin serializable lobby transaction: %w", err)
	}
	return tx, nil
}

func lockHostConfiguration(
	ctx context.Context,
	tx *sql.Tx,
	lobbyID string,
	playerID string,
	expectedVersion int64,
) (lobbyConfigurationSnapshot, int16, error) {
	var currentHostID, assignedHostID string
	var currentVersion int64
	var maxPlayers int16
	var closedAt sql.NullTime
	var configuration lobbyConfigurationSnapshot
	var mapVersionID sql.NullString
	var tauntInterval sql.NullInt64
	if err := tx.QueryRowContext(
		ctx,
		`SELECT lobby.current_host_player_id::text,
		        assignment.host_player_id::text,
		        lobby.row_version,
		        lobby.max_players,
		        lobby.closed_at,
		        configuration.mode::text,
		        configuration.map_version_id::text,
		        configuration.hunter_count,
		        configuration.hiding_duration_seconds,
		        configuration.hunting_duration_seconds,
		        configuration.taunt_enabled,
		        configuration.taunt_interval_seconds,
		        configuration.shell_limit,
		        configuration.reload_duration_ms,
		        configuration.auto_start_enabled,
		        configuration.auto_start_threshold,
		        configuration.row_version
		   FROM game.lobby AS lobby
		   JOIN game.lobby_host_assignment AS assignment
		     ON assignment.lobby_id = lobby.id
		    AND assignment.ended_at IS NULL
		   JOIN game.lobby_configuration AS configuration
		     ON configuration.lobby_id = lobby.id
		  WHERE lobby.id = $1
		  FOR UPDATE OF lobby, assignment, configuration`,
		lobbyID,
	).Scan(
		&currentHostID,
		&assignedHostID,
		&currentVersion,
		&maxPlayers,
		&closedAt,
		&configuration.Mode,
		&mapVersionID,
		&configuration.HunterCount,
		&configuration.HidingDurationSeconds,
		&configuration.HuntingDurationSeconds,
		&configuration.TauntEnabled,
		&tauntInterval,
		&configuration.ShellLimit,
		&configuration.ReloadDurationMS,
		&configuration.AutoStartEnabled,
		&configuration.AutoStartThreshold,
		&configuration.RowVersion,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbyConfigurationSnapshot{}, 0, newLobbyProblem(
				grpcNotFound,
				"open lobby not found",
			)
		}
		return lobbyConfigurationSnapshot{}, 0, fmt.Errorf("lock host lobby command: %w", err)
	}
	if closedAt.Valid {
		return lobbyConfigurationSnapshot{}, 0, newLobbyProblem(
			grpcFailedPrecondition,
			"lobby is closed",
		)
	}
	if currentHostID != assignedHostID {
		return lobbyConfigurationSnapshot{}, 0, errors.New("lobby host assignment is inconsistent")
	}
	if playerID != assignedHostID {
		return lobbyConfigurationSnapshot{}, 0, newLobbyProblem(
			grpcPermissionDenied,
			"current lobby host required",
		)
	}
	if currentVersion != expectedVersion {
		return lobbyConfigurationSnapshot{}, 0, newLobbyProblem(
			grpcAborted,
			"lobby version changed; refresh state and retry",
		)
	}
	if mapVersionID.Valid {
		configuration.MapVersionID = &mapVersionID.String
	}
	if tauntInterval.Valid {
		interval := int(tauntInterval.Int64)
		configuration.TauntIntervalSeconds = &interval
	}
	return configuration, maxPlayers, nil
}

func loadLobbySnapshot(
	ctx context.Context,
	queryer lobbyQueryer,
	lobbyID string,
) (lobbySnapshot, error) {
	var snapshot lobbySnapshot
	var closedAt sql.NullTime
	var mapVersionID sql.NullString
	var tauntInterval sql.NullInt64
	if err := queryer.QueryRowContext(
		ctx,
		`SELECT lobby.id::text,
		        lobby.name,
		        lobby.visibility::text,
		        lobby.max_players,
		        lobby.region_code,
		        lobby.current_host_player_id::text,
		        lobby.row_version,
		        lobby.closed_at,
		        configuration.mode::text,
		        configuration.map_version_id::text,
		        configuration.hunter_count,
		        configuration.hiding_duration_seconds,
		        configuration.hunting_duration_seconds,
		        configuration.taunt_enabled,
		        configuration.taunt_interval_seconds,
		        configuration.shell_limit,
		        configuration.reload_duration_ms,
		        configuration.auto_start_enabled,
		        configuration.auto_start_threshold,
		        configuration.row_version
		   FROM game.lobby AS lobby
		   JOIN game.lobby_configuration AS configuration
		     ON configuration.lobby_id = lobby.id
		  WHERE lobby.id = $1`,
		lobbyID,
	).Scan(
		&snapshot.ID,
		&snapshot.Name,
		&snapshot.Visibility,
		&snapshot.MaxPlayers,
		&snapshot.RegionCode,
		&snapshot.CurrentHostPlayerID,
		&snapshot.RowVersion,
		&closedAt,
		&snapshot.Configuration.Mode,
		&mapVersionID,
		&snapshot.Configuration.HunterCount,
		&snapshot.Configuration.HidingDurationSeconds,
		&snapshot.Configuration.HuntingDurationSeconds,
		&snapshot.Configuration.TauntEnabled,
		&tauntInterval,
		&snapshot.Configuration.ShellLimit,
		&snapshot.Configuration.ReloadDurationMS,
		&snapshot.Configuration.AutoStartEnabled,
		&snapshot.Configuration.AutoStartThreshold,
		&snapshot.Configuration.RowVersion,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lobbySnapshot{}, newLobbyProblem(grpcNotFound, "lobby not found")
		}
		return lobbySnapshot{}, fmt.Errorf("load lobby snapshot: %w", err)
	}
	snapshot.Closed = closedAt.Valid
	if mapVersionID.Valid {
		snapshot.Configuration.MapVersionID = &mapVersionID.String
	}
	if tauntInterval.Valid {
		interval := int(tauntInterval.Int64)
		snapshot.Configuration.TauntIntervalSeconds = &interval
	}
	snapshot.Members = make([]lobbyMemberSnapshot, 0, snapshot.MaxPlayers)
	rows, err := queryer.QueryContext(
		ctx,
		`SELECT player_id::text, joined_at
		   FROM game.lobby_membership
		  WHERE lobby_id = $1
		    AND left_at IS NULL
		  ORDER BY joined_at, id`,
		lobbyID,
	)
	if err != nil {
		return lobbySnapshot{}, fmt.Errorf("load lobby members: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var member lobbyMemberSnapshot
		if err := rows.Scan(&member.PlayerID, &member.JoinedAt); err != nil {
			return lobbySnapshot{}, fmt.Errorf("scan lobby member: %w", err)
		}
		snapshot.Members = append(snapshot.Members, member)
	}
	if err := rows.Err(); err != nil {
		return lobbySnapshot{}, fmt.Errorf("iterate lobby members: %w", err)
	}
	return snapshot, nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}
