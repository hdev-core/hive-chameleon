package main

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestAvailableOfficialMapsReturnsOnlyBundledCompatibleReleases(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	rows := sqlmock.NewRows([]string{
		"id",
		"slug",
		"title",
		"description",
		"version_number",
		"required_game_build_version",
		"required_protocol_version",
	}).
		AddRow(
			"019fab2b-c400-7000-8000-000000000015",
			neonServiceArcadeMapSlug,
			"Neon Service Arcade",
			"Arcade arena",
			neonServiceArcadeContentVersion,
			gameServerBuildVersion,
			matchProtocolVersion,
		).
		AddRow(
			"019fab2b-c400-7000-8000-000000000099",
			"server-only-map",
			"Unsupported Map",
			"Not bundled by this client release",
			"m1",
			gameServerBuildVersion,
			matchProtocolVersion,
		)
	mock.ExpectQuery("SELECT version.id::text").WillReturnRows(rows)

	maps, err := loadAvailableOfficialMaps(context.Background(), database)
	if err != nil {
		t.Fatalf("load available maps: %v", err)
	}
	if len(maps) != 1 {
		t.Fatalf("available map count = %d, want 1: %#v", len(maps), maps)
	}
	for _, available := range maps {
		arena, ok := officialArenaForContent(
			available.MapSlug,
			available.ContentVersion,
		)
		if !ok {
			t.Fatalf("unbundled map returned: %#v", available)
		}
		if available.AuthorityGeometryVersion != arena.Geometry.Version ||
			available.AuthorityGeometryDigest != arena.GeometryDigest ||
			available.RecommendedMinimumPlayers != arena.RecommendedMinimumPlayers ||
			available.RecommendedMaximumPlayers != arena.RecommendedMaximumPlayers {
			t.Fatalf("map catalog metadata mismatch: %#v", available)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestAvailableOfficialMapsRejectsEmptyCompatibleCatalog(t *testing.T) {
	t.Parallel()

	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	mock.ExpectQuery("SELECT version.id::text").WillReturnRows(
		sqlmock.NewRows([]string{
			"id",
			"slug",
			"title",
			"description",
			"version_number",
			"required_game_build_version",
			"required_protocol_version",
		}),
	)

	if _, err := loadAvailableOfficialMaps(context.Background(), database); err == nil {
		t.Fatal("empty compatible map catalog should be rejected")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}
