package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"sort"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	paintStrokeCommandOpcode  = 16
	paintStrokeSnapshotOpcode = 17
	paintStrokeResultOpcode   = 18
	paintStrokeBatchOpcode    = 19

	maximumPaintStrokePayloadBytes = 2600
	// Unity's round-trip float JSON is base64-wrapped by the Nakama SDK. Forty points keeps
	// deliberate headroom below socket.max_message_size_bytes without changing stroke shape.
	maximumPaintPointsPerStroke  = 40
	maximumPaintPointsPerPlayer  = 4096
	maximumPaintStrokesPerPlayer = 256
	maximumPaintStrokesPerSecond = 20
	maximumPaintRendererIDLength = 56
	maximumPaintBodyIDLength     = 48
	maximumPaintReplayBatchSize  = 10
	paintStrokeWindow            = time.Second
)

var paintSemanticIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)

var paintableBodyContracts = map[string]map[string]struct{}{
	"standard-humanoid-v1": {
		"body.abdomen":            {},
		"body.chest":              {},
		"body.head":               {},
		"body.left-ankle-band":    {},
		"body.left-boot":          {},
		"body.left-calf":          {},
		"body.left-elbow":         {},
		"body.left-forearm":       {},
		"body.left-hand":          {},
		"body.left-knee":          {},
		"body.left-shoulder-cap":  {},
		"body.left-thigh":         {},
		"body.left-upper-arm":     {},
		"body.left-wrist-band":    {},
		"body.neck-shell":         {},
		"body.pelvis":             {},
		"body.right-ankle-band":   {},
		"body.right-boot":         {},
		"body.right-calf":         {},
		"body.right-elbow":        {},
		"body.right-forearm":      {},
		"body.right-hand":         {},
		"body.right-knee":         {},
		"body.right-shoulder-cap": {},
		"body.right-thigh":        {},
		"body.right-upper-arm":    {},
		"body.right-wrist-band":   {},
	},
}

type paintPoint struct {
	U float64 `json:"u"`
	V float64 `json:"v"`
}

type paintMaterial struct {
	BaseR             float64 `json:"base_r"`
	BaseG             float64 `json:"base_g"`
	BaseB             float64 `json:"base_b"`
	Metallic          float64 `json:"metallic"`
	Roughness         float64 `json:"roughness"`
	EmissionR         float64 `json:"emission_r"`
	EmissionG         float64 `json:"emission_g"`
	EmissionB         float64 `json:"emission_b"`
	EmissionIntensity float64 `json:"emission_intensity"`
}

type paintStrokeCommand struct {
	BodyID         string        `json:"body_id"`
	RendererID     string        `json:"renderer_id"`
	Points         []paintPoint  `json:"points"`
	Radius         float64       `json:"radius"`
	Hardness       float64       `json:"hardness"`
	Opacity        float64       `json:"opacity"`
	Material       paintMaterial `json:"material"`
	Channels       int           `json:"channels"`
	ClientSequence uint64        `json:"client_sequence"`
	ClientTick     int64         `json:"client_tick"`
}

type paintStrokeSnapshot struct {
	RoundID        string        `json:"round_id"`
	PlayerID       string        `json:"player_id"`
	BodyID         string        `json:"body_id"`
	RendererID     string        `json:"renderer_id"`
	Points         []paintPoint  `json:"points"`
	Radius         float64       `json:"radius"`
	Hardness       float64       `json:"hardness"`
	Opacity        float64       `json:"opacity"`
	Material       paintMaterial `json:"material"`
	Channels       int           `json:"channels"`
	Sequence       uint64        `json:"sequence"`
	ClientSequence uint64        `json:"client_sequence"`
	ClientTick     int64         `json:"client_tick"`
	OccurredAt     time.Time     `json:"occurred_at"`
}

type paintStrokeResult struct {
	RoundID        string `json:"round_id"`
	ClientSequence uint64 `json:"client_sequence"`
	Accepted       bool   `json:"accepted"`
	Reason         string `json:"reason,omitempty"`
}

type paintStrokeBatch struct {
	Strokes []paintStrokeSnapshot `json:"strokes"`
}

type paintReplayQueue struct {
	Strokes      []paintStrokeSnapshot
	Next         int
	NextSendTick int64
}

type roundPlayerPaintState struct {
	BodyID              string                `json:"body_id"`
	NextSequence        uint64                `json:"next_sequence"`
	LastClientSequence  uint64                `json:"last_client_sequence"`
	Strokes             []paintStrokeSnapshot `json:"strokes"`
	RateWindowStartedAt time.Time             `json:"rate_window_started_at"`
	RateWindowCount     int                   `json:"rate_window_count"`
}

func decodePaintStrokeCommand(payload []byte) (paintStrokeCommand, error) {
	var command paintStrokeCommand
	if len(payload) == 0 || len(payload) > maximumPaintStrokePayloadBytes {
		return command, errors.New("paint stroke payload size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		return command, errors.New("paint stroke payload is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return command, errors.New("paint stroke payload has trailing data")
	}
	return command, nil
}

func initializeRoundPaintStates(
	authoritative *authoritativeRoundState,
) map[string]*roundPlayerPaintState {
	states := make(map[string]*roundPlayerPaintState)
	if authoritative == nil {
		return states
	}
	for playerID, assignment := range authoritative.Assignments {
		if assignment.Role != "hider" {
			continue
		}
		states[playerID] = &roundPlayerPaintState{
			BodyID:       "standard-humanoid-v1",
			NextSequence: 1,
			Strokes:      make([]paintStrokeSnapshot, 0),
		}
	}
	return states
}

func (state *persistentLobbyState) applyPaintStroke(
	playerID string,
	command paintStrokeCommand,
	now time.Time,
) (paintStrokeSnapshot, error) {
	var snapshot paintStrokeSnapshot
	if state == nil || state.Round == nil || state.AuthoritativeRound == nil {
		return snapshot, errors.New("no authoritative round is active")
	}
	playerState, participant := state.AuthoritativeRound.PlayerState(playerID)
	if !participant || playerState.Role != "hider" || playerState.Status != "active" {
		return snapshot, errors.New("only an active Hider can paint its own body")
	}
	if state.AuthoritativeRound.Phase != "preparing" &&
		state.AuthoritativeRound.Phase != "hiding" {
		return snapshot, errors.New("painting is closed in the current round phase")
	}
	if err := validatePaintStrokeCommand(command); err != nil {
		return snapshot, err
	}
	paintState, exists := state.PaintStates[playerID]
	if !exists || paintState == nil {
		return snapshot, errors.New("paint state is unavailable for this player")
	}
	if command.BodyID != paintState.BodyID {
		return snapshot, errors.New("paint body identifier is not authorized")
	}
	if command.ClientSequence <= paintState.LastClientSequence {
		return snapshot, errors.New("paint command sequence is out of order")
	}
	if len(paintState.Strokes) >= maximumPaintStrokesPerPlayer {
		return snapshot, errors.New("paint stroke budget is exhausted")
	}
	pointCount := len(command.Points)
	for _, stroke := range paintState.Strokes {
		pointCount += len(stroke.Points)
	}
	if pointCount > maximumPaintPointsPerPlayer {
		return snapshot, errors.New("paint point budget is exhausted")
	}
	if paintState.RateWindowStartedAt.IsZero() ||
		!now.Before(paintState.RateWindowStartedAt.Add(paintStrokeWindow)) {
		paintState.RateWindowStartedAt = now
		paintState.RateWindowCount = 0
	}
	if paintState.RateWindowCount >= maximumPaintStrokesPerSecond {
		return snapshot, errors.New("paint stroke rate exceeded")
	}

	snapshot = paintStrokeSnapshot{
		RoundID:        state.Round.ID,
		PlayerID:       playerID,
		BodyID:         command.BodyID,
		RendererID:     command.RendererID,
		Points:         append([]paintPoint(nil), command.Points...),
		Radius:         command.Radius,
		Hardness:       command.Hardness,
		Opacity:        command.Opacity,
		Material:       command.Material,
		Channels:       command.Channels,
		Sequence:       paintState.NextSequence,
		ClientSequence: command.ClientSequence,
		ClientTick:     command.ClientTick,
		OccurredAt:     now.UTC(),
	}
	paintState.Strokes = append(paintState.Strokes, snapshot)
	paintState.NextSequence++
	paintState.LastClientSequence = command.ClientSequence
	paintState.RateWindowCount++
	return snapshot, nil
}

func validatePaintStrokeCommand(command paintStrokeCommand) error {
	if len(command.BodyID) == 0 ||
		len(command.BodyID) > maximumPaintBodyIDLength ||
		!paintSemanticIDPattern.MatchString(command.BodyID) {
		return errors.New("paint body identifier is invalid")
	}
	if len(command.RendererID) == 0 ||
		len(command.RendererID) > maximumPaintRendererIDLength ||
		!paintSemanticIDPattern.MatchString(command.RendererID) {
		return errors.New("paint renderer identifier is invalid")
	}
	contract, knownBody := paintableBodyContracts[command.BodyID]
	if !knownBody {
		return errors.New("paint body is not supported by this server build")
	}
	if _, paintable := contract[command.RendererID]; !paintable {
		return errors.New("paint renderer is not authorized for this body")
	}
	if len(command.Points) == 0 || len(command.Points) > maximumPaintPointsPerStroke {
		return errors.New("paint point count is invalid")
	}
	for _, point := range command.Points {
		if !finitePaintUnit(point.U) || !finitePaintUnit(point.V) {
			return errors.New("paint point is outside normalized UV space")
		}
	}
	if !finiteNumber(command.Radius) || command.Radius < 0.005 || command.Radius > 0.25 ||
		!finitePaintUnit(command.Hardness) ||
		!finitePaintUnit(command.Opacity) ||
		command.ClientSequence == 0 ||
		command.ClientTick < 0 {
		return errors.New("paint brush parameters are invalid")
	}
	if command.Channels <= 0 || command.Channels > 15 {
		return errors.New("paint channel mask is invalid")
	}
	material := command.Material
	if !finitePaintUnit(material.BaseR) ||
		!finitePaintUnit(material.BaseG) ||
		!finitePaintUnit(material.BaseB) ||
		!finitePaintUnit(material.Metallic) ||
		!finitePaintUnit(material.Roughness) ||
		!finitePaintUnit(material.EmissionR) ||
		!finitePaintUnit(material.EmissionG) ||
		!finitePaintUnit(material.EmissionB) ||
		!finiteNumber(material.EmissionIntensity) ||
		material.EmissionIntensity < 0 || material.EmissionIntensity > 8 {
		return errors.New("paint material parameters are invalid")
	}
	return nil
}

func finitePaintUnit(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func validateRoundPaintStates(
	states map[string]*roundPlayerPaintState,
	round *roundSnapshot,
	authoritative *authoritativeRoundState,
) error {
	if states == nil || round == nil || authoritative == nil {
		return errors.New("live round paint state is missing")
	}
	expectedHiders := 0
	for _, assignment := range authoritative.Assignments {
		if assignment.Role == "hider" {
			expectedHiders++
		}
	}
	if len(states) != expectedHiders {
		return errors.New("live round paint participant count is invalid")
	}
	for playerID, paintState := range states {
		assignment, participant := authoritative.Assignments[playerID]
		if !participant || assignment.Role != "hider" || paintState == nil ||
			len(paintState.BodyID) == 0 ||
			len(paintState.BodyID) > maximumPaintBodyIDLength ||
			!paintSemanticIDPattern.MatchString(paintState.BodyID) ||
			len(paintState.Strokes) > maximumPaintStrokesPerPlayer ||
			paintState.NextSequence != uint64(len(paintState.Strokes))+1 ||
			paintState.RateWindowCount < 0 ||
			paintState.RateWindowCount > maximumPaintStrokesPerSecond {
			return errors.New("live round player paint state is invalid")
		}
		var lastClientSequence uint64
		pointCount := 0
		for index, stroke := range paintState.Strokes {
			pointCount += len(stroke.Points)
			command := paintStrokeCommand{
				BodyID:         stroke.BodyID,
				RendererID:     stroke.RendererID,
				Points:         stroke.Points,
				Radius:         stroke.Radius,
				Hardness:       stroke.Hardness,
				Opacity:        stroke.Opacity,
				Material:       stroke.Material,
				Channels:       stroke.Channels,
				ClientSequence: stroke.ClientSequence,
				ClientTick:     stroke.ClientTick,
			}
			if stroke.RoundID != round.ID || stroke.PlayerID != playerID ||
				stroke.BodyID != paintState.BodyID ||
				stroke.Sequence != uint64(index+1) ||
				stroke.ClientSequence <= lastClientSequence ||
				stroke.OccurredAt.IsZero() ||
				validatePaintStrokeCommand(command) != nil {
				return errors.New("live round paint stroke is invalid")
			}
			lastClientSequence = stroke.ClientSequence
		}
		if paintState.LastClientSequence != lastClientSequence {
			return errors.New("live round paint client cursor is invalid")
		}
		if pointCount > maximumPaintPointsPerPlayer {
			return errors.New("live round paint point budget is invalid")
		}
	}
	return nil
}

func (m *persistentLobbyMatch) queuePaintStateReplays(
	state *persistentLobbyState,
	recipients []runtime.Presence,
) {
	if state == nil || state.AuthoritativeRound == nil {
		return
	}
	if state.PaintReplayQueues == nil {
		state.PaintReplayQueues = make(map[string]*paintReplayQueue)
	}
	if recipients == nil {
		recipients = make([]runtime.Presence, 0, len(state.Presences))
		for _, tracked := range state.Presences {
			recipients = append(recipients, tracked.Presence)
		}
	}
	playerIDs := make([]string, 0, len(state.PaintStates))
	for playerID := range state.PaintStates {
		playerIDs = append(playerIDs, playerID)
	}
	sort.Strings(playerIDs)
	for _, recipient := range recipients {
		strokes := make([]paintStrokeSnapshot, 0)
		for _, playerID := range playerIDs {
			paintState := state.PaintStates[playerID]
			if paintState == nil || !paintRecipientAllowed(state, playerID, recipient) {
				continue
			}
			strokes = append(strokes, paintState.Strokes...)
		}
		sessionID := recipient.GetSessionId()
		if len(strokes) == 0 {
			delete(state.PaintReplayQueues, sessionID)
			continue
		}
		state.PaintReplayQueues[sessionID] = &paintReplayQueue{Strokes: strokes}
	}
}

func (m *persistentLobbyMatch) broadcastNextPaintReplays(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	tick int64,
) {
	if state == nil || len(state.PaintReplayQueues) == 0 {
		return
	}
	sessions := make([]string, 0, len(state.PaintReplayQueues))
	for sessionID := range state.PaintReplayQueues {
		sessions = append(sessions, sessionID)
	}
	sort.Strings(sessions)
	for _, sessionID := range sessions {
		queue := state.PaintReplayQueues[sessionID]
		tracked, connected := state.Presences[sessionID]
		if !connected || queue == nil || queue.Next >= len(queue.Strokes) {
			delete(state.PaintReplayQueues, sessionID)
			continue
		}
		if tick < queue.NextSendTick {
			continue
		}
		end := queue.Next + maximumPaintReplayBatchSize
		if end > len(queue.Strokes) {
			end = len(queue.Strokes)
		}
		payload, err := json.Marshal(paintStrokeBatch{
			Strokes: queue.Strokes[queue.Next:end],
		})
		if err != nil {
			logger.Error("encode paint replay batch: %v", err)
			delete(state.PaintReplayQueues, sessionID)
			continue
		}
		if err := dispatcher.BroadcastMessage(
			paintStrokeBatchOpcode,
			payload,
			[]runtime.Presence{tracked.Presence},
			nil,
			true,
		); err != nil {
			logger.Error("broadcast paint replay batch: %v", err)
			continue
		}
		queue.Next = end
		queue.NextSendTick = tick + 1
		if queue.Next >= len(queue.Strokes) {
			delete(state.PaintReplayQueues, sessionID)
		}
	}
}

func (m *persistentLobbyMatch) broadcastPaintStroke(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	state *persistentLobbyState,
	snapshot paintStrokeSnapshot,
	explicitRecipients []runtime.Presence,
) {
	if state == nil {
		return
	}
	if state.PaintReplayQueues == nil {
		state.PaintReplayQueues = make(map[string]*paintReplayQueue)
	}
	recipients := explicitRecipients
	if recipients == nil {
		recipients = paintStrokeRecipients(state, snapshot.PlayerID)
	} else {
		allowed := paintStrokeRecipients(state, snapshot.PlayerID)
		allowedSessions := make(map[string]struct{}, len(allowed))
		for _, presence := range allowed {
			allowedSessions[presence.GetSessionId()] = struct{}{}
		}
		filtered := make([]runtime.Presence, 0, len(recipients))
		for _, presence := range recipients {
			if _, ok := allowedSessions[presence.GetSessionId()]; ok {
				filtered = append(filtered, presence)
			}
		}
		recipients = filtered
	}
	if len(recipients) == 0 {
		return
	}
	directOwnerRecipients := make([]runtime.Presence, 0, 1)
	queuedOwnerRecipients := make([]runtime.Presence, 0, 1)
	for _, recipient := range recipients {
		sessionID := recipient.GetSessionId()
		tracked, connected := state.Presences[sessionID]
		if connected && tracked.PlayerID == snapshot.PlayerID {
			if queue := state.PaintReplayQueues[sessionID]; queue != nil &&
				queue.Next < len(queue.Strokes) {
				queue.Strokes = append(queue.Strokes, snapshot)
				queuedOwnerRecipients = append(queuedOwnerRecipients, recipient)
			} else {
				directOwnerRecipients = append(directOwnerRecipients, recipient)
			}
			continue
		}
		queue := state.PaintReplayQueues[sessionID]
		if queue == nil {
			queue = &paintReplayQueue{}
			state.PaintReplayQueues[sessionID] = queue
		}
		queue.Strokes = append(queue.Strokes, snapshot)
	}
	if len(directOwnerRecipients) > 0 {
		payload, err := json.Marshal(snapshot)
		if err != nil {
			logger.Error("encode owner paint acknowledgement: %v", err)
			return
		}
		if err := dispatcher.BroadcastMessage(
			paintStrokeSnapshotOpcode,
			payload,
			directOwnerRecipients,
			nil,
			true,
		); err != nil {
			logger.Error("broadcast owner paint acknowledgement: %v", err)
		}
	}
	for _, recipient := range queuedOwnerRecipients {
		m.broadcastPaintResult(
			logger,
			dispatcher,
			recipient,
			paintStrokeResult{
				RoundID:        snapshot.RoundID,
				ClientSequence: snapshot.ClientSequence,
				Accepted:       true,
			},
		)
	}
}

func (m *persistentLobbyMatch) broadcastPaintResult(
	logger runtime.Logger,
	dispatcher runtime.MatchDispatcher,
	presence runtime.Presence,
	result paintStrokeResult,
) {
	payload, err := json.Marshal(result)
	if err != nil {
		logger.Error("encode paint stroke result: %v", err)
		return
	}
	if err := dispatcher.BroadcastMessage(
		paintStrokeResultOpcode,
		payload,
		[]runtime.Presence{presence},
		nil,
		true,
	); err != nil {
		logger.Error("broadcast paint stroke result: %v", err)
	}
}

func paintRecipientAllowed(
	state *persistentLobbyState,
	ownerPlayerID string,
	recipient runtime.Presence,
) bool {
	for _, allowed := range paintStrokeRecipients(state, ownerPlayerID) {
		if allowed.GetSessionId() == recipient.GetSessionId() {
			return true
		}
	}
	return false
}

func paintStrokeRecipients(
	state *persistentLobbyState,
	ownerPlayerID string,
) []runtime.Presence {
	if state == nil || state.AuthoritativeRound == nil {
		return nil
	}
	phase := state.AuthoritativeRound.Phase
	if phase == "answer_check" || phase == "completed" {
		recipients := make([]runtime.Presence, 0, len(state.Presences))
		for _, tracked := range state.Presences {
			recipients = append(recipients, tracked.Presence)
		}
		return recipients
	}
	recipients := make([]runtime.Presence, 0, len(state.Presences))
	for _, tracked := range state.Presences {
		if tracked.PlayerID == ownerPlayerID {
			recipients = append(recipients, tracked.Presence)
			continue
		}
		if state.AuthoritativeRound.SpectatorState(tracked.PlayerID).Eligible {
			recipients = append(recipients, tracked.Presence)
			continue
		}
		playerState, participant := state.AuthoritativeRound.PlayerState(tracked.PlayerID)
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
			(state.AuthoritativeRound.Mode != "infection" || playerState.Role == "hunter") {
			recipients = append(recipients, tracked.Presence)
		}
	}
	return recipients
}
