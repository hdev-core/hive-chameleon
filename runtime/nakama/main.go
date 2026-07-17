package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

const moduleName = "hive_chameleon"

// InitModule is Nakama's Go runtime entry point. Feature RPC and match registrations are added by
// the realtime foundation without changing the module boundary established here.
func InitModule(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	nk runtime.NakamaModule,
	initializer runtime.Initializer,
) error {
	verifier, err := newBridgeVerifierFromContext(ctx, &nakamaBridgeReplayStore{storage: nk})
	if err != nil {
		return fmt.Errorf("configure Nakama session bridge: %w", err)
	}

	if err := registerRealtime(initializer, verifier); err != nil {
		return fmt.Errorf("register Nakama realtime foundation: %w", err)
	}

	logger.Info("%s runtime initialized", moduleName)
	return nil
}
