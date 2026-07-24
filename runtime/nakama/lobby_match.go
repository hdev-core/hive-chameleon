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
	lobbyMatchTickRate      = 1
	lobbyStateOpcode        = 1
	roundRoleAssignedOpcode = 2
	roundPhaseChangedOpcode = 3
	roundDiscoveryOpcode    = 4
	roundPlayerStateOpcode  = 5
	hunterFireResultOpcode  = 6
	hunterFireCommandOpcode = 10
)

type persistentLobbyMatch struct {
	store lobbyStore
}

type lobbyPresence struct {
	PlayerID string
	Presence runtime.Presence
}

type persistentLobbyState struct {
	LobbyID          string
	Snapshot         lobbySnapshot
	Presences        map[string]lobbyPresence
	PendingPlayerIDs map[string]string
	PendingLeaves    map[string]string
	Nominations      map[string]bool
	Round            *roundSnapshot
	CasualRound      *casualRoundState
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
		LobbyID:          lobbyID,
		Snapshot:         snapshot,
		Presences:        make(map[string]lobbyPresence),
		PendingPlayerIDs: make(map[string]string),
		PendingLeaves:    make(map[string]string),
		Nominations:      make(map[string]bool),
		Round:            round,
	}
	applyLiveLobbyState(state, snapshot)
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
	for _, presence := range presences {
		playerID := state.PendingPlayerIDs[presence.GetSessionId()]
		delete(state.PendingPlayerIDs, presence.GetSessionId())
		if playerID == "" {
			logger.Error("joined lobby presence has no scoped player identity")
			_ = dispatcher.MatchKick([]runtime.Presence{presence})
			continue
		}
		state.Presences[presence.GetSessionId()] = lobbyPresence{
			PlayerID: playerID,
			Presence: presence,
		}
	}
	m.refreshAndBroadcast(ctx, logger, dispatcher, state)
	m.broadcastRoundState(logger, dispatcher, state)
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
	for _, presence := range presences {
		sessionID := presence.GetSessionId()
		tracked, exists := state.Presences[sessionID]
		delete(state.Presences, sessionID)
		delete(state.PendingPlayerIDs, sessionID)
		if !exists {
			continue
		}
		reason := "host_left"
		if presence.GetReason() == runtime.PresenceReasonDisconnect {
			reason = "host_disconnected"
		}
		state.PendingLeaves[tracked.PlayerID] = reason
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
	if len(state.PendingLeaves) > 0 {
		closed, err := m.flushPendingLeaves(ctx, state)
		if err != nil {
			logger.Error("retry persistent lobby departures: %v", err)
			return state
		}
		if closed {
			return nil
		}
		m.broadcastState(logger, dispatcher, state)
	}

	if state.Round == nil || state.CasualRound == nil {
		return state
	}
	now := time.Now().UTC()
	phaseChanges := state.CasualRound.Advance(now)
	if len(phaseChanges) > 0 {
		state.CasualRound.Apply(state.Round)
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
		if message.GetOpCode() != hunterFireCommandOpcode {
			continue
		}
		tracked, exists := state.Presences[message.GetSessionId()]
		if !exists {
			logger.Warn("ignoring round command from untracked presence")
			continue
		}
		command, err := decodeHunterFireCommand(message.GetData())
		if err != nil {
			result := hunterFireResult{
				RoundID:         state.Round.ID,
				Reason:          "invalid_command",
				RoundIsTerminal: state.CasualRound.Phase == "terminal",
			}
			if playerState, available := state.CasualRound.PlayerState(
				tracked.PlayerID,
			); available {
				result.ShellsRemaining = playerState.ShellsRemaining
				result.ReloadUntil = playerState.ReloadUntil
			}
			m.broadcastFireResult(logger, dispatcher, message, result)
			continue
		}
		result, discovery := state.CasualRound.HandleFire(
			tracked.PlayerID,
			command,
			now,
		)
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
		state.CasualRound.Apply(state.Round)
		m.broadcastDiscovery(logger, dispatcher, *discovery)
		m.broadcastRoundState(logger, dispatcher, state)
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
	case "nominate_hunter":
		if signal.Nomination == nil || signal.Nomination.LobbyID != state.LobbyID {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "invalid hunter nomination signal"),
			)
		}
		if state.Round != nil {
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
		if state.Round != nil {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcFailedPrecondition, "lobby already has an active round"),
			)
		}
		if state.Snapshot.Configuration.Mode != "casual" {
			return state, encodeLobbySignalError(
				newLobbyProblem(
					grpcFailedPrecondition,
					"only Casual mode is available in the current authoritative runtime",
				),
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
		casualRound, err := newCasualRoundState(&round)
		if err != nil {
			logger.Error("initialize authoritative Casual round: %v", err)
			return state, encodeLobbySignalError(
				errors.New("authoritative Casual round initialization failed"),
			)
		}
		state.Round = &round
		state.CasualRound = casualRound
		applyLiveLobbyState(state, snapshot)
		m.broadcastState(logger, dispatcher, state)
		m.broadcastRoundState(logger, dispatcher, state)
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
	if state.CasualRound == nil {
		return
	}
	for _, playerID := range sortedPlayerIDs(state.CasualRound.Assignments) {
		m.broadcastRoundPlayerState(logger, dispatcher, state, playerID)
	}
}

func (m *persistentLobbyMatch) broadcastRoundPlayerState(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	playerID string,
) {
	if state.CasualRound == nil {
		return
	}
	playerState, available := state.CasualRound.PlayerState(playerID)
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
