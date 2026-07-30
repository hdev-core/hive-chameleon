package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	grpcPermissionDenied = 7
	grpcUnimplemented    = 12
)

var realtimeRPCNames = []string{
	"lobby.quick_play",
	"lobby.create",
	"lobby.join",
	"lobby.leave",
	"lobby.update_configuration",
	"lobby.kick",
	"lobby.transfer_host",
	"lobby.nominate_hunter",
	"lobby.start",
	"match.reconnect",
}

type realtimeInitializer interface {
	RegisterBeforeAuthenticateApple(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateAppleRequest) (*api.AuthenticateAppleRequest, error)) error
	RegisterBeforeAuthenticateCustom(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateCustomRequest) (*api.AuthenticateCustomRequest, error)) error
	RegisterBeforeAuthenticateDevice(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateDeviceRequest) (*api.AuthenticateDeviceRequest, error)) error
	RegisterBeforeAuthenticateEmail(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateEmailRequest) (*api.AuthenticateEmailRequest, error)) error
	RegisterBeforeAuthenticateFacebook(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateFacebookRequest) (*api.AuthenticateFacebookRequest, error)) error
	RegisterBeforeAuthenticateFacebookInstantGame(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateFacebookInstantGameRequest) (*api.AuthenticateFacebookInstantGameRequest, error)) error
	RegisterBeforeAuthenticateGameCenter(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateGameCenterRequest) (*api.AuthenticateGameCenterRequest, error)) error
	RegisterBeforeAuthenticateGoogle(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateGoogleRequest) (*api.AuthenticateGoogleRequest, error)) error
	RegisterBeforeAuthenticateSteam(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AuthenticateSteamRequest) (*api.AuthenticateSteamRequest, error)) error
	RegisterBeforeDeleteAccount(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule) error) error
	RegisterBeforeLinkCustom(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AccountCustom) (*api.AccountCustom, error)) error
	RegisterBeforeUnlinkCustom(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.AccountCustom) (*api.AccountCustom, error)) error
	RegisterBeforeUpdateAccount(func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, *api.UpdateAccountRequest) (*api.UpdateAccountRequest, error)) error
	RegisterMatch(string, func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule) (runtime.Match, error)) error
	RegisterRpc(string, func(context.Context, runtime.Logger, *sql.DB, runtime.NakamaModule, string) (string, error)) error
}

func registerRealtime(
	initializer realtimeInitializer,
	verifier *bridgeVerifier,
	lobbies *lobbyService,
) error {
	if err := initializer.RegisterBeforeAuthenticateCustom(verifier.beforeAuthenticateCustom); err != nil {
		return fmt.Errorf("register custom authentication bridge: %w", err)
	}

	// Nakama session variables supplied by its public authentication APIs are caller-controlled.
	// Reject every non-bridge authentication route so only the verified custom hook can mint a
	// token carrying trusted application player/session variables.
	nonBridgeRegistrations := []struct {
		name     string
		register func() error
	}{
		{"Apple", func() error {
			return initializer.RegisterBeforeAuthenticateApple(denyNonBridgeAuthentication[api.AuthenticateAppleRequest])
		}},
		{"device", func() error {
			return initializer.RegisterBeforeAuthenticateDevice(denyNonBridgeAuthentication[api.AuthenticateDeviceRequest])
		}},
		{"email", func() error {
			return initializer.RegisterBeforeAuthenticateEmail(denyNonBridgeAuthentication[api.AuthenticateEmailRequest])
		}},
		{"Facebook", func() error {
			return initializer.RegisterBeforeAuthenticateFacebook(denyNonBridgeAuthentication[api.AuthenticateFacebookRequest])
		}},
		{"Facebook Instant Game", func() error {
			return initializer.RegisterBeforeAuthenticateFacebookInstantGame(denyNonBridgeAuthentication[api.AuthenticateFacebookInstantGameRequest])
		}},
		{"Game Center", func() error {
			return initializer.RegisterBeforeAuthenticateGameCenter(denyNonBridgeAuthentication[api.AuthenticateGameCenterRequest])
		}},
		{"Google", func() error {
			return initializer.RegisterBeforeAuthenticateGoogle(denyNonBridgeAuthentication[api.AuthenticateGoogleRequest])
		}},
		{"Steam", func() error {
			return initializer.RegisterBeforeAuthenticateSteam(denyNonBridgeAuthentication[api.AuthenticateSteamRequest])
		}},
	}
	for _, registration := range nonBridgeRegistrations {
		if err := registration.register(); err != nil {
			return fmt.Errorf("register %s authentication rejection: %w", registration.name, err)
		}
	}

	// The application player UUID is Nakama's stable custom ID. Built-in mutation endpoints must
	// not let a client preclaim another player's UUID, detach its own bridge identity, rewrite the
	// canonical username, or delete the account outside the product lifecycle.
	accountMutationRegistrations := []struct {
		name     string
		register func() error
	}{
		{"custom identity link", func() error {
			return initializer.RegisterBeforeLinkCustom(denyAccountMutation[api.AccountCustom])
		}},
		{"custom identity unlink", func() error {
			return initializer.RegisterBeforeUnlinkCustom(denyAccountMutation[api.AccountCustom])
		}},
		{"account update", func() error {
			return initializer.RegisterBeforeUpdateAccount(denyAccountMutation[api.UpdateAccountRequest])
		}},
		{"account deletion", func() error {
			return initializer.RegisterBeforeDeleteAccount(denyAccountDeletion)
		}},
	}
	for _, registration := range accountMutationRegistrations {
		if err := registration.register(); err != nil {
			return fmt.Errorf("register %s rejection: %w", registration.name, err)
		}
	}

	lobbyRPCs := map[string]func(
		context.Context,
		runtime.Logger,
		*sql.DB,
		runtime.NakamaModule,
		string,
	) (string, error){
		"lobby.create":               lobbies.createRPC,
		"lobby.join":                 lobbies.joinRPC,
		"lobby.leave":                lobbies.leaveRPC,
		"lobby.nominate_hunter":      lobbies.nominateHunterRPC,
		"lobby.update_configuration": lobbies.updateConfigurationRPC,
		"lobby.start":                lobbies.startRPC,
	}
	for _, name := range realtimeRPCNames {
		handler := featureNotReadyRPC
		if lobbyHandler := lobbyRPCs[name]; lobbyHandler != nil {
			handler = lobbyHandler
		}
		if err := initializer.RegisterRpc(name, handler); err != nil {
			return fmt.Errorf("register RPC %s: %w", name, err)
		}
	}
	if err := initializer.RegisterMatch(
		lobbyMatchModule,
		func(
			_ context.Context,
			_ runtime.Logger,
			_ *sql.DB,
			_ runtime.NakamaModule,
		) (runtime.Match, error) {
			return &persistentLobbyMatch{store: lobbies.store}, nil
		},
	); err != nil {
		return fmt.Errorf("register persistent lobby match: %w", err)
	}

	return nil
}

func denyAccountMutation[T any](
	_ context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ *T,
) (*T, error) {
	return nil, runtime.NewError("account identity is managed by the product API", grpcPermissionDenied)
}

func denyAccountDeletion(
	_ context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
) error {
	return runtime.NewError("account identity is managed by the product API", grpcPermissionDenied)
}

func denyNonBridgeAuthentication[T any](
	_ context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ *T,
) (*T, error) {
	return nil, runtime.NewError("NestJS session bridge authentication required", grpcUnauthenticated)
}

func featureNotReadyRPC(
	ctx context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ string,
) (string, error) {
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", runtime.NewError("authenticated realtime session required", grpcUnauthenticated)
	}

	variables, ok := ctx.Value(runtime.RUNTIME_CTX_VARS).(map[string]string)
	if !ok || variables["bridge_version"] != bridgeAssertionVersion {
		return "", runtime.NewError("authenticated realtime session required", grpcUnauthenticated)
	}
	if _, err := canonicalUUIDV7ToCompact(variables["app_player_id"]); err != nil {
		return "", runtime.NewError("authenticated realtime session required", grpcUnauthenticated)
	}
	if _, err := canonicalUUIDV7ToCompact(variables["app_auth_session_id"]); err != nil {
		return "", runtime.NewError("authenticated realtime session required", grpcUnauthenticated)
	}

	// These names are intentionally reserved now so every client shares one vocabulary. Gameplay
	// cards replace each stub atomically with authoritative behavior and contract tests.
	return "", runtime.NewError("feature_not_ready", grpcUnimplemented)
}
