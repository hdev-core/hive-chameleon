package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	lobbyMinimumPlayers       = 2
	lobbyMaximumPlayers       = 10
	lobbyMaximumPayloadBytes  = 16 * 1024
	lobbyMinimumPasswordBytes = 8
	lobbyMaximumPasswordBytes = 72

	grpcInvalidArgument    = 3
	grpcNotFound           = 5
	grpcAlreadyExists      = 6
	grpcFailedPrecondition = 9
	grpcAborted            = 10
)

var regionCodePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`)

type lobbyProblem struct {
	code    int
	message string
}

func (e *lobbyProblem) Error() string {
	return e.message
}

func newLobbyProblem(code int, message string) error {
	return &lobbyProblem{code: code, message: message}
}

func asLobbyRuntimeError(err error) error {
	if err == nil {
		return nil
	}
	var problem *lobbyProblem
	if errors.As(err, &problem) {
		return runtime.NewError(problem.message, problem.code)
	}
	return runtime.NewError("lobby service unavailable", grpcUnavailable)
}

type createLobbyRequest struct {
	Name       string `json:"name"`
	Visibility string `json:"visibility"`
	Password   string `json:"password,omitempty"`
	MaxPlayers int16  `json:"max_players"`
	RegionCode string `json:"region_code"`
}

type joinLobbyRequest struct {
	LobbyID    string `json:"lobby_id"`
	Password   string `json:"password,omitempty"`
	JoinSource string `json:"join_source,omitempty"`
}

type leaveLobbyRequest struct {
	LobbyID string `json:"lobby_id"`
}

type updateLobbyConfigurationRequest struct {
	LobbyID                string  `json:"lobby_id"`
	ExpectedLobbyVersion   int64   `json:"expected_lobby_version"`
	Mode                   *string `json:"mode,omitempty"`
	MapVersionID           *string `json:"map_version_id,omitempty"`
	HunterCount            *int16  `json:"hunter_count,omitempty"`
	HidingDurationSeconds  *int    `json:"hiding_duration_seconds,omitempty"`
	HuntingDurationSeconds *int    `json:"hunting_duration_seconds,omitempty"`
	TauntEnabled           *bool   `json:"taunt_enabled,omitempty"`
	TauntIntervalSeconds   *int    `json:"taunt_interval_seconds,omitempty"`
	ShellLimit             *int    `json:"shell_limit,omitempty"`
	ReloadDurationMS       *int    `json:"reload_duration_ms,omitempty"`
	AutoStartEnabled       *bool   `json:"auto_start_enabled,omitempty"`
	AutoStartThreshold     *int16  `json:"auto_start_threshold,omitempty"`
}

type startLobbyRequest struct {
	LobbyID              string `json:"lobby_id"`
	ExpectedLobbyVersion int64  `json:"expected_lobby_version"`
}

type nominateHunterRequest struct {
	LobbyID              string `json:"lobby_id"`
	ExpectedLobbyVersion int64  `json:"expected_lobby_version"`
	Nominated            bool   `json:"nominated"`
}

type lobbyMemberSnapshot struct {
	PlayerID string    `json:"player_id"`
	JoinedAt time.Time `json:"joined_at"`
}

type lobbyConfigurationSnapshot struct {
	Mode                   string  `json:"mode"`
	MapVersionID           *string `json:"map_version_id"`
	HunterCount            int16   `json:"hunter_count"`
	HidingDurationSeconds  int     `json:"hiding_duration_seconds"`
	HuntingDurationSeconds int     `json:"hunting_duration_seconds"`
	TauntEnabled           bool    `json:"taunt_enabled"`
	TauntIntervalSeconds   *int    `json:"taunt_interval_seconds"`
	ShellLimit             int     `json:"shell_limit"`
	ReloadDurationMS       int     `json:"reload_duration_ms"`
	AutoStartEnabled       bool    `json:"auto_start_enabled"`
	AutoStartThreshold     int16   `json:"auto_start_threshold"`
	RowVersion             int64   `json:"row_version"`
}

type lobbySnapshot struct {
	ID                  string                     `json:"id"`
	Name                string                     `json:"name"`
	Visibility          string                     `json:"visibility"`
	MaxPlayers          int16                      `json:"max_players"`
	RegionCode          string                     `json:"region_code"`
	CurrentHostPlayerID string                     `json:"current_host_player_id"`
	RowVersion          int64                      `json:"row_version"`
	Closed              bool                       `json:"closed"`
	Members             []lobbyMemberSnapshot      `json:"members"`
	HunterNomineeIDs    []string                   `json:"hunter_nominee_player_ids"`
	Configuration       lobbyConfigurationSnapshot `json:"configuration"`
}

type lobbyRPCResponse struct {
	MatchID       string               `json:"match_id,omitempty"`
	Lobby         lobbySnapshot        `json:"lobby"`
	StartAccepted bool                 `json:"start_accepted,omitempty"`
	Round         *roundPublicSnapshot `json:"round,omitempty"`
}

type lobbyStore interface {
	Create(context.Context, string, createLobbyRequest, string) (lobbySnapshot, error)
	Join(context.Context, string, joinLobbyRequest) (lobbySnapshot, error)
	Snapshot(context.Context, string) (lobbySnapshot, error)
	IsOpenMember(context.Context, string, string) (bool, error)
	UpdateConfiguration(
		context.Context,
		string,
		updateLobbyConfigurationRequest,
	) (lobbySnapshot, error)
	RecordNominationChange(
		context.Context,
		string,
		nominateHunterRequest,
	) (lobbySnapshot, error)
	StartRound(
		context.Context,
		string,
		startLobbyRequest,
		map[string]bool,
	) (lobbySnapshot, roundSnapshot, error)
	ActiveRound(context.Context, string) (*roundSnapshot, error)
	Leave(
		context.Context,
		string,
		[]string,
		string,
	) (lobbySnapshot, bool, error)
}

func trustedPlayerID(ctx context.Context) (string, error) {
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", newLobbyProblem(grpcUnauthenticated, "authenticated realtime session required")
	}

	variables, ok := ctx.Value(runtime.RUNTIME_CTX_VARS).(map[string]string)
	if !ok || variables["bridge_version"] != bridgeAssertionVersion {
		return "", newLobbyProblem(grpcUnauthenticated, "authenticated realtime session required")
	}
	playerID := variables["app_player_id"]
	if _, err := canonicalUUIDV7ToCompact(playerID); err != nil {
		return "", newLobbyProblem(grpcUnauthenticated, "authenticated realtime session required")
	}
	if _, err := canonicalUUIDV7ToCompact(variables["app_auth_session_id"]); err != nil {
		return "", newLobbyProblem(grpcUnauthenticated, "authenticated realtime session required")
	}
	return playerID, nil
}

func decodeLobbyPayload(payload string, target any) error {
	if len(payload) == 0 || len(payload) > lobbyMaximumPayloadBytes {
		return newLobbyProblem(grpcInvalidArgument, "invalid lobby command payload")
	}
	decoder := json.NewDecoder(bytes.NewBufferString(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return newLobbyProblem(grpcInvalidArgument, "invalid lobby command payload")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return newLobbyProblem(grpcInvalidArgument, "invalid lobby command payload")
	}
	return nil
}

func validateCreateLobby(request *createLobbyRequest) error {
	request.Name = strings.TrimSpace(request.Name)
	request.RegionCode = strings.ToLower(strings.TrimSpace(request.RegionCode))
	request.Visibility = strings.ToLower(strings.TrimSpace(request.Visibility))
	if request.Name == "" || len([]byte(request.Name)) > 128 {
		return newLobbyProblem(grpcInvalidArgument, "lobby name must contain 1..128 UTF-8 bytes")
	}
	if !regionCodePattern.MatchString(request.RegionCode) || len(request.RegionCode) > 32 {
		return newLobbyProblem(grpcInvalidArgument, "lobby region code is invalid")
	}
	if request.MaxPlayers < lobbyMinimumPlayers || request.MaxPlayers > lobbyMaximumPlayers {
		return newLobbyProblem(grpcInvalidArgument, "lobby capacity must be between 2 and 10")
	}
	switch request.Visibility {
	case "public":
		if request.Password != "" {
			return newLobbyProblem(grpcInvalidArgument, "public lobby cannot have a password")
		}
	case "private":
		passwordBytes := len([]byte(request.Password))
		if passwordBytes < lobbyMinimumPasswordBytes || passwordBytes > lobbyMaximumPasswordBytes {
			return newLobbyProblem(
				grpcInvalidArgument,
				"private lobby password must contain 8..72 UTF-8 bytes",
			)
		}
	default:
		return newLobbyProblem(grpcInvalidArgument, "lobby visibility must be public or private")
	}
	return nil
}

func validateJoinLobby(request *joinLobbyRequest) error {
	if _, err := canonicalUUIDV7ToCompact(request.LobbyID); err != nil {
		return newLobbyProblem(grpcInvalidArgument, "lobby ID must be a UUIDv7")
	}
	request.JoinSource = strings.ToLower(strings.TrimSpace(request.JoinSource))
	if request.JoinSource == "" {
		request.JoinSource = "server_browser"
	}
	switch request.JoinSource {
	case "server_browser", "quick_play", "friend_join", "invitation", "access_code", "reconnect":
	default:
		return newLobbyProblem(grpcInvalidArgument, "lobby join source is invalid")
	}
	if len([]byte(request.Password)) > lobbyMaximumPasswordBytes {
		return newLobbyProblem(grpcInvalidArgument, "lobby password is invalid")
	}
	return nil
}

func validateLobbyID(lobbyID string) error {
	if _, err := canonicalUUIDV7ToCompact(lobbyID); err != nil {
		return newLobbyProblem(grpcInvalidArgument, "lobby ID must be a UUIDv7")
	}
	return nil
}

func validateHostVersion(lobbyID string, expectedVersion int64) error {
	if err := validateLobbyID(lobbyID); err != nil {
		return err
	}
	if expectedVersion <= 0 {
		return newLobbyProblem(grpcInvalidArgument, "expected lobby version must be positive")
	}
	return nil
}

func validateNominateHunter(request nominateHunterRequest) error {
	return validateHostVersion(request.LobbyID, request.ExpectedLobbyVersion)
}

func applyConfigurationPatch(
	current lobbyConfigurationSnapshot,
	request updateLobbyConfigurationRequest,
	maxPlayers int16,
) (lobbyConfigurationSnapshot, error) {
	next := current
	if request.Mode != nil {
		next.Mode = strings.ToLower(strings.TrimSpace(*request.Mode))
	}
	if request.MapVersionID != nil {
		mapVersionID := strings.TrimSpace(*request.MapVersionID)
		if mapVersionID == "" {
			next.MapVersionID = nil
		} else {
			if _, err := canonicalUUIDV7ToCompact(mapVersionID); err != nil {
				return current, newLobbyProblem(
					grpcInvalidArgument,
					"map version ID must be a UUIDv7",
				)
			}
			next.MapVersionID = &mapVersionID
		}
	}
	if request.HunterCount != nil {
		next.HunterCount = *request.HunterCount
	}
	if request.HidingDurationSeconds != nil {
		next.HidingDurationSeconds = *request.HidingDurationSeconds
	}
	if request.HuntingDurationSeconds != nil {
		next.HuntingDurationSeconds = *request.HuntingDurationSeconds
	}
	if request.TauntEnabled != nil {
		next.TauntEnabled = *request.TauntEnabled
	}
	if request.TauntIntervalSeconds != nil {
		interval := *request.TauntIntervalSeconds
		next.TauntIntervalSeconds = &interval
	}
	if request.ShellLimit != nil {
		next.ShellLimit = *request.ShellLimit
	}
	if request.ReloadDurationMS != nil {
		next.ReloadDurationMS = *request.ReloadDurationMS
	}
	if request.AutoStartEnabled != nil {
		next.AutoStartEnabled = *request.AutoStartEnabled
	}
	if request.AutoStartThreshold != nil {
		next.AutoStartThreshold = *request.AutoStartThreshold
	}

	if next.Mode != "casual" && next.Mode != "infection" {
		return current, newLobbyProblem(grpcInvalidArgument, "lobby mode is invalid")
	}
	if next.HunterCount < 1 || next.HunterCount > 2 {
		return current, newLobbyProblem(grpcInvalidArgument, "hunter count must be 1 or 2")
	}
	if next.HidingDurationSeconds < 10 || next.HidingDurationSeconds > 600 {
		return current, newLobbyProblem(
			grpcInvalidArgument,
			"hiding duration must be between 10 and 600 seconds",
		)
	}
	if next.HuntingDurationSeconds < 30 || next.HuntingDurationSeconds > 1800 {
		return current, newLobbyProblem(
			grpcInvalidArgument,
			"hunting duration must be between 30 and 1800 seconds",
		)
	}
	if next.ShellLimit < 1 || next.ShellLimit > 100 {
		return current, newLobbyProblem(grpcInvalidArgument, "shell limit must be between 1 and 100")
	}
	if next.ReloadDurationMS < 100 || next.ReloadDurationMS > 30_000 {
		return current, newLobbyProblem(
			grpcInvalidArgument,
			"reload duration must be between 100 and 30000 milliseconds",
		)
	}
	if next.AutoStartThreshold < lobbyMinimumPlayers || next.AutoStartThreshold > maxPlayers {
		return current, newLobbyProblem(
			grpcInvalidArgument,
			"automatic-start threshold must fit the lobby capacity",
		)
	}
	if next.TauntEnabled {
		if next.TauntIntervalSeconds == nil ||
			*next.TauntIntervalSeconds < 5 ||
			*next.TauntIntervalSeconds > 300 {
			return current, newLobbyProblem(
				grpcInvalidArgument,
				"enabled taunts require an interval between 5 and 300 seconds",
			)
		}
	} else {
		next.TauntIntervalSeconds = nil
	}
	return next, nil
}

func newUUIDV7(now time.Time) (string, error) {
	var value [16]byte
	milliseconds := now.UnixMilli()
	if milliseconds < 0 || milliseconds > 0x0000ffffffffffff {
		return "", fmt.Errorf("UUIDv7 timestamp is out of range")
	}
	for index := 5; index >= 0; index-- {
		value[index] = byte(milliseconds)
		milliseconds >>= 8
	}
	if _, err := rand.Read(value[6:]); err != nil {
		return "", fmt.Errorf("generate UUIDv7 randomness: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x70
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[0:8] + "-" +
		encoded[8:12] + "-" +
		encoded[12:16] + "-" +
		encoded[16:20] + "-" +
		encoded[20:32], nil
}
