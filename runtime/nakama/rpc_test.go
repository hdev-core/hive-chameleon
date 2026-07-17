package main

import (
	"context"
	"database/sql"
	"testing"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

type fakeRealtimeInitializer struct {
	authHook          func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateCustomRequest) (*api.AuthenticateCustomRequest, error)
	accountGuardHook  int
	nonBridgeAuthHook int
	rpcs              map[string]func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, string) (string, error)
}

func (f *fakeRealtimeInitializer) RegisterBeforeDeleteAccount(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule) error) error {
	f.accountGuardHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeLinkCustom(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AccountCustom) (*api.AccountCustom, error)) error {
	f.accountGuardHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeUnlinkCustom(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AccountCustom) (*api.AccountCustom, error)) error {
	f.accountGuardHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeUpdateAccount(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.UpdateAccountRequest) (*api.UpdateAccountRequest, error)) error {
	f.accountGuardHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateApple(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateAppleRequest) (*api.AuthenticateAppleRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateCustom(fn func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateCustomRequest) (*api.AuthenticateCustomRequest, error)) error {
	f.authHook = fn
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateDevice(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateDeviceRequest) (*api.AuthenticateDeviceRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateEmail(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateEmailRequest) (*api.AuthenticateEmailRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateFacebook(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateFacebookRequest) (*api.AuthenticateFacebookRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateFacebookInstantGame(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateFacebookInstantGameRequest) (*api.AuthenticateFacebookInstantGameRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateGameCenter(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateGameCenterRequest) (*api.AuthenticateGameCenterRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateGoogle(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateGoogleRequest) (*api.AuthenticateGoogleRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterBeforeAuthenticateSteam(_ func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateSteamRequest) (*api.AuthenticateSteamRequest, error)) error {
	f.nonBridgeAuthHook++
	return nil
}

func (f *fakeRealtimeInitializer) RegisterRpc(name string, fn func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, string) (string, error)) error {
	if f.rpcs == nil {
		f.rpcs = make(map[string]func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, string) (string, error))
	}
	f.rpcs[name] = fn
	return nil
}

func TestRegisterRealtimeReservesStableContracts(t *testing.T) {
	t.Parallel()

	initializer := &fakeRealtimeInitializer{}
	if err := registerRealtime(initializer, &bridgeVerifier{key: testBridgeKey()}); err != nil {
		t.Fatalf("register realtime: %v", err)
	}
	if initializer.authHook == nil {
		t.Fatal("custom authentication hook was not registered")
	}
	if initializer.nonBridgeAuthHook != 8 {
		t.Fatalf("registered %d non-bridge auth rejections, expected 8", initializer.nonBridgeAuthHook)
	}
	if initializer.accountGuardHook != 4 {
		t.Fatalf("registered %d account mutation guards, expected 4", initializer.accountGuardHook)
	}
	if len(initializer.rpcs) != len(realtimeRPCNames) {
		t.Fatalf("registered %d RPCs, expected %d", len(initializer.rpcs), len(realtimeRPCNames))
	}
	for _, name := range realtimeRPCNames {
		if initializer.rpcs[name] == nil {
			t.Errorf("RPC %s was not registered", name)
		}
	}
}

func TestBuiltInAccountIdentityMutationsAreRejected(t *testing.T) {
	t.Parallel()

	_, mutationError := denyAccountMutation[api.AccountCustom](
		context.Background(), nil, nil, nil, &api.AccountCustom{Id: testPlayerID},
	)
	assertRuntimeErrorCode(t, mutationError, grpcPermissionDenied)

	deletionError := denyAccountDeletion(context.Background(), nil, nil, nil)
	assertRuntimeErrorCode(t, deletionError, grpcPermissionDenied)
}

func TestNonBridgeAuthenticationIsRejected(t *testing.T) {
	t.Parallel()

	_, err := denyNonBridgeAuthentication[api.AuthenticateDeviceRequest](
		context.Background(), nil, nil, nil, &api.AuthenticateDeviceRequest{},
	)
	assertRuntimeErrorCode(t, err, grpcUnauthenticated)
}

func TestFeatureStubDeniesAnonymousAndFailsExplicitlyForBridgeSession(t *testing.T) {
	t.Parallel()

	_, anonymousError := featureNotReadyRPC(context.Background(), nil, nil, nil, "{}")
	assertRuntimeErrorCode(t, anonymousError, grpcUnauthenticated)

	authenticated := context.WithValue(context.Background(), runtime.RUNTIME_CTX_USER_ID, "nakama-user-id")
	authenticated = context.WithValue(authenticated, runtime.RUNTIME_CTX_VARS, map[string]string{
		"app_auth_session_id": testAuthSessionID,
		"app_player_id":       testPlayerID,
		"bridge_version":      bridgeAssertionVersion,
	})
	_, featureError := featureNotReadyRPC(authenticated, nil, nil, nil, "{}")
	assertRuntimeErrorCode(t, featureError, grpcUnimplemented)
	if featureError.Error() != "feature_not_ready" {
		t.Fatalf("unexpected feature error: %v", featureError)
	}
}

func assertRuntimeErrorCode(t *testing.T, err error, expected int) {
	t.Helper()
	runtimeError, ok := err.(*runtime.Error)
	if !ok {
		t.Fatalf("expected runtime error, got %T (%v)", err, err)
	}
	if runtimeError.Code != expected {
		t.Fatalf("runtime error code %d, expected %d", runtimeError.Code, expected)
	}
}
