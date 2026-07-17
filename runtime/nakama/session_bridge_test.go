package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	testPlayerID      = "01980abc-def0-7abc-8def-0123456789ab"
	testAuthSessionID = "01980abc-def1-7abc-9def-0123456789ab"
	testBridgeGolden  = "v1.AZgKvN7weryN7wEjRWeJqw.AZgKvN7xeryd7wEjRWeJqw.tro8wu.MTIzNDU2Nzg5MGFiY2RlZg.EBy3NlnPzwlY2tpUCfKdOQHjGyHfpsEorwC9gNbuRLo"
)

func TestBridgeVerifierAcceptsCanonicalAssertion(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_800_000_000, 0)
	verifier := &bridgeVerifier{key: testBridgeKey(), now: func() time.Time { return now }}
	assertion := makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now.Add(30*time.Second))
	if assertion != testBridgeGolden {
		t.Fatalf("bridge assertion differs from the NestJS golden vector:\n%s", assertion)
	}

	principal, err := verifier.verify(assertion)
	if err != nil {
		t.Fatalf("verify assertion: %v", err)
	}
	if principal.playerID != testPlayerID || principal.authSessionID != testAuthSessionID {
		t.Fatalf("unexpected principal: %#v", principal)
	}
	if len(assertion) > bridgeMaximumLength {
		t.Fatalf("assertion length %d exceeds Nakama custom ID limit", len(assertion))
	}
}

func TestBridgeVerifierRejectsTamperingAndInvalidLifetime(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_800_000_000, 0)
	verifier := &bridgeVerifier{key: testBridgeKey(), now: func() time.Time { return now }}
	valid := makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now.Add(30*time.Second))

	tests := map[string]string{
		"tampered":        valid[:len(valid)-1] + alternateBase64Character(valid[len(valid)-1]),
		"expired":         makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now),
		"excessive ttl":   makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now.Add(61*time.Second)),
		"unknown version": strings.Replace(valid, bridgeAssertionVersion+".", "v2.", 1),
	}

	for name, assertion := range tests {
		assertion := assertion
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := verifier.verify(assertion); err == nil {
				t.Fatal("expected invalid assertion")
			}
		})
	}
}

func TestAuthenticationHookReplacesCallerControlledIdentity(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_800_000_000, 0)
	replayStore := &memoryBridgeReplayStore{}
	verifier := &bridgeVerifier{
		key:         testBridgeKey(),
		now:         func() time.Time { return now },
		replayStore: replayStore,
	}
	assertion := makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now.Add(30*time.Second))
	request := &api.AuthenticateCustomRequest{
		Account: &api.AccountCustom{
			Id:   assertion,
			Vars: map[string]string{"app_player_id": "forged", "admin": "true"},
		},
		Create:   wrapperspb.Bool(false),
		Username: "forged",
	}

	result, err := verifier.beforeAuthenticateCustom(context.Background(), nil, nil, nil, request)
	if err != nil {
		t.Fatalf("authenticate hook: %v", err)
	}
	if result.Account.Id != testPlayerID {
		t.Fatalf("unexpected stable custom ID: %s", result.Account.Id)
	}
	if result.Username != "hc_01980abcdef07abc8def0123456789ab" {
		t.Fatalf("unexpected username: %s", result.Username)
	}
	if !result.Create.GetValue() {
		t.Fatal("bridge must permit first authenticated account creation")
	}
	if len(result.Account.Vars) != 3 || result.Account.Vars["app_player_id"] != testPlayerID || result.Account.Vars["app_auth_session_id"] != testAuthSessionID || result.Account.Vars["bridge_version"] != bridgeAssertionVersion {
		t.Fatalf("caller variables were not replaced: %#v", result.Account.Vars)
	}

	replayRequest := &api.AuthenticateCustomRequest{Account: &api.AccountCustom{Id: assertion}}
	if _, err := verifier.beforeAuthenticateCustom(context.Background(), nil, nil, nil, replayRequest); err == nil {
		t.Fatal("expected the same bridge assertion to be rejected after first use")
	} else {
		assertRuntimeErrorCode(t, err, grpcUnauthenticated)
	}
}

func TestAuthenticationHookFailsClosedWhenReplayStoreIsUnavailable(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_800_000_000, 0)
	verifier := &bridgeVerifier{
		key: testBridgeKey(),
		now: func() time.Time { return now },
		replayStore: &memoryBridgeReplayStore{
			failure: errors.New("storage unavailable"),
		},
	}
	request := &api.AuthenticateCustomRequest{Account: &api.AccountCustom{
		Id: makeBridgeAssertion(t, verifier.key, testPlayerID, testAuthSessionID, now.Add(30*time.Second)),
	}}

	if _, err := verifier.beforeAuthenticateCustom(context.Background(), nil, nil, nil, request); err == nil {
		t.Fatal("expected bridge authentication to fail when replay storage is unavailable")
	} else {
		assertRuntimeErrorCode(t, err, grpcUnavailable)
	}
}

func TestBridgeKeyConfiguration(t *testing.T) {
	t.Parallel()

	encoded := base64.RawURLEncoding.EncodeToString(testBridgeKey())
	ctx := context.WithValue(context.Background(), runtime.RUNTIME_CTX_ENV, map[string]string{bridgeSecretEnv: encoded})
	verifier, err := newBridgeVerifierFromContext(ctx, &memoryBridgeReplayStore{})
	if err != nil {
		t.Fatalf("configure verifier: %v", err)
	}
	if !hmac.Equal(verifier.key, testBridgeKey()) {
		t.Fatal("decoded bridge key differs")
	}

	for _, value := range []string{"", "not_base64", base64.RawURLEncoding.EncodeToString([]byte("too short"))} {
		if _, err := decodeBridgeKey(value); err == nil {
			t.Fatalf("expected bridge key %q to be rejected", value)
		}
	}
}

func TestBridgeReplayWriteCreatesPrunesAndRejectsReplays(t *testing.T) {
	t.Parallel()

	created, err := bridgeReplayWrite(nil, testAuthSessionID, "new", 120, 100)
	if err != nil {
		t.Fatalf("create replay state: %v", err)
	}
	if len(created) != 1 || created[0].Version != "*" {
		t.Fatalf("unexpected create write: %#v", created)
	}

	existing := &api.StorageObject{
		Collection: bridgeReplayCollection,
		Key:        testAuthSessionID,
		Value:      `{"nonces":{"expired":100,"live":130}}`,
		Version:    "current-version",
	}
	updated, err := bridgeReplayWrite([]*api.StorageObject{existing}, testAuthSessionID, "next", 140, 100)
	if err != nil {
		t.Fatalf("update replay state: %v", err)
	}
	if len(updated) != 1 || updated[0].Version != existing.Version {
		t.Fatalf("unexpected update write: %#v", updated)
	}
	var state bridgeReplayState
	if err := json.Unmarshal([]byte(updated[0].Value), &state); err != nil {
		t.Fatalf("decode updated replay state: %v", err)
	}
	if _, present := state.Nonces["expired"]; present {
		t.Fatal("expired nonce was not pruned")
	}
	if state.Nonces["live"] != 130 || state.Nonces["next"] != 140 {
		t.Fatalf("unexpected retained replay state: %#v", state.Nonces)
	}

	if _, err := bridgeReplayWrite([]*api.StorageObject{existing}, testAuthSessionID, "live", 140, 100); !errors.Is(err, errBridgeAssertionReplay) {
		t.Fatalf("expected replay rejection, got %v", err)
	}
}

func makeBridgeAssertion(t *testing.T, key []byte, playerID, authSessionID string, expiresAt time.Time) string {
	t.Helper()

	compactPlayerID, err := canonicalUUIDV7ToCompact(playerID)
	if err != nil {
		t.Fatalf("compact player ID: %v", err)
	}
	compactAuthSessionID, err := canonicalUUIDV7ToCompact(authSessionID)
	if err != nil {
		t.Fatalf("compact auth session ID: %v", err)
	}

	nonce := base64.RawURLEncoding.EncodeToString([]byte("1234567890abcdef"))
	payload := strings.Join([]string{
		bridgeAssertionVersion,
		compactPlayerID,
		compactAuthSessionID,
		strings.ToLower(strconvFormatIntBase36(expiresAt.Unix())),
		nonce,
	}, ".")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func strconvFormatIntBase36(value int64) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	if value == 0 {
		return "0"
	}

	var reversed [32]byte
	position := len(reversed)
	for value > 0 {
		position--
		reversed[position] = alphabet[value%36]
		value /= 36
	}
	return string(reversed[position:])
}

func alternateBase64Character(value byte) string {
	if value == 'A' {
		return "B"
	}
	return "A"
}

func testBridgeKey() []byte {
	return []byte("0123456789abcdef0123456789abcdef")
}

type memoryBridgeReplayStore struct {
	consumed map[string]struct{}
	failure  error
}

func (s *memoryBridgeReplayStore) consume(
	_ context.Context,
	authSessionID string,
	nonceKey string,
	_ int64,
	_ int64,
) error {
	if s.failure != nil {
		return s.failure
	}
	if s.consumed == nil {
		s.consumed = make(map[string]struct{})
	}
	key := authSessionID + "." + nonceKey
	if _, exists := s.consumed[key]; exists {
		return errBridgeAssertionReplay
	}
	s.consumed[key] = struct{}{}
	return nil
}
