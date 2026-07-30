package main

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

func TestCreateLobbyValidationNormalizesPublicLobby(t *testing.T) {
	t.Parallel()

	request := createLobbyRequest{
		Name:       "  Smoke Lobby  ",
		Visibility: " PUBLIC ",
		MaxPlayers: 10,
		RegionCode: " EU-WEST ",
	}
	if err := validateCreateLobby(&request); err != nil {
		t.Fatalf("validate create lobby: %v", err)
	}
	if request.Name != "Smoke Lobby" ||
		request.Visibility != "public" ||
		request.RegionCode != "eu-west" {
		t.Fatalf("create lobby was not normalized: %#v", request)
	}
}

func TestCreateLobbyValidationRequiresPrivatePassword(t *testing.T) {
	t.Parallel()

	request := createLobbyRequest{
		Name:       "Private",
		Visibility: "private",
		MaxPlayers: 4,
		RegionCode: "local",
		Password:   "short",
	}
	assertLobbyProblemCode(t, validateCreateLobby(&request), grpcInvalidArgument)

	request.Password = "long-enough"
	if err := validateCreateLobby(&request); err != nil {
		t.Fatalf("validate private lobby: %v", err)
	}
}

func TestLobbyPayloadRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	t.Parallel()

	var request leaveLobbyRequest
	assertLobbyProblemCode(
		t,
		decodeLobbyPayload(`{"lobby_id":"value","player_id":"forged"}`, &request),
		grpcInvalidArgument,
	)
	assertLobbyProblemCode(
		t,
		decodeLobbyPayload(`{"lobby_id":"value"} {}`, &request),
		grpcInvalidArgument,
	)
}

func TestApplyConfigurationPatchUsesBoundedServerRules(t *testing.T) {
	t.Parallel()

	configuration := lobbyConfigurationSnapshot{
		Mode:                   "casual",
		HunterCount:            1,
		HidingDurationSeconds:  60,
		HuntingDurationSeconds: 180,
		TauntEnabled:           true,
		TauntIntervalSeconds:   intPointer(30),
		ShellLimit:             6,
		ReloadDurationMS:       2000,
		AutoStartEnabled:       true,
		AutoStartThreshold:     7,
	}
	mode := "infection"
	hunters := int16(2)
	threshold := int16(8)
	updated, err := applyConfigurationPatch(
		configuration,
		updateLobbyConfigurationRequest{
			Mode:               &mode,
			HunterCount:        &hunters,
			AutoStartThreshold: &threshold,
		},
		10,
	)
	if err != nil {
		t.Fatalf("apply valid lobby configuration: %v", err)
	}
	if updated.Mode != "infection" ||
		updated.HunterCount != 2 ||
		updated.AutoStartThreshold != 8 {
		t.Fatalf("unexpected patched configuration: %#v", updated)
	}

	tooManyHunters := int16(3)
	_, err = applyConfigurationPatch(
		configuration,
		updateLobbyConfigurationRequest{HunterCount: &tooManyHunters},
		10,
	)
	assertLobbyProblemCode(t, err, grpcInvalidArgument)
}

func TestNewUUIDV7UsesCanonicalVersionAndTimestamp(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_784_821_000_123).UTC()
	value, err := newUUIDV7(now)
	if err != nil {
		t.Fatalf("create UUIDv7: %v", err)
	}
	if _, err := canonicalUUIDV7ToCompact(value); err != nil {
		t.Fatalf("generated UUIDv7 is not canonical: %s", value)
	}
	timestampHex := strings.ReplaceAll(value, "-", "")[:12]
	timestamp, err := strconv.ParseInt(timestampHex, 16, 64)
	if err != nil || timestamp != now.UnixMilli() {
		t.Fatalf("generated UUIDv7 did not preserve timestamp: %s", value)
	}
}

func TestTrustedPlayerIDRequiresBridgeScopedVariables(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), runtime.RUNTIME_CTX_USER_ID, "nakama-user")
	ctx = context.WithValue(ctx, runtime.RUNTIME_CTX_VARS, map[string]string{
		"app_auth_session_id": testAuthSessionID,
		"app_player_id":       testPlayerID,
		"bridge_version":      bridgeAssertionVersion,
	})
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		t.Fatalf("read trusted lobby player: %v", err)
	}
	if playerID != testPlayerID {
		t.Fatalf("unexpected trusted player ID: %s", playerID)
	}

	_, err = trustedPlayerID(context.Background())
	assertLobbyProblemCode(t, err, grpcUnauthenticated)
}

func assertLobbyProblemCode(t *testing.T, err error, expected int) {
	t.Helper()
	problem, ok := err.(*lobbyProblem)
	if !ok {
		t.Fatalf("expected lobby problem, got %T (%v)", err, err)
	}
	if problem.code != expected {
		t.Fatalf("lobby problem code %d, expected %d", problem.code, expected)
	}
}

func intPointer(value int) *int {
	return &value
}
