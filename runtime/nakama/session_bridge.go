package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	bridgeAssertionVersion = "v1"
	bridgeSecretEnv        = "NAKAMA_BRIDGE_HMAC_KEY"
	bridgeMaximumTTL       = 60 * time.Second
	bridgeNonceBytes       = 16
	bridgeMaximumLength    = 128
	bridgeReplayCollection = "hc_bridge_replay"
	bridgeReplayMaxEntries = 128
	bridgeReplayMaxRetries = 5
	grpcUnavailable        = 14
	grpcUnauthenticated    = 16
)

var (
	errInvalidBridgeAssertion = errors.New("invalid session bridge assertion")
	errBridgeAssertionReplay  = errors.New("session bridge assertion replayed")
)

type bridgePrincipal struct {
	playerID      string
	authSessionID string
	nonceKey      string
	expiresAt     int64
}

type bridgeReplayStore interface {
	consume(ctx context.Context, authSessionID, nonceKey string, expiresAt, now int64) error
}

type storageWriteRetrier interface {
	StorageWriteRetry(
		ctx context.Context,
		reads []*runtime.StorageRead,
		updateFn func(objects []*api.StorageObject) ([]*runtime.StorageWrite, error),
		maxRetries int,
	) ([]*api.StorageObjectAck, error)
}

type nakamaBridgeReplayStore struct {
	storage storageWriteRetrier
}

type bridgeReplayState struct {
	Nonces map[string]int64 `json:"nonces"`
}

type bridgeVerifier struct {
	key         []byte
	now         func() time.Time
	replayStore bridgeReplayStore
}

func newBridgeVerifierFromContext(ctx context.Context, replayStore bridgeReplayStore) (*bridgeVerifier, error) {
	environment, ok := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	if !ok {
		return nil, errors.New("runtime environment is unavailable")
	}

	key, err := decodeBridgeKey(environment[bridgeSecretEnv])
	if err != nil {
		return nil, err
	}

	if replayStore == nil {
		return nil, errors.New("session bridge replay store is unavailable")
	}

	return &bridgeVerifier{key: key, now: time.Now, replayStore: replayStore}, nil
}

func decodeBridgeKey(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, fmt.Errorf("%s is required", bridgeSecretEnv)
	}

	key, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(key) != encoded {
		return nil, fmt.Errorf("%s must be canonical unpadded base64url", bridgeSecretEnv)
	}
	if len(key) < sha256.Size {
		return nil, fmt.Errorf("%s must decode to at least %d bytes", bridgeSecretEnv, sha256.Size)
	}

	return key, nil
}

func (v *bridgeVerifier) verify(assertion string) (bridgePrincipal, error) {
	if len(assertion) == 0 || len(assertion) > bridgeMaximumLength {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	parts := strings.Split(assertion, ".")
	if len(parts) != 6 || parts[0] != bridgeAssertionVersion {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	playerID, err := compactUUIDV7ToCanonical(parts[1])
	if err != nil {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}
	authSessionID, err := compactUUIDV7ToCanonical(parts[2])
	if err != nil {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	expiresAt, err := strconv.ParseInt(parts[3], 36, 64)
	if err != nil {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}
	now := v.now().Unix()
	if expiresAt <= now || expiresAt > now+int64(bridgeMaximumTTL/time.Second) {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	nonce, err := base64.RawURLEncoding.DecodeString(parts[4])
	if err != nil || len(nonce) != bridgeNonceBytes || base64.RawURLEncoding.EncodeToString(nonce) != parts[4] {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[5])
	if err != nil || len(signature) != sha256.Size || base64.RawURLEncoding.EncodeToString(signature) != parts[5] {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	mac := hmac.New(sha256.New, v.key)
	_, _ = mac.Write([]byte(strings.Join(parts[:5], ".")))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return bridgePrincipal{}, errInvalidBridgeAssertion
	}

	return bridgePrincipal{
		playerID:      playerID,
		authSessionID: authSessionID,
		nonceKey:      hex.EncodeToString(nonce),
		expiresAt:     expiresAt,
	}, nil
}

func (v *bridgeVerifier) beforeAuthenticateCustom(
	ctx context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	in *api.AuthenticateCustomRequest,
) (*api.AuthenticateCustomRequest, error) {
	if in == nil || in.Account == nil {
		return nil, runtime.NewError("invalid session bridge credential", grpcUnauthenticated)
	}

	principal, err := v.verify(in.Account.Id)
	if err != nil {
		return nil, runtime.NewError("invalid session bridge credential", grpcUnauthenticated)
	}
	if v.replayStore == nil {
		return nil, runtime.NewError("session bridge authentication unavailable", grpcUnavailable)
	}
	now := v.now().Unix()
	if principal.expiresAt <= now {
		return nil, runtime.NewError("invalid session bridge credential", grpcUnauthenticated)
	}
	if err := v.replayStore.consume(
		ctx,
		principal.authSessionID,
		principal.nonceKey,
		principal.expiresAt,
		now,
	); err != nil {
		if errors.Is(err, errBridgeAssertionReplay) {
			return nil, runtime.NewError("invalid session bridge credential", grpcUnauthenticated)
		}
		return nil, runtime.NewError("session bridge authentication unavailable", grpcUnavailable)
	}

	// The assertion is never retained as an account identifier. All caller-controlled identity
	// fields are replaced with values authenticated by the bridge signature.
	in.Account.Id = principal.playerID
	in.Account.Vars = map[string]string{
		"app_auth_session_id": principal.authSessionID,
		"app_player_id":       principal.playerID,
		"bridge_version":      bridgeAssertionVersion,
	}
	in.Username = "hc_" + strings.ReplaceAll(principal.playerID, "-", "")
	in.Create = wrapperspb.Bool(true)

	return in, nil
}

func (s *nakamaBridgeReplayStore) consume(
	ctx context.Context,
	authSessionID string,
	nonceKey string,
	expiresAt int64,
	now int64,
) error {
	if s == nil || s.storage == nil {
		return errors.New("Nakama storage is unavailable")
	}

	read := &runtime.StorageRead{
		Collection: bridgeReplayCollection,
		Key:        authSessionID,
	}
	_, err := s.storage.StorageWriteRetry(
		ctx,
		[]*runtime.StorageRead{read},
		func(objects []*api.StorageObject) ([]*runtime.StorageWrite, error) {
			return bridgeReplayWrite(objects, authSessionID, nonceKey, expiresAt, now)
		},
		bridgeReplayMaxRetries,
	)
	return err
}

func bridgeReplayWrite(
	objects []*api.StorageObject,
	authSessionID string,
	nonceKey string,
	expiresAt int64,
	now int64,
) ([]*runtime.StorageWrite, error) {
	state := bridgeReplayState{Nonces: make(map[string]int64)}
	version := "*"
	if len(objects) > 1 {
		return nil, errors.New("session bridge replay state is ambiguous")
	}
	if len(objects) == 1 {
		object := objects[0]
		if object == nil || object.Collection != bridgeReplayCollection || object.Key != authSessionID {
			return nil, errors.New("session bridge replay state identity is invalid")
		}
		if err := json.Unmarshal([]byte(object.Value), &state); err != nil || state.Nonces == nil {
			return nil, errors.New("session bridge replay state is invalid")
		}
		version = object.Version
	}

	for existingNonce, existingExpiry := range state.Nonces {
		if existingExpiry <= now {
			delete(state.Nonces, existingNonce)
		}
	}
	if _, exists := state.Nonces[nonceKey]; exists {
		return nil, errBridgeAssertionReplay
	}
	if len(state.Nonces) >= bridgeReplayMaxEntries {
		return nil, errors.New("session bridge replay state capacity exceeded")
	}
	state.Nonces[nonceKey] = expiresAt

	value, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("encode session bridge replay state: %w", err)
	}
	return []*runtime.StorageWrite{{
		Collection:      bridgeReplayCollection,
		Key:             authSessionID,
		Value:           string(value),
		Version:         version,
		PermissionRead:  0,
		PermissionWrite: 0,
	}}, nil
}

func compactUUIDV7ToCanonical(encoded string) (string, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(bytes) != 16 || base64.RawURLEncoding.EncodeToString(bytes) != encoded {
		return "", errInvalidBridgeAssertion
	}
	if bytes[6]>>4 != 7 || bytes[8]&0xc0 != 0x80 {
		return "", errInvalidBridgeAssertion
	}

	value := hex.EncodeToString(bytes)
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

func canonicalUUIDV7ToCompact(value string) (string, error) {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' || value != strings.ToLower(value) {
		return "", errInvalidBridgeAssertion
	}

	decoded, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	if err != nil || len(decoded) != 16 || decoded[6]>>4 != 7 || decoded[8]&0xc0 != 0x80 {
		return "", errInvalidBridgeAssertion
	}

	return base64.RawURLEncoding.EncodeToString(decoded), nil
}
