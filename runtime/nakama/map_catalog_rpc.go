package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

type availableOfficialMap struct {
	MapVersionID              string `json:"map_version_id"`
	MapSlug                   string `json:"map_slug"`
	DisplayName               string `json:"display_name"`
	Description               string `json:"description"`
	ContentVersion            string `json:"content_version"`
	AuthorityGeometryVersion  string `json:"authority_geometry_version"`
	AuthorityGeometryDigest   string `json:"authority_geometry_digest"`
	RecommendedMinimumPlayers int    `json:"recommended_minimum_players"`
	RecommendedMaximumPlayers int    `json:"recommended_maximum_players"`
}

type availableOfficialMapResponse struct {
	Maps []availableOfficialMap `json:"maps"`
}

func (s *lobbyService) mapsRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ string,
) (string, error) {
	if _, err := trustedPlayerID(ctx); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	catalog, ok := s.store.(interface {
		AvailableMaps(context.Context) ([]availableOfficialMap, error)
	})
	if !ok {
		return "", runtime.NewError("lobby service unavailable", grpcUnavailable)
	}
	maps, err := catalog.AvailableMaps(ctx)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.maps", err)
	}
	payload, err := json.Marshal(availableOfficialMapResponse{Maps: maps})
	if err != nil {
		logger.Error("lobby.maps response encoding failed: %v", err)
		return "", runtime.NewError("lobby service unavailable", grpcUnavailable)
	}
	return string(payload), nil
}

func loadAvailableOfficialMaps(
	ctx context.Context,
	queryer lobbyQueryer,
) ([]availableOfficialMap, error) {
	if queryer == nil {
		return nil, fmt.Errorf("map catalog database is unavailable")
	}
	rows, err := queryer.QueryContext(
		ctx,
		`SELECT version.id::text,
		        map_definition.slug,
		        map_definition.title,
		        map_definition.description,
		        version.version_number,
		        min(distribution.required_game_build_version),
		        min(distribution.required_protocol_version)
		   FROM content.map AS map_definition
		   JOIN content.map_version AS version
		     ON version.map_id = map_definition.id
		   JOIN content.map_distribution AS distribution
		     ON distribution.map_version_id = version.id
		  WHERE map_definition.origin = 'official'
		    AND map_definition.lifecycle = 'published'
		    AND map_definition.creator_player_id IS NULL
		    AND version.status = 'published'
		    AND distribution.platform IN ('desktop', 'web')
		    AND distribution.state = 'available'
		    AND distribution.required_protocol_version IS NOT NULL
		    AND distribution.published_at IS NOT NULL
		  GROUP BY version.id,
		           map_definition.slug,
		           map_definition.title,
		           map_definition.description,
		           version.version_number
		 HAVING count(*) = 2
		    AND count(DISTINCT distribution.platform) = 2
		    AND min(distribution.required_game_build_version)
		        = max(distribution.required_game_build_version)
		    AND min(distribution.required_protocol_version)
		        = max(distribution.required_protocol_version)
		  ORDER BY map_definition.title, max(version.published_at) DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("query available official maps: %w", err)
	}
	defer rows.Close()

	maps := make([]availableOfficialMap, 0, len(officialArenaDefinitions))
	for rows.Next() {
		var mapVersionID string
		var slug string
		var displayName string
		var description string
		var contentVersion string
		var gameBuildVersion string
		var protocolVersion string
		if err := rows.Scan(
			&mapVersionID,
			&slug,
			&displayName,
			&description,
			&contentVersion,
			&gameBuildVersion,
			&protocolVersion,
		); err != nil {
			return nil, fmt.Errorf("scan available official map: %w", err)
		}
		definition, supported := officialArenaForContent(slug, contentVersion)
		if !supported ||
			gameBuildVersion != gameServerBuildVersion ||
			protocolVersion != matchProtocolVersion {
			continue
		}
		maps = append(maps, availableOfficialMap{
			MapVersionID:              mapVersionID,
			MapSlug:                   slug,
			DisplayName:               displayName,
			Description:               description,
			ContentVersion:            contentVersion,
			AuthorityGeometryVersion:  definition.Geometry.Version,
			AuthorityGeometryDigest:   definition.GeometryDigest,
			RecommendedMinimumPlayers: definition.RecommendedMinimumPlayers,
			RecommendedMaximumPlayers: definition.RecommendedMaximumPlayers,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate available official maps: %w", err)
	}
	if len(maps) == 0 {
		return nil, newLobbyProblem(
			grpcFailedPrecondition,
			"no compatible official maps are available",
		)
	}
	return maps, nil
}

func (s *postgresLobbyStore) AvailableMaps(
	ctx context.Context,
) ([]availableOfficialMap, error) {
	return loadAvailableOfficialMaps(ctx, s.database)
}
