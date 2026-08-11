package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	lobbyMatchTickRate          = 10
	lobbyStateOpcode            = 1
	roundRoleAssignedOpcode     = 2
	roundPhaseChangedOpcode     = 3
	roundDiscoveryOpcode        = 4
	roundPlayerStateOpcode      = 5
	hunterFireResultOpcode      = 6
	roundSpectatorOpcode        = 7
	roundScoreOpcode            = 8
	roundAnswerCheckOpcode      = 9
	hunterFireCommandOpcode     = 10
	answerCheckLikeOpcode       = 11
	answerCheckLikeResultOpcode = 12
	roundReconnectOpcode        = 13
)

type persistentLobbyMatch struct {
	store lobbyStore
	now   func() time.Time
}

type lobbyPresence struct {
	PlayerID string
	Presence runtime.Presence
}

type persistentLobbyState struct {
	LobbyID               string
	Snapshot              lobbySnapshot
	Presences             map[string]lobbyPresence
	PendingPlayerIDs      map[string]string
	PendingLeaves         map[string]string
	ReconnectReservations map[string]roundReconnectReservation
	Nominations           map[string]bool
	Round                 *roundSnapshot
	AuthoritativeRound    *authoritativeRoundState
	AvatarStates          map[string]roundAvatarStateSnapshot
	CachedScore           *roundScoreSnapshot
	NextScoreBatchAt      time.Time
	ScoreBatchSequence    uint64
	LiveStateDirty        bool
	LiveStatePersistedAt  time.Time
}

func (m *persistentLobbyMatch) MatchInit(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	params map[string]interface{},
) (interface{}, int, string) {
	lobbyID, ok := params["lobby_id"].(string)
	if !ok || validateLobbyID(lobbyID) != nil {
		logger.Error("persistent lobby match received an invalid lobby ID")
		return nil, lobbyMatchTickRate, ""
	}
	snapshot, err := m.store.Snapshot(ctx, lobbyID)
	if err != nil || snapshot.Closed {
		logger.Error("persistent lobby match could not load open lobby %s: %v", lobbyID, err)
		return nil, lobbyMatchTickRate, ""
	}
	round, err := m.store.ActiveRound(ctx, lobbyID)
	if err != nil {
		logger.Error("persistent lobby match could not load active round %s: %v", lobbyID, err)
		return nil, lobbyMatchTickRate, ""
	}
	state := &persistentLobbyState{
		LobbyID:               lobbyID,
		Snapshot:              snapshot,
		Presences:             make(map[string]lobbyPresence),
		PendingPlayerIDs:      make(map[string]string),
		PendingLeaves:         make(map[string]string),
		ReconnectReservations: make(map[string]roundReconnectReservation),
		Nominations:           make(map[string]bool),
		Round:                 round,
		AvatarStates:          make(map[string]roundAvatarStateSnapshot),
	}
	applyLiveLobbyState(state, snapshot)
	if round != nil {
		checkpointPayload, checkpointAt, err := m.store.LoadLiveRoundCheckpoint(
			ctx,
			round.ID,
		)
		if err != nil {
			logger.Error(
				"persistent lobby match could not load private round checkpoint %s: %v",
				round.ID,
				err,
			)
			return nil, lobbyMatchTickRate, ""
		}
		if len(checkpointPayload) == 0 {
			logger.Error(
				"active round %s has no private authoritative checkpoint",
				round.ID,
			)
			return nil, lobbyMatchTickRate, ""
		}
		checkpoint, err := decodeLiveRoundCheckpoint(checkpointPayload, round)
		if err != nil {
			logger.Error(
				"active round %s has an invalid private checkpoint: %v",
				round.ID,
				err,
			)
			return nil, lobbyMatchTickRate, ""
		}
		applyLiveRoundCheckpoint(state, round, checkpoint, checkpointAt)
		state.synthesizeCrashReconnectReservations(checkpointAt)
		if err := m.persistLiveRoundState(
			ctx,
			state,
			m.nowUTC(),
			true,
		); err != nil {
			logger.Error(
				"active round %s could not fence crash-recovery state: %v",
				round.ID,
				err,
			)
			return nil, lobbyMatchTickRate, ""
		}
	}
	return state, lobbyMatchTickRate, lobbyMatchLabel(snapshot)
}

func (m *persistentLobbyMatch) MatchJoinAttempt(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ runtime.MatchDispatcher,
	_ int64,
	rawState interface{},
	presence runtime.Presence,
	_ map[string]string,
) (interface{}, bool, string) {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil || state.Snapshot.Closed {
		return rawState, false, "lobby is unavailable"
	}
	playerID, err := bridgedPlayerIDForPresence(ctx, presence)
	if err != nil {
		logger.Warn("rejecting lobby join for unbound Nakama user %s: %v", presence.GetUserId(), err)
		return state, false, "scoped realtime identity required"
	}
	member, err := m.store.IsOpenMember(ctx, state.LobbyID, playerID)
	if err != nil {
		logger.Error("check lobby membership for join: %v", err)
		return state, false, "lobby membership check unavailable"
	}
	if !member {
		return state, false, "join the persistent lobby through lobby.join first"
	}
	state.expireReconnectReservations(m.nowUTC())
	if _, leaving := state.PendingLeaves[playerID]; leaving {
		return state, false, "reconnect window expired"
	}
	state.PendingPlayerIDs[presence.GetSessionId()] = playerID
	return state, true, ""
}

func (m *persistentLobbyMatch) MatchJoin(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	_ int64,
	rawState interface{},
	presences []runtime.Presence,
) interface{} {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil {
		return nil
	}
	now := m.nowUTC()
	restored := make([]roundReconnectSnapshot, 0, len(presences))
	scoreRecipients := make([]runtime.Presence, 0, len(presences))
	for _, presence := range presences {
		playerID := state.PendingPlayerIDs[presence.GetSessionId()]
		delete(state.PendingPlayerIDs, presence.GetSessionId())
		if playerID == "" {
			logger.Error("joined lobby presence has no scoped player identity")
			_ = dispatcher.MatchKick([]runtime.Presence{presence})
			continue
		}
		replaced := replacePlayerPresence(state, playerID, presence)
		if len(replaced) > 0 {
			_ = dispatcher.MatchKick(replaced)
		}
		scoreRecipients = append(scoreRecipients, presence)
		if snapshot, reconnected := state.restoreReconnect(playerID, now); reconnected {
			restored = append(restored, snapshot)
		}
	}
	if len(restored) > 0 {
		if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
			logger.Error("persist restored reconnect state: %v", err)
			return nil
		}
	}
	m.refreshAndBroadcast(ctx, logger, dispatcher, state)
	m.broadcastRoundState(logger, dispatcher, state)
	if state.CachedScore != nil && len(scoreRecipients) > 0 {
		m.broadcastScoreSnapshotTo(
			logger,
			dispatcher,
			*state.CachedScore,
			scoreRecipients,
		)
	}
	for _, snapshot := range restored {
		m.broadcastReconnectState(logger, dispatcher, state, snapshot)
	}
	return state
}

func (m *persistentLobbyMatch) MatchLeave(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	_ int64,
	rawState interface{},
	presences []runtime.Presence,
) interface{} {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil {
		return nil
	}
	now := m.nowUTC()
	for _, presence := range presences {
		sessionID := presence.GetSessionId()
		tracked, exists := state.Presences[sessionID]
		delete(state.Presences, sessionID)
		delete(state.PendingPlayerIDs, sessionID)
		if !exists {
			continue
		}
		if len(presencesForPlayer(state, tracked.PlayerID)) > 0 {
			continue
		}
		reason := "host_left"
		if presence.GetReason() == runtime.PresenceReasonDisconnect {
			reason = "host_disconnected"
			if state.reserveReconnect(tracked.PlayerID, now) {
				continue
			}
		}
		state.PendingLeaves[tracked.PlayerID] = reason
	}
	if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
		logger.Error("persist round state after disconnect: %v", err)
		return nil
	}
	closed, err := m.flushPendingLeaves(ctx, state)
	if err != nil {
		logger.Error("persist lobby departures; retrying from match loop: %v", err)
		return state
	}
	if closed {
		return nil
	}
	m.broadcastState(logger, dispatcher, state)
	return state
}

func (m *persistentLobbyMatch) MatchLoop(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	_ int64,
	rawState interface{},
	messages []runtime.MatchData,
) interface{} {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil {
		return nil
	}
	if state.Snapshot.Closed {
		return nil
	}
	now := m.nowUTC()
	state.expireReconnectReservations(now)
	state.queueUnreachableRoundParticipants(now)
	hadPendingLeaves := len(state.PendingLeaves) > 0
	if len(state.PendingLeaves) > 0 {
		closed, err := m.flushPendingLeaves(ctx, state)
		if err != nil {
			logger.Error("retry persistent lobby departures: %v", err)
			return state
		}
		if closed {
			return nil
		}
	}

	if state.noReachableRoundParticipants(now) {
		if err := m.store.AbortRound(
			ctx,
			state.LobbyID,
			state.Round.ID,
			reconnectWindowExpiredRoundAbortReason,
			now,
		); err != nil {
			logger.Error("abort round with no reachable participants; retrying: %v", err)
			return state
		}
		state.Round.Status = "aborted"
		state.Round.EndedAt = now
		state.Round.PhaseDeadline = nil
		state.Round.WinningSide = ""
		state.Round.CompletionReason = reconnectWindowExpiredRoundAbortReason
		state.AuthoritativeRound = nil
		clear(state.ReconnectReservations)
		clear(state.AvatarStates)
		state.resetScoreCache()
		state.LiveStateDirty = false
		m.broadcastState(logger, dispatcher, state)
		m.broadcastRoundState(logger, dispatcher, state)
		return state
	}

	if hadPendingLeaves {
		if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
			logger.Error("persist expired reconnect state: %v", err)
			return nil
		}
		m.broadcastState(logger, dispatcher, state)
	}

	if state.Round == nil || state.AuthoritativeRound == nil {
		return state
	}
	phaseChanges := state.AuthoritativeRound.Advance(now)
	if len(phaseChanges) > 0 {
		state.AuthoritativeRound.Apply(state.Round)
		state.markLiveRoundDirty()
		if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
			logger.Error("persist authoritative phase transition: %v", err)
			return nil
		}
		for _, phase := range phaseChanges {
			if phase != "hiding" && phase != "hunting" {
				continue
			}
			if err := m.store.UpdateRoundPhase(ctx, state.Round.ID, phase); err != nil {
				logger.Warn("persist best-effort round phase %s: %v", phase, err)
			}
		}
		m.broadcastRoundState(logger, dispatcher, state)
	}

	for _, message := range messages {
		tracked, exists := state.Presences[message.GetSessionId()]
		if !exists {
			logger.Warn("ignoring round command from untracked presence")
			continue
		}
		switch message.GetOpCode() {
		case hunterFireCommandOpcode:
			command, err := decodeHunterFireCommand(message.GetData())
			if err != nil {
				result := hunterFireResult{
					RoundID: state.Round.ID,
					Reason:  "invalid_command",
					RoundIsTerminal: state.AuthoritativeRound.Phase == "answer_check" ||
						state.AuthoritativeRound.Phase == "completed",
				}
				if playerState, available := state.AuthoritativeRound.PlayerState(
					tracked.PlayerID,
				); available {
					result.ShellsRemaining = playerState.ShellsRemaining
					result.ReloadUntil = playerState.ReloadUntil
				}
				m.broadcastFireResult(logger, dispatcher, message, result)
				continue
			}
			command = state.authorizeFireTarget(
				tracked.PlayerID,
				command,
				now,
			)
			result, discovery := state.AuthoritativeRound.HandleFire(
				tracked.PlayerID,
				command,
				now,
			)
			state.markLiveRoundDirty()
			if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
				logger.Error(
					"persist authoritative Hunter fire result for %s: %v",
					tracked.PlayerID,
					err,
				)
				return nil
			}
			m.broadcastFireResult(logger, dispatcher, message, result)
			m.broadcastRoundPlayerState(
				logger,
				dispatcher,
				state,
				tracked.PlayerID,
			)
			if discovery == nil {
				continue
			}
			state.AuthoritativeRound.Apply(state.Round)
			m.broadcastDiscovery(logger, dispatcher, *discovery)
			m.broadcastRoundPlayerState(
				logger,
				dispatcher,
				state,
				discovery.HiderPlayerID,
			)
			m.broadcastRoundState(logger, dispatcher, state)
		case answerCheckLikeOpcode:
			command, err := decodeAnswerCheckLikeCommand(message.GetData())
			if err != nil {
				m.broadcastLikeResult(
					logger,
					dispatcher,
					message,
					answerCheckLikeResult{
						RoundID: state.Round.ID,
						Reason:  "invalid_command",
					},
				)
				continue
			}
			result := state.AuthoritativeRound.HandleLike(
				tracked.PlayerID,
				command,
				now,
			)
			if result.Accepted {
				state.CachedScore = nil
			}
			state.markLiveRoundDirty()
			if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
				logger.Error(
					"persist authoritative Answer Check like for %s: %v",
					tracked.PlayerID,
					err,
				)
				return nil
			}
			m.broadcastLikeResult(logger, dispatcher, message, result)
			if result.Accepted {
				m.broadcastRoundPresentation(logger, dispatcher, state, now)
			}
		case avatarStateCommandOpcode:
			command, err := decodeAvatarStateCommand(message.GetData())
			if err != nil {
				logger.Warn(
					"ignoring invalid avatar state from player %s",
					tracked.PlayerID,
				)
				m.broadcastAvatarCorrection(
					logger,
					dispatcher,
					state,
					tracked,
				)
				continue
			}
			snapshot, err := state.applyAvatarState(
				tracked.PlayerID,
				command,
				now,
			)
			if err != nil {
				logger.Warn(
					"ignoring unauthorized avatar state from player %s: %v",
					tracked.PlayerID,
					err,
				)
				m.broadcastAvatarCorrection(
					logger,
					dispatcher,
					state,
					tracked,
				)
				continue
			}
			state.markLiveRoundDirty()
			m.broadcastAvatarState(logger, dispatcher, state, snapshot, false)
		}
	}
	if state.scoreBatchDue(now) {
		scores, err := state.refreshProvisionalScore(now)
		if err != nil {
			logger.Error("compute authoritative provisional score batch: %v", err)
		} else {
			state.markLiveRoundDirty()
			if err := m.persistLiveRoundState(ctx, state, now, true); err != nil {
				logger.Error("persist authoritative provisional score batch: %v", err)
				return nil
			}
			m.broadcastScoreSnapshot(logger, dispatcher, scores)
		}
	}
	if state.AuthoritativeRound.ReadyToCommit(now) {
		outcome, err := finalizeAuthoritativeRound(
			ctx,
			m.store,
			state.Round,
			state.AuthoritativeRound,
		)
		if err != nil {
			logger.Error("commit authoritative terminal round result; retrying: %v", err)
			return state
		}
		logger.Info(
			"terminal round result %s for round %s",
			outcome,
			state.Round.ID,
		)
		state.LiveStateDirty = false
		if err := m.store.DeleteLiveRoundCheckpoint(ctx, state.Round.ID); err != nil {
			logger.Warn(
				"delete completed private round checkpoint %s: %v",
				state.Round.ID,
				err,
			)
		}
		m.broadcastRoundState(logger, dispatcher, state)
		state.LiveStateDirty = false
	}
	checkpointHeartbeatDue := state.LiveStatePersistedAt.IsZero() ||
		!now.Before(
			state.LiveStatePersistedAt.Add(liveRoundCheckpointHeartbeat),
		)
	if err := m.persistLiveRoundState(
		ctx,
		state,
		now,
		checkpointHeartbeatDue,
	); err != nil {
		logger.Error("periodically persist live round state: %v", err)
		return nil
	}
	return state
}

func (m *persistentLobbyMatch) MatchTerminate(
	_ context.Context,
	_ runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	_ runtime.MatchDispatcher,
	_ int64,
	state interface{},
	_ int,
) interface{} {
	// Nakama process shutdown must not masquerade as a player-requested lobby close. The durable
	// lifecycle remains available and ensureLobbyMatch will bind a fresh authoritative loop.
	return state
}

func (m *persistentLobbyMatch) MatchSignal(
	ctx context.Context,
	logger runtime.Logger,
	_ *sql.DB,
	_ runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	_ int64,
	rawState interface{},
	data string,
) (interface{}, string) {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil {
		return nil, encodeLobbySignalError(errors.New("lobby match state is unavailable"))
	}
	var signal lobbySignal
	if err := json.Unmarshal([]byte(data), &signal); err != nil {
		return state, encodeLobbySignalError(
			newLobbyProblem(grpcInvalidArgument, "invalid lobby match signal"),
		)
	}
	switch signal.Type {
	case "terminate_duplicate":
		return nil, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
	case "sync":
		snapshot, err := m.store.Snapshot(ctx, state.LobbyID)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		applyLiveLobbyState(state, snapshot)
		m.broadcastState(logger, dispatcher, state)
		m.broadcastRoundState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
	case "leave":
		if signal.PlayerID == "" {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "leaving player is required"),
			)
		}
		reason := signal.LeaveReason
		if reason != "host_left" && reason != "host_disconnected" {
			reason = "host_left"
		}
		snapshot, closed, err := m.store.Leave(
			ctx,
			state.LobbyID,
			[]string{signal.PlayerID},
			reason,
		)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		applyLiveLobbyState(state, snapshot)
		kickPlayerPresences(dispatcher, state, signal.PlayerID)
		if closed {
			// Let the signal response reach the caller before MatchLoop terminates the now-closed
			// authoritative match on its next tick.
			return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
		}
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
	case "reconnect":
		if signal.PlayerID == "" {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "reconnecting player is required"),
			)
		}
		now := m.nowUTC()
		state.expireReconnectReservations(now)
		if _, leaving := state.PendingLeaves[signal.PlayerID]; leaving {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcFailedPrecondition, "reconnect window expired"),
			)
		}
		reconnect, available := state.reconnectProbe(signal.PlayerID, now)
		if !available {
			return state, encodeLobbySignalError(
				newLobbyProblem(
					grpcFailedPrecondition,
					"no active reconnect reservation",
				),
			)
		}
		var round *roundPublicSnapshot
		if state.Round != nil {
			publicRound := state.Round.Public()
			round = &publicRound
		}
		return state, encodeLobbySignalResponse(lobbyRPCResponse{
			Lobby:     state.Snapshot,
			Round:     round,
			Reconnect: &reconnect,
		})
	case "nominate_hunter":
		if signal.Nomination == nil || signal.Nomination.LobbyID != state.LobbyID {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "invalid hunter nomination signal"),
			)
		}
		if state.Round != nil &&
			state.Round.Status != "completed" && state.Round.Status != "aborted" {
			return state, encodeLobbySignalError(
				newLobbyProblem(
					grpcFailedPrecondition,
					"hunter nomination is closed after round start",
				),
			)
		}
		if state.Nominations[signal.PlayerID] == signal.Nomination.Nominated {
			if signal.Nomination.ExpectedLobbyVersion != state.Snapshot.RowVersion {
				return state, encodeLobbySignalError(
					newLobbyProblem(
						grpcAborted,
						"lobby version changed; refresh state and retry",
					),
				)
			}
			return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
		}
		snapshot, err := m.store.RecordNominationChange(
			ctx,
			signal.PlayerID,
			*signal.Nomination,
		)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		applyLiveLobbyState(state, snapshot)
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
	case "update_configuration":
		if signal.UpdateConfiguration == nil ||
			signal.UpdateConfiguration.LobbyID != state.LobbyID {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "invalid lobby configuration signal"),
			)
		}
		snapshot, err := m.store.UpdateConfiguration(
			ctx,
			signal.PlayerID,
			*signal.UpdateConfiguration,
		)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		applyLiveLobbyState(state, snapshot)
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: state.Snapshot})
	case "start":
		if signal.Start == nil || signal.Start.LobbyID != state.LobbyID {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "invalid lobby start signal"),
			)
		}
		if state.Round != nil &&
			(state.Round.Status == "completed" || state.Round.Status == "aborted") {
			previousRoundID := state.Round.ID
			state.Round = nil
			state.AuthoritativeRound = nil
			clear(state.AvatarStates)
			clear(state.ReconnectReservations)
			state.resetScoreCache()
			if err := m.store.DeleteLiveRoundCheckpoint(
				ctx,
				previousRoundID,
			); err != nil {
				logger.Warn(
					"delete stale terminal-round checkpoint %s: %v",
					previousRoundID,
					err,
				)
			}
		}
		if state.Round != nil {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcFailedPrecondition, "lobby already has an active round"),
			)
		}
		snapshot, round, err := m.store.StartRound(
			ctx,
			signal.PlayerID,
			*signal.Start,
		)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		authoritativeRound, err := newAuthoritativeRoundState(&round)
		if err != nil {
			logger.Error("initialize authoritative %s round: %v", round.Mode, err)
			return state, encodeLobbySignalError(
				errors.New("authoritative round initialization failed"),
			)
		}
		state.Round = &round
		state.AuthoritativeRound = authoritativeRound
		state.AvatarStates = initializeRoundAvatarStates(&round, authoritativeRound)
		clear(state.ReconnectReservations)
		if _, err := state.initializeScoreCache(round.StartedAt); err != nil {
			logger.Error("initialize authoritative score cache: %v", err)
		}
		state.LiveStateDirty = false
		state.LiveStatePersistedAt = round.StartedAt.UTC()
		applyLiveLobbyState(state, snapshot)
		m.broadcastState(logger, dispatcher, state)
		m.broadcastRoundState(logger, dispatcher, state)
		if state.CachedScore != nil {
			m.broadcastScoreSnapshot(logger, dispatcher, *state.CachedScore)
		}
		publicRound := round.Public()
		return state, encodeLobbySignalResponse(lobbyRPCResponse{
			Lobby:         state.Snapshot,
			StartAccepted: true,
			Round:         &publicRound,
		})
	default:
		return state, encodeLobbySignalError(
			newLobbyProblem(grpcInvalidArgument, "unknown lobby match signal"),
		)
	}
}

func (m *persistentLobbyMatch) flushPendingLeaves(
	ctx context.Context,
	state *persistentLobbyState,
) (bool, error) {
	if len(state.PendingLeaves) == 0 {
		return state.Snapshot.Closed, nil
	}
	playerIDs := make([]string, 0, len(state.PendingLeaves))
	hostReason := "host_left"
	for playerID, reason := range state.PendingLeaves {
		playerIDs = append(playerIDs, playerID)
		if playerID == state.Snapshot.CurrentHostPlayerID && reason == "host_disconnected" {
			hostReason = "host_disconnected"
		}
	}
	snapshot, closed, err := m.store.Leave(ctx, state.LobbyID, playerIDs, hostReason)
	if err != nil {
		return false, err
	}
	for _, playerID := range playerIDs {
		if state.AuthoritativeRound != nil {
			if _, participant := state.AuthoritativeRound.Assignments[playerID]; participant {
				continue
			}
		}
		delete(state.AvatarStates, playerID)
	}
	clear(state.PendingLeaves)
	applyLiveLobbyState(state, snapshot)
	return closed, nil
}

func (m *persistentLobbyMatch) refreshAndBroadcast(
	ctx context.Context,
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
) {
	snapshot, err := m.store.Snapshot(ctx, state.LobbyID)
	if err != nil {
		logger.Error("refresh lobby state after match join: %v", err)
		return
	}
	applyLiveLobbyState(state, snapshot)
	m.broadcastState(logger, dispatcher, state)
}

func (m *persistentLobbyMatch) broadcastState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
) {
	payload, err := json.Marshal(state.Snapshot)
	if err != nil {
		logger.Error("encode lobby state broadcast: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(lobbyStateOpcode, payload, nil, nil, true); err != nil {
		logger.Error("broadcast lobby state: %v", err)
	}
	if err := dispatcher.MatchLabelUpdate(lobbyMatchLabel(state.Snapshot)); err != nil {
		logger.Error("update lobby match label: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastRoundState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
) {
	if state.Round == nil {
		return
	}
	publicRound := state.Round.Public()
	phasePayload, err := json.Marshal(publicRound)
	if err != nil {
		logger.Error("encode round phase broadcast: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundPhaseChangedOpcode,
		phasePayload,
		nil,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast round phase: %v", err)
	}
	for _, assignment := range state.Round.RoleAssignments {
		presences := presencesForPlayer(state, assignment.PlayerID)
		if len(presences) == 0 {
			continue
		}
		payload, err := json.Marshal(assignment)
		if err != nil {
			logger.Error("encode private role assignment: %v", err)
			continue
		}
		if err := dispatcher.BroadcastMessage(
			roundRoleAssignedOpcode,
			payload,
			presences,
			nil,
			true,
		); err != nil {
			logger.Error("broadcast private role assignment: %v", err)
		}
	}
	if state.AuthoritativeRound == nil {
		return
	}
	for _, playerID := range sortedPlayerIDs(state.AuthoritativeRound.Assignments) {
		m.broadcastRoundPlayerState(logger, dispatcher, state, playerID)
	}
	m.broadcastAvatarStates(logger, dispatcher, state)
	seenPlayers := make(map[string]struct{}, len(state.Presences))
	for _, tracked := range state.Presences {
		if _, sent := seenPlayers[tracked.PlayerID]; sent {
			continue
		}
		seenPlayers[tracked.PlayerID] = struct{}{}
		m.broadcastSpectatorState(
			logger,
			dispatcher,
			state,
			tracked.PlayerID,
		)
	}
	if state.AuthoritativeRound.Phase == "answer_check" ||
		state.AuthoritativeRound.Phase == "completed" {
		m.broadcastRoundPresentation(
			logger,
			dispatcher,
			state,
			m.nowUTC(),
		)
	}
}

func (m *persistentLobbyMatch) broadcastRoundPlayerState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	playerID string,
) {
	if state.AuthoritativeRound == nil {
		return
	}
	playerState, available := state.AuthoritativeRound.PlayerState(playerID)
	if !available {
		return
	}
	presences := presencesForPlayer(state, playerID)
	if len(presences) == 0 {
		return
	}
	payload, err := json.Marshal(playerState)
	if err != nil {
		logger.Error("encode private round player state: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundPlayerStateOpcode,
		payload,
		presences,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast private round player state: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastDiscovery(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	discovery roundDiscoverySnapshot,
) {
	payload, err := json.Marshal(discovery)
	if err != nil {
		logger.Error("encode authoritative discovery: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundDiscoveryOpcode,
		payload,
		nil,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast authoritative discovery: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastFireResult(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	presence runtime.Presence,
	result hunterFireResult,
) {
	payload, err := json.Marshal(result)
	if err != nil {
		logger.Error("encode private Hunter fire result: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		hunterFireResultOpcode,
		payload,
		[]runtime.Presence{presence},
		nil,
		true,
	); err != nil {
		logger.Error("broadcast private Hunter fire result: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastAvatarStates(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
) {
	playerIDs := make([]string, 0, len(state.AvatarStates))
	for playerID := range state.AvatarStates {
		playerIDs = append(playerIDs, playerID)
	}
	sort.Strings(playerIDs)
	for _, playerID := range playerIDs {
		snapshot := state.AvatarStates[playerID]
		if playerState, available := state.AuthoritativeRound.PlayerState(playerID); available {
			snapshot.Role = playerState.Role
			snapshot.Status = playerState.Status
			state.AvatarStates[playerID] = snapshot
		}
		m.broadcastAvatarState(logger, dispatcher, state, snapshot, true)
	}
}

func (m *persistentLobbyMatch) broadcastAvatarState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	snapshot roundAvatarStateSnapshot,
	reliable bool,
) {
	payload, err := json.Marshal(snapshot)
	if err != nil {
		logger.Error("encode avatar state: %v", err)
		return
	}
	recipients, restricted := avatarStateRecipients(state, snapshot)
	if restricted && len(recipients) == 0 {
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundAvatarStateOpcode,
		payload,
		recipients,
		nil,
		reliable,
	); err != nil {
		logger.Error("broadcast avatar state: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastAvatarCorrection(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	tracked lobbyPresence,
) {
	if state == nil || tracked.Presence == nil {
		return
	}
	snapshot, available := state.AvatarStates[tracked.PlayerID]
	if !available {
		return
	}
	snapshot.Correction = true
	payload, err := json.Marshal(snapshot)
	if err != nil {
		logger.Error("encode private avatar correction: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundAvatarStateOpcode,
		payload,
		[]runtime.Presence{tracked.Presence},
		nil,
		true,
	); err != nil {
		logger.Error("broadcast private avatar correction: %v", err)
	}
}

func avatarStateRecipients(
	state *persistentLobbyState,
	snapshot roundAvatarStateSnapshot,
) ([]runtime.Presence, bool) {
	if state == nil ||
		state.AuthoritativeRound == nil ||
		snapshot.Role != "hider" {
		return nil, false
	}
	phase := state.AuthoritativeRound.Phase
	restricted := phase == "preparing" ||
		phase == "hiding" ||
		(phase == "hunting" && state.AuthoritativeRound.Mode == "infection")
	if !restricted {
		return nil, false
	}
	recipients := make([]runtime.Presence, 0, len(state.Presences))
	for _, tracked := range state.Presences {
		if tracked.PlayerID == snapshot.PlayerID {
			recipients = append(recipients, tracked.Presence)
			continue
		}
		if state.AuthoritativeRound.SpectatorState(tracked.PlayerID).Eligible {
			recipients = append(recipients, tracked.Presence)
			continue
		}
		playerState, participant := state.AuthoritativeRound.PlayerState(
			tracked.PlayerID,
		)
		if !participant {
			continue
		}
		if (phase == "preparing" || phase == "hiding") &&
			state.AuthoritativeRound.Mode == "casual" &&
			playerState.Role == "hider" {
			recipients = append(recipients, tracked.Presence)
			continue
		}
		if phase == "hunting" &&
			state.AuthoritativeRound.Mode == "infection" &&
			playerState.Role == "hunter" {
			recipients = append(recipients, tracked.Presence)
		}
	}
	return recipients, true
}

func (m *persistentLobbyMatch) broadcastSpectatorState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	playerID string,
) {
	if state.AuthoritativeRound == nil {
		return
	}
	presences := presencesForPlayer(state, playerID)
	if len(presences) == 0 {
		return
	}
	snapshot := state.AuthoritativeRound.SpectatorState(playerID)
	payload, err := json.Marshal(snapshot)
	if err != nil {
		logger.Error("encode private spectator state: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundSpectatorOpcode,
		payload,
		presences,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast private spectator state: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastRoundPresentation(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	computedAt time.Time,
) {
	if state.Round == nil || state.AuthoritativeRound == nil {
		return
	}
	answerCheckPayload, err := json.Marshal(
		state.AuthoritativeRound.AnswerCheck(state.AvatarStates),
	)
	if err != nil {
		logger.Error("encode Answer Check state: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundAnswerCheckOpcode,
		answerCheckPayload,
		nil,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast Answer Check state: %v", err)
	}

	_ = computedAt
	if err := state.ensureFinalScoreCache(); err != nil {
		logger.Error("compute authoritative score state: %v", err)
		return
	}
	if state.CachedScore != nil {
		m.broadcastScoreSnapshot(logger, dispatcher, *state.CachedScore)
	}
}

func (m *persistentLobbyMatch) broadcastScoreSnapshot(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	scores roundScoreSnapshot,
) {
	m.broadcastScoreSnapshotTo(logger, dispatcher, scores, nil)
}

func (m *persistentLobbyMatch) broadcastScoreSnapshotTo(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	scores roundScoreSnapshot,
	presences []runtime.Presence,
) {
	scorePayload, err := json.Marshal(scores)
	if err != nil {
		logger.Error("encode authoritative score state: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundScoreOpcode,
		scorePayload,
		presences,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast authoritative score state: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastLikeResult(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	presence runtime.Presence,
	result answerCheckLikeResult,
) {
	payload, err := json.Marshal(result)
	if err != nil {
		logger.Error("encode Answer Check like result: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		answerCheckLikeResultOpcode,
		payload,
		[]runtime.Presence{presence},
		nil,
		true,
	); err != nil {
		logger.Error("broadcast Answer Check like result: %v", err)
	}
}

func (m *persistentLobbyMatch) broadcastReconnectState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	snapshot roundReconnectSnapshot,
) {
	presences := presencesForPlayer(state, snapshot.PlayerID)
	if len(presences) == 0 {
		return
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		logger.Error("encode private reconnect state: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		roundReconnectOpcode,
		payload,
		presences,
		nil,
		true,
	); err != nil {
		logger.Error("broadcast private reconnect state: %v", err)
	}
}

func (m *persistentLobbyMatch) nowUTC() time.Time {
	if m.now != nil {
		return m.now().UTC()
	}
	return time.Now().UTC()
}

func bridgedPlayerIDForPresence(
	ctx context.Context,
	presence runtime.Presence,
) (string, error) {
	contextUserID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || contextUserID == "" || contextUserID != presence.GetUserId() {
		return "", errors.New("Nakama join context does not match presence")
	}
	playerID, err := trustedPlayerID(ctx)
	if err != nil {
		return "", err
	}
	return playerID, nil
}

func kickPlayerPresences(
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	playerID string,
) {
	presences := make([]runtime.Presence, 0, 1)
	for sessionID, tracked := range state.Presences {
		if tracked.PlayerID == playerID {
			presences = append(presences, tracked.Presence)
			delete(state.Presences, sessionID)
		}
	}
	if len(presences) > 0 {
		_ = dispatcher.MatchKick(presences)
	}
}

func presencesForPlayer(
	state *persistentLobbyState,
	playerID string,
) []runtime.Presence {
	presences := make([]runtime.Presence, 0, 1)
	for _, tracked := range state.Presences {
		if tracked.PlayerID == playerID {
			presences = append(presences, tracked.Presence)
		}
	}
	return presences
}

func replacePlayerPresence(
	state *persistentLobbyState,
	playerID string,
	presence runtime.Presence,
) []runtime.Presence {
	replaced := make([]runtime.Presence, 0, 1)
	for sessionID, tracked := range state.Presences {
		if tracked.PlayerID != playerID {
			continue
		}
		replaced = append(replaced, tracked.Presence)
		delete(state.Presences, sessionID)
	}
	state.Presences[presence.GetSessionId()] = lobbyPresence{
		PlayerID: playerID,
		Presence: presence,
	}
	return replaced
}

func applyLiveLobbyState(state *persistentLobbyState, snapshot lobbySnapshot) {
	memberIDs := make(map[string]struct{}, len(snapshot.Members))
	for _, member := range snapshot.Members {
		memberIDs[member.PlayerID] = struct{}{}
	}
	state.Nominations = make(map[string]bool, len(snapshot.HunterNomineeIDs))
	nominees := make([]string, 0, len(snapshot.HunterNomineeIDs))
	for _, playerID := range snapshot.HunterNomineeIDs {
		if _, member := memberIDs[playerID]; !member || state.Nominations[playerID] {
			continue
		}
		state.Nominations[playerID] = true
		nominees = append(nominees, playerID)
	}
	sort.Strings(nominees)
	snapshot.HunterNomineeIDs = nominees
	state.Snapshot = snapshot
}

func lobbyMatchLabel(snapshot lobbySnapshot) string {
	label := struct {
		LobbyID    string `json:"lobby_id"`
		Open       bool   `json:"open"`
		Region     string `json:"region"`
		Players    int    `json:"players"`
		MaxPlayers int16  `json:"max_players"`
	}{
		LobbyID:    snapshot.ID,
		Open:       !snapshot.Closed && len(snapshot.Members) < int(snapshot.MaxPlayers),
		Region:     snapshot.RegionCode,
		Players:    len(snapshot.Members),
		MaxPlayers: snapshot.MaxPlayers,
	}
	value, err := json.Marshal(label)
	if err != nil {
		return "{}"
	}
	return string(value)
}

func encodeLobbySignalResponse(response lobbyRPCResponse) string {
	value, err := json.Marshal(lobbySignalResult{Response: &response})
	if err != nil {
		return `{"error":"lobby response encoding failed","code":14}`
	}
	return string(value)
}

func encodeLobbySignalError(err error) string {
	result := lobbySignalResult{Error: "lobby service unavailable", Code: grpcUnavailable}
	var problem *lobbyProblem
	if errors.As(err, &problem) {
		result.Error = problem.message
		result.Code = problem.code
	}
	value, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return `{"error":"lobby response encoding failed","code":14}`
	}
	return string(value)
}
