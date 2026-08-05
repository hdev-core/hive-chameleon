package main

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestCreateLobbySelectsCurrentAvailableOfficialMap(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	playerID := "01900000-0000-7000-8000-000000000011"
	mapVersionID := "01900000-0000-7000-8000-000000000222"
	request := createLobbyRequest{
		Name:       "Map Default",
		Visibility: "public",
		MaxPlayers: 10,
		RegionCode: "eu-central",
	}
	store := &postgresLobbyStore{
		database: database,
		now:      func() time.Time { return now },
	}

	mock.ExpectBegin()
	mock.ExpectQuery("SELECT lobby_id::text").
		WithArgs(playerID).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT version.id::text").
		WithArgs(
			defaultOfficialMapSlug,
			defaultOfficialMapContentVersion,
			gameServerBuildVersion,
			matchProtocolVersion,
		).
		WillReturnRows(
			sqlmock.NewRows([]string{"id"}).AddRow(mapVersionID),
		)
	mock.ExpectExec("INSERT INTO game.lobby").
		WithArgs(
			sqlmock.AnyArg(),
			request.Name,
			playerID,
			request.Visibility,
			nil,
			request.MaxPlayers,
			request.RegionCode,
			now,
		).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.lobby_membership").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), playerID, now).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.lobby_host_assignment").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), playerID, now).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.lobby_configuration").
		WithArgs(sqlmock.AnyArg(), mapVersionID, int16(7), now).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT lobby.id::text").
		WithArgs(sqlmock.AnyArg()).
		WillReturnRows(
			sqlmock.NewRows([]string{
				"id",
				"name",
				"visibility",
				"max_players",
				"region_code",
				"current_host_player_id",
				"row_version",
				"closed_at",
				"mode",
				"map_version_id",
				"hunter_count",
				"hiding_duration_seconds",
				"hunting_duration_seconds",
				"taunt_enabled",
				"taunt_interval_seconds",
				"shell_limit",
				"reload_duration_ms",
				"auto_start_enabled",
				"auto_start_threshold",
				"configuration_row_version",
			}).AddRow(
				"01900000-0000-7000-8000-000000000100",
				request.Name,
				request.Visibility,
				request.MaxPlayers,
				request.RegionCode,
				playerID,
				int64(1),
				nil,
				"casual",
				mapVersionID,
				int16(1),
				60,
				180,
				true,
				30,
				6,
				2000,
				true,
				int16(7),
				int64(1),
			),
		)
	mock.ExpectQuery("SELECT membership.player_id::text").
		WithArgs(sqlmock.AnyArg()).
		WillReturnRows(
			sqlmock.NewRows(
				[]string{
					"player_id",
					"hive_username",
					"joined_at",
					"hunter_nominated",
				},
			).AddRow(playerID, "ChromaPlayer", now, false),
		)
	mock.ExpectCommit()

	snapshot, err := store.Create(context.Background(), playerID, request, "")
	if err != nil {
		t.Fatalf("create lobby: %v", err)
	}
	if snapshot.Configuration.MapVersionID == nil ||
		*snapshot.Configuration.MapVersionID != mapVersionID {
		t.Fatalf("default map version was not returned: %#v", snapshot.Configuration)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestDefaultOfficialMapVersionAllowsUnpublishedFallback(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	mock.ExpectQuery("SELECT version.id::text").
		WithArgs(
			defaultOfficialMapSlug,
			defaultOfficialMapContentVersion,
			gameServerBuildVersion,
			matchProtocolVersion,
		).
		WillReturnError(sql.ErrNoRows)
	mapVersionID, err := loadDefaultOfficialMapVersionID(
		context.Background(),
		database,
	)
	if err != nil {
		t.Fatalf("load absent default map: %v", err)
	}
	if mapVersionID != nil {
		t.Fatalf("absent official map returned %q", *mapVersionID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestOfficialRoundMapReturnsCurrentDistributionCompatibility(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	mapVersionID := "019fab2b-c400-7000-8000-000000000002"
	mock.ExpectQuery("SELECT version.version_number").
		WithArgs(
			mapVersionID,
			defaultOfficialMapSlug,
			defaultOfficialMapContentVersion,
		).
		WillReturnRows(
			sqlmock.NewRows(
				[]string{
					"version_number",
					"required_game_build_version",
					"required_protocol_version",
				},
			).AddRow(
				defaultOfficialMapContentVersion,
				gameServerBuildVersion,
				matchProtocolVersion,
			),
		)
	contract, err := loadOfficialRoundMapContract(
		context.Background(),
		database,
		mapVersionID,
	)
	if err != nil {
		t.Fatalf("validate current official map: %v", err)
	}
	if contract.ContentVersion != defaultOfficialMapContentVersion ||
		contract.GameServerBuildVersion != gameServerBuildVersion ||
		contract.ProtocolVersion != matchProtocolVersion {
		t.Fatalf("official compatibility contract = %#v", contract)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestOfficialRoundMapRejectsUnavailableVersion(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	mapVersionID := "01900000-0000-7000-8000-000000000222"
	mock.ExpectQuery("SELECT version.version_number").
		WithArgs(
			mapVersionID,
			defaultOfficialMapSlug,
			defaultOfficialMapContentVersion,
		).
		WillReturnError(sql.ErrNoRows)
	if _, err := loadOfficialRoundMapContract(
		context.Background(),
		database,
		mapVersionID,
	); err == nil {
		t.Fatal("accepted a non-current or undistributed map version")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestOfficialRoundMapRejectsIncompatibleDistributionContract(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	mapVersionID := "019fab2b-c400-7000-8000-000000000002"
	mock.ExpectQuery("SELECT version.version_number").
		WithArgs(
			mapVersionID,
			defaultOfficialMapSlug,
			defaultOfficialMapContentVersion,
		).
		WillReturnRows(
			sqlmock.NewRows(
				[]string{
					"version_number",
					"required_game_build_version",
					"required_protocol_version",
				},
			).AddRow(
				defaultOfficialMapContentVersion,
				"hive-chameleon-m5",
				"m5-v1",
			),
		)
	if _, err := loadOfficialRoundMapContract(
		context.Background(),
		database,
		mapVersionID,
	); err == nil {
		t.Fatal("accepted an incompatible official map distribution")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}
