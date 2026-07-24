package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	lobbyMatchTickRate = 1
	lobbyStateOpcode   = 1
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
	state := &persistentLobbyState{
		LobbyID:          lobbyID,
		Snapshot:         snapshot,
		Presences:        make(map[string]lobbyPresence),
		PendingPlayerIDs: make(map[string]string),
		PendingLeaves:    make(map[string]string),
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
	_ []runtime.MatchData,
) interface{} {
	state, ok := rawState.(*persistentLobbyState)
	if !ok || state == nil {
		return nil
	}
	if state.Snapshot.Closed {
		return nil
	}
	if len(state.PendingLeaves) == 0 {
		return state
	}
	closed, err := m.flushPendingLeaves(ctx, state)
	if err != nil {
		logger.Error("retry persistent lobby departures: %v", err)
		return state
	}
	if closed {
		return nil
	}
	m.broadcastState(logger, dispatcher, state)
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
		state.Snapshot = snapshot
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: snapshot})
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
		state.Snapshot = snapshot
		kickPlayerPresences(dispatcher, state, signal.PlayerID)
		if closed {
			// Let the signal response reach the caller before MatchLoop terminates the now-closed
			// authoritative match on its next tick.
			return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: snapshot})
		}
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: snapshot})
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
		state.Snapshot = snapshot
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{Lobby: snapshot})
	case "start":
		if signal.Start == nil || signal.Start.LobbyID != state.LobbyID {
			return state, encodeLobbySignalError(
				newLobbyProblem(grpcInvalidArgument, "invalid lobby start signal"),
			)
		}
		snapshot, err := m.store.AcceptStart(ctx, signal.PlayerID, *signal.Start)
		if err != nil {
			return state, encodeLobbySignalError(err)
		}
		state.Snapshot = snapshot
		m.broadcastState(logger, dispatcher, state)
		return state, encodeLobbySignalResponse(lobbyRPCResponse{
			Lobby:         snapshot,
			StartAccepted: true,
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
	state.Snapshot = snapshot
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
	state.Snapshot = snapshot
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
