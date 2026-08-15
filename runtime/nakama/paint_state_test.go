package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

type paintDispatchRecord struct {
	opCode     int64
	data       []byte
	recipients []runtime.Presence
}

type paintTestDispatcher struct {
	records []paintDispatchRecord
}

func (d *paintTestDispatcher) BroadcastMessage(
	opCode int64,
	data []byte,
	presences []runtime.Presence,
	_ runtime.Presence,
	_ bool,
) error {
	d.records = append(d.records, paintDispatchRecord{
		opCode:     opCode,
		data:       append([]byte(nil), data...),
		recipients: append([]runtime.Presence(nil), presences...),
	})
	return nil
}

func (d *paintTestDispatcher) BroadcastMessageDeferred(
	opCode int64,
	data []byte,
	presences []runtime.Presence,
	sender runtime.Presence,
	reliable bool,
) error {
	return d.BroadcastMessage(opCode, data, presences, sender, reliable)
}

func (d *paintTestDispatcher) MatchKick([]runtime.Presence) error { return nil }
func (d *paintTestDispatcher) MatchLabelUpdate(string) error      { return nil }

func validPaintCommand(sequence uint64) paintStrokeCommand {
	return paintStrokeCommand{
		BodyID:     "standard-humanoid-v1",
		RendererID: "body.chest",
		Points: []paintPoint{
			{U: 0.25, V: 0.4},
			{U: 0.3, V: 0.42},
		},
		Radius:   0.045,
		Hardness: 1,
		Opacity:  0.5,
		Material: paintMaterial{
			BaseR:             0.2,
			BaseG:             0.4,
			BaseB:             0.6,
			Metallic:          0.1,
			Roughness:         0.8,
			EmissionR:         0.2,
			EmissionG:         0.1,
			EmissionB:         0,
			EmissionIntensity: 1.5,
		},
		Channels:       15,
		ClientSequence: sequence,
		ClientTick:     100,
	}
}

func TestPaintStrokeValidationRejectsUnknownBodySurfaceAndBadValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*paintStrokeCommand)
	}{
		{"unknown body", func(command *paintStrokeCommand) { command.BodyID = "unknown-v1" }},
		{"unknown surface", func(command *paintStrokeCommand) { command.RendererID = "body.secret" }},
		{"outside uv", func(command *paintStrokeCommand) { command.Points[0].U = 1.01 }},
		{"too many points", func(command *paintStrokeCommand) {
			command.Points = make([]paintPoint, maximumPaintPointsPerStroke+1)
		}},
		{"oversized radius", func(command *paintStrokeCommand) { command.Radius = 0.26 }},
		{"invalid channels", func(command *paintStrokeCommand) { command.Channels = 16 }},
		{"bright emission", func(command *paintStrokeCommand) { command.Material.EmissionIntensity = 9 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command := validPaintCommand(1)
			test.mutate(&command)
			if err := validatePaintStrokeCommand(command); err == nil {
				t.Fatalf("accepted invalid paint command: %#v", command)
			}
		})
	}
}

func TestPaintStrokeIsOwnedPhaseLimitedAndOrdered(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintStates:        initializeRoundPaintStates(authoritative),
	}
	var hiderID string
	var hunterID string
	for playerID, assignment := range authoritative.Assignments {
		if assignment.Role == "hider" {
			hiderID = playerID
		} else {
			hunterID = playerID
		}
	}
	now := round.StartedAt.Add(time.Second)
	first, err := state.applyPaintStroke(hiderID, validPaintCommand(4), now)
	if err != nil || first.Sequence != 1 || first.ClientSequence != 4 {
		t.Fatalf("valid Hider stroke was rejected: %#v, %v", first, err)
	}
	second, err := state.applyPaintStroke(hiderID, validPaintCommand(7), now.Add(time.Millisecond))
	if err != nil || second.Sequence != 2 || second.ClientSequence != 7 {
		t.Fatalf("sequence recovery gap was rejected: %#v, %v", second, err)
	}
	if _, err := state.applyPaintStroke(hiderID, validPaintCommand(7), now); err == nil {
		t.Fatal("accepted a replayed client sequence")
	}
	if _, err := state.applyPaintStroke(hunterID, validPaintCommand(1), now); err == nil {
		t.Fatal("accepted Hunter paint ownership")
	}
	authoritative.Phase = "hunting"
	if _, err := state.applyPaintStroke(hiderID, validPaintCommand(8), now); err == nil {
		t.Fatal("accepted paint after the hiding window")
	}
}

func TestPaintStrokeRateAndBudgetAreBounded(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintStates:        initializeRoundPaintStates(authoritative),
	}
	var hiderID string
	for playerID, assignment := range authoritative.Assignments {
		if assignment.Role == "hider" {
			hiderID = playerID
			break
		}
	}
	now := round.StartedAt.Add(time.Second)
	for index := 1; index <= maximumPaintStrokesPerSecond; index++ {
		if _, err := state.applyPaintStroke(hiderID, validPaintCommand(uint64(index)), now); err != nil {
			t.Fatalf("stroke %d inside rate budget failed: %v", index, err)
		}
	}
	if _, err := state.applyPaintStroke(
		hiderID,
		validPaintCommand(maximumPaintStrokesPerSecond+1),
		now,
	); err == nil {
		t.Fatal("accepted a stroke above the rate budget")
	}
}

func TestPaintPointBudgetBoundsLargeCommands(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintStates:        initializeRoundPaintStates(authoritative),
	}
	command := validPaintCommand(1)
	command.Points = make([]paintPoint, maximumPaintPointsPerStroke)
	for index := range command.Points {
		command.Points[index] = paintPoint{U: 0.5, V: 0.5}
	}
	for index := 1; index <= maximumPaintPointsPerPlayer/maximumPaintPointsPerStroke; index++ {
		command.ClientSequence = uint64(index)
		now := round.StartedAt.Add(time.Duration(index) * paintStrokeWindow)
		if _, err := state.applyPaintStroke("hider", command, now); err != nil {
			t.Fatalf("stroke %d inside point budget failed: %v", index, err)
		}
	}
	command.ClientSequence++
	if _, err := state.applyPaintStroke(
		"hider",
		command,
		round.StartedAt.Add(100*paintStrokeWindow),
	); err == nil {
		t.Fatal("accepted paint above the round point budget")
	}
	payload, err := encodeLiveRoundCheckpoint(state)
	if err != nil {
		t.Fatalf("encode maximum-point checkpoint: %v", err)
	}
	if len(payload) >= maximumLiveRoundCheckpointBytes {
		t.Fatalf("paint checkpoint is %d bytes; cap is %d", len(payload), maximumLiveRoundCheckpointBytes)
	}
}

func TestPaintReplayIsBatchedAndPacedPerTick(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	owner := testPresence{sessionID: "hider-session"}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintStates:        initializeRoundPaintStates(authoritative),
		PaintReplayQueues:  make(map[string]*paintReplayQueue),
		Presences: map[string]lobbyPresence{
			owner.GetSessionId(): {PlayerID: "hider", Presence: owner},
		},
	}
	paintState := state.PaintStates["hider"]
	for index := 1; index <= 23; index++ {
		command := validPaintCommand(uint64(index))
		snapshot := paintStrokeSnapshot{
			RoundID:        round.ID,
			PlayerID:       "hider",
			BodyID:         command.BodyID,
			RendererID:     command.RendererID,
			Points:         command.Points,
			Radius:         command.Radius,
			Hardness:       command.Hardness,
			Opacity:        command.Opacity,
			Material:       command.Material,
			Channels:       command.Channels,
			Sequence:       uint64(index),
			ClientSequence: uint64(index),
			ClientTick:     command.ClientTick,
			OccurredAt:     round.StartedAt.Add(time.Duration(index) * time.Millisecond),
		}
		paintState.Strokes = append(paintState.Strokes, snapshot)
	}

	match := &persistentLobbyMatch{}
	dispatcher := &paintTestDispatcher{}
	match.queuePaintStateReplays(state, []runtime.Presence{owner})
	match.broadcastNextPaintReplays(nil, dispatcher, state, 0)
	match.broadcastNextPaintReplays(nil, dispatcher, state, 0)
	if len(dispatcher.records) != 1 {
		t.Fatalf("same tick emitted %d paint messages; want one", len(dispatcher.records))
	}
	for tick := 1; tick < 3; tick++ {
		before := len(dispatcher.records)
		match.broadcastNextPaintReplays(nil, dispatcher, state, int64(tick))
		if len(dispatcher.records) != before+1 {
			t.Fatalf("tick %d emitted %d paint messages; want exactly one", tick, len(dispatcher.records)-before)
		}
		record := dispatcher.records[len(dispatcher.records)-1]
		if record.opCode != paintStrokeBatchOpcode || len(record.recipients) != 1 {
			t.Fatalf("unexpected replay record: %#v", record)
		}
		var batch paintStrokeBatch
		if err := json.Unmarshal(record.data, &batch); err != nil {
			t.Fatalf("decode replay batch: %v", err)
		}
		want := maximumPaintReplayBatchSize
		if tick == 2 {
			want = 3
		}
		if len(batch.Strokes) != want {
			t.Fatalf("tick %d sent %d strokes; want %d", tick, len(batch.Strokes), want)
		}
	}
	if len(state.PaintReplayQueues) != 0 {
		t.Fatal("completed paint replay queue was retained")
	}
}

func TestLivePaintAcknowledgesOwnerAndQueuesPeer(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	owner := testPresence{sessionID: "owner-session"}
	peer := testPresence{sessionID: "peer-session"}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintReplayQueues:  make(map[string]*paintReplayQueue),
		Presences: map[string]lobbyPresence{
			owner.GetSessionId(): {PlayerID: "hider", Presence: owner},
			peer.GetSessionId():  {PlayerID: "hunter", Presence: peer},
		},
	}
	authoritative.Phase = "hunting"
	command := validPaintCommand(7)
	snapshot := paintStrokeSnapshot{
		RoundID:        round.ID,
		PlayerID:       "hider",
		BodyID:         command.BodyID,
		RendererID:     command.RendererID,
		Points:         command.Points,
		Radius:         command.Radius,
		Hardness:       command.Hardness,
		Opacity:        command.Opacity,
		Material:       command.Material,
		Channels:       command.Channels,
		Sequence:       3,
		ClientSequence: command.ClientSequence,
		ClientTick:     command.ClientTick,
		OccurredAt:     round.StartedAt.Add(time.Second),
	}
	dispatcher := &paintTestDispatcher{}
	match := &persistentLobbyMatch{}
	match.broadcastPaintStroke(nil, dispatcher, state, snapshot, nil)
	if len(dispatcher.records) != 1 || dispatcher.records[0].opCode != paintStrokeSnapshotOpcode {
		t.Fatalf("owner acknowledgement was not immediate: %#v", dispatcher.records)
	}
	if len(dispatcher.records[0].recipients) != 1 ||
		dispatcher.records[0].recipients[0].GetSessionId() != owner.GetSessionId() {
		t.Fatalf("owner acknowledgement recipients are wrong: %#v", dispatcher.records[0].recipients)
	}
	peerQueue := state.PaintReplayQueues[peer.GetSessionId()]
	if peerQueue == nil || len(peerQueue.Strokes) != 1 {
		t.Fatal("peer paint update was not queued for bounded delivery")
	}
}

func TestLivePaintPreservesOwnerReplayOrder(t *testing.T) {
	t.Parallel()

	round := casualRoundFixture()
	authoritative, err := newAuthoritativeRoundState(&round)
	if err != nil {
		t.Fatalf("create Casual round: %v", err)
	}
	owner := testPresence{sessionID: "replaying-owner"}
	state := &persistentLobbyState{
		Round:              &round,
		AuthoritativeRound: authoritative,
		PaintReplayQueues: map[string]*paintReplayQueue{
			owner.GetSessionId(): {
				Strokes: []paintStrokeSnapshot{{RoundID: round.ID, PlayerID: "hider", Sequence: 1}},
			},
		},
		Presences: map[string]lobbyPresence{
			owner.GetSessionId(): {PlayerID: "hider", Presence: owner},
		},
	}
	command := validPaintCommand(9)
	snapshot := paintStrokeSnapshot{
		RoundID:        round.ID,
		PlayerID:       "hider",
		BodyID:         command.BodyID,
		RendererID:     command.RendererID,
		Points:         command.Points,
		Radius:         command.Radius,
		Hardness:       command.Hardness,
		Opacity:        command.Opacity,
		Material:       command.Material,
		Channels:       command.Channels,
		Sequence:       2,
		ClientSequence: command.ClientSequence,
		ClientTick:     command.ClientTick,
		OccurredAt:     round.StartedAt.Add(time.Second),
	}
	dispatcher := &paintTestDispatcher{}
	match := &persistentLobbyMatch{}
	match.broadcastPaintStroke(nil, dispatcher, state, snapshot, []runtime.Presence{owner})
	queue := state.PaintReplayQueues[owner.GetSessionId()]
	if queue == nil || len(queue.Strokes) != 2 || queue.Strokes[1].Sequence != 2 {
		t.Fatalf("new owner stroke did not remain behind replay history: %#v", queue)
	}
	if len(dispatcher.records) != 1 || dispatcher.records[0].opCode != paintStrokeResultOpcode {
		t.Fatalf("queued owner did not receive a private acceptance: %#v", dispatcher.records)
	}
	var result paintStrokeResult
	if err := json.Unmarshal(dispatcher.records[0].data, &result); err != nil {
		t.Fatalf("decode private acceptance: %v", err)
	}
	if !result.Accepted || result.ClientSequence != snapshot.ClientSequence {
		t.Fatalf("private acceptance is wrong: %#v", result)
	}
}
