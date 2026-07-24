package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	lobbyMatchModule            = "persistent_lobby"
	lobbyMatchBindingCollection = "hc_lobby_match"
)

type lobbyService struct {
	store lobbyStore
}

type lobbyNakama interface {
	MatchCreate(context.Context, string, map[string]interface{}) (string, error)
	MatchGet(context.Context, string) (*api.Match, error)
	MatchSignal(context.Context, string, string) (string, error)
	StorageRead(context.Context, []*runtime.StorageRead) ([]*api.StorageObject, error)
	StorageWrite(context.Context, []*runtime.StorageWrite) ([]*api.StorageObjectAck, error)
}

type lobbyMatchBinding struct {
	MatchID string `json:"match_id"`
}

type lobbySignal struct {
	Type                string                           `json:"type"`
	PlayerID            string                           `json:"player_id,omitempty"`
	LeaveReason         string                           `json:"leave_reason,omitempty"`
	UpdateConfiguration *updateLobbyConfigurationRequest `json:"update_configuration,omitempty"`
	Start               *startLobbyRequest               `json:"start,omitempty"`
}

type lobbySignalResult struct {
	Response *lobbyRPCResponse `json:"response,omitempty"`
	Error    string            `json:"error,omitempty"`
	Code     int               `json:"code,omitempty"`
}

func (s *lobbyService) createRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", asLobbyRuntimeError(err)
	}
	var request createLobbyRequest
	if err := decodeLobbyPayload(payload, &request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	if err := validateCreateLobby(&request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	passwordHash, err := hashLobbyPassword(request.Password)
	if err != nil {
		logger.Error("lobby.create password hashing failed: %v", err)
		return "", asLobbyRuntimeError(err)
	}
	snapshot, err := s.store.Create(ctx, playerID, request, passwordHash)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.create", err)
	}
	matchID, err := ensureLobbyMatch(ctx, nk, snapshot.ID)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.create match binding", err)
	}
	response := lobbyRPCResponse{MatchID: matchID, Lobby: snapshot}
	return encodeLobbyResponse(response)
}

func (s *lobbyService) joinRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", asLobbyRuntimeError(err)
	}
	var request joinLobbyRequest
	if err := decodeLobbyPayload(payload, &request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	if err := validateJoinLobby(&request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	snapshot, err := s.store.Join(ctx, playerID, request)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.join", err)
	}
	matchID, err := ensureLobbyMatch(ctx, nk, snapshot.ID)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.join match binding", err)
	}
	_, _ = sendLobbySignal(ctx, nk, matchID, lobbySignal{Type: "sync"})
	response := lobbyRPCResponse{MatchID: matchID, Lobby: snapshot}
	return encodeLobbyResponse(response)
}

func (s *lobbyService) leaveRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", asLobbyRuntimeError(err)
	}
	var request leaveLobbyRequest
	if err := decodeLobbyPayload(payload, &request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	if err := validateLobbyID(request.LobbyID); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	matchID, err := ensureLobbyMatch(ctx, nk, request.LobbyID)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.leave match binding", err)
	}
	response, err := sendLobbySignal(ctx, nk, matchID, lobbySignal{
		Type:        "leave",
		PlayerID:    playerID,
		LeaveReason: "host_left",
	})
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.leave", err)
	}
	return encodeLobbyResponse(*response)
}

func (s *lobbyService) updateConfigurationRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", asLobbyRuntimeError(err)
	}
	var request updateLobbyConfigurationRequest
	if err := decodeLobbyPayload(payload, &request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	if err := validateHostVersion(request.LobbyID, request.ExpectedLobbyVersion); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	matchID, err := ensureLobbyMatch(ctx, nk, request.LobbyID)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.update_configuration match binding", err)
	}
	response, err := sendLobbySignal(ctx, nk, matchID, lobbySignal{
		Type:                "update_configuration",
		PlayerID:            playerID,
		UpdateConfiguration: &request,
	})
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.update_configuration", err)
	}
	return encodeLobbyResponse(*response)
}

func (s *lobbyService) startRPC(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", asLobbyRuntimeError(err)
	}
	var request startLobbyRequest
	if err := decodeLobbyPayload(payload, &request); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	if err := validateHostVersion(request.LobbyID, request.ExpectedLobbyVersion); err != nil {
		return "", asLobbyRuntimeError(err)
	}
	matchID, err := ensureLobbyMatch(ctx, nk, request.LobbyID)
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.start match binding", err)
	}
	response, err := sendLobbySignal(ctx, nk, matchID, lobbySignal{
		Type:     "start",
		PlayerID: playerID,
		Start:    &request,
	})
	if err != nil {
		return "", logLobbyFailure(logger, "lobby.start", err)
	}
	return encodeLobbyResponse(*response)
}

func ensureLobbyMatch(
	ctx context.Context,
	nk lobbyNakama,
	lobbyID string,
) (string, error) {
	object, err := readLobbyMatchBinding(ctx, nk, lobbyID)
	if err != nil {
		return "", err
	}
	if object != nil {
		binding, parseErr := parseLobbyMatchBinding(object.Value)
		if parseErr == nil {
			match, getErr := nk.MatchGet(ctx, binding.MatchID)
			if getErr == nil && match != nil {
				return binding.MatchID, nil
			}
		}
	}

	candidateID, err := nk.MatchCreate(
		ctx,
		lobbyMatchModule,
		map[string]interface{}{"lobby_id": lobbyID},
	)
	if err != nil {
		return "", fmt.Errorf("create authoritative lobby match: %w", err)
	}
	value, err := json.Marshal(lobbyMatchBinding{MatchID: candidateID})
	if err != nil {
		return "", fmt.Errorf("encode lobby match binding: %w", err)
	}
	version := "*"
	if object != nil {
		version = object.Version
	}
	_, writeErr := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      lobbyMatchBindingCollection,
		Key:             lobbyID,
		Value:           string(value),
		Version:         version,
		PermissionRead:  0,
		PermissionWrite: 0,
	}})
	if writeErr == nil {
		return candidateID, nil
	}

	// Another caller may have won the optimistic binding race. Stop this duplicate and use the
	// winner only after checking that it is live.
	_, _ = nk.MatchSignal(ctx, candidateID, `{"type":"terminate_duplicate"}`)
	winner, readErr := readLobbyMatchBinding(ctx, nk, lobbyID)
	if readErr != nil || winner == nil {
		return "", fmt.Errorf("claim authoritative lobby match: %w", writeErr)
	}
	binding, parseErr := parseLobbyMatchBinding(winner.Value)
	if parseErr != nil {
		return "", parseErr
	}
	match, getErr := nk.MatchGet(ctx, binding.MatchID)
	if getErr != nil || match == nil {
		return "", fmt.Errorf("authoritative lobby match binding changed concurrently")
	}
	return binding.MatchID, nil
}

func readLobbyMatchBinding(
	ctx context.Context,
	nk lobbyNakama,
	lobbyID string,
) (*api.StorageObject, error) {
	objects, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
		Collection: lobbyMatchBindingCollection,
		Key:        lobbyID,
	}})
	if err != nil {
		return nil, fmt.Errorf("read lobby match binding: %w", err)
	}
	if len(objects) == 0 {
		return nil, nil
	}
	if len(objects) != 1 {
		return nil, errors.New("lobby match binding is ambiguous")
	}
	return objects[0], nil
}

func parseLobbyMatchBinding(value string) (lobbyMatchBinding, error) {
	var binding lobbyMatchBinding
	if err := json.Unmarshal([]byte(value), &binding); err != nil || binding.MatchID == "" {
		return lobbyMatchBinding{}, errors.New("lobby match binding is invalid")
	}
	return binding, nil
}

func sendLobbySignal(
	ctx context.Context,
	nk lobbyNakama,
	matchID string,
	signal lobbySignal,
) (*lobbyRPCResponse, error) {
	payload, err := json.Marshal(signal)
	if err != nil {
		return nil, fmt.Errorf("encode lobby signal: %w", err)
	}
	resultJSON, err := nk.MatchSignal(ctx, matchID, string(payload))
	if err != nil {
		return nil, fmt.Errorf("signal authoritative lobby match: %w", err)
	}
	var result lobbySignalResult
	if err := json.Unmarshal([]byte(resultJSON), &result); err != nil {
		return nil, errors.New("authoritative lobby match returned an invalid signal result")
	}
	if result.Error != "" {
		code := result.Code
		if code == 0 {
			code = grpcUnavailable
		}
		return nil, newLobbyProblem(code, result.Error)
	}
	if result.Response == nil {
		return nil, errors.New("authoritative lobby match returned no response")
	}
	return result.Response, nil
}

func encodeLobbyResponse(response lobbyRPCResponse) (string, error) {
	value, err := json.Marshal(response)
	if err != nil {
		return "", runtime.NewError("lobby response encoding failed", grpcUnavailable)
	}
	return string(value), nil
}

func logLobbyFailure(logger runtime.Logger, operation string, err error) error {
	var problem *lobbyProblem
	if !errors.As(err, &problem) {
		logger.Error("%s failed: %v", operation, err)
	}
	return asLobbyRuntimeError(err)
}
