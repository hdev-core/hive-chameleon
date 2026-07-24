package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"sort"
	"time"
)

const (
	casualPreparingDuration   = 2 * time.Second
	maximumRoundCommandBytes  = 1024
	minimumCasualTargetSlots  = 3
	maximumRoundCommandIDSize = 64
	maximumProcessedCommands  = 256
)

var roundCommandIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type hunterFireCommand struct {
	CommandID string `json:"command_id"`
	AimSlot   int    `json:"aim_slot"`
}

type hunterFireResult struct {
	RoundID         string     `json:"round_id"`
	CommandID       string     `json:"command_id"`
	Accepted        bool       `json:"accepted"`
	Reason          string     `json:"reason"`
	AimSlot         int        `json:"aim_slot"`
	Hit             bool       `json:"hit"`
	HiderPlayerID   string     `json:"hider_player_id,omitempty"`
	ShellsRemaining int        `json:"shells_remaining"`
	ReloadUntil     *time.Time `json:"reload_until,omitempty"`
	RoundIsTerminal bool       `json:"round_is_terminal"`
}

type roundDiscoverySnapshot struct {
	RoundID        string    `json:"round_id"`
	HunterPlayerID string    `json:"hunter_player_id"`
	HiderPlayerID  string    `json:"hider_player_id"`
	Sequence       int       `json:"sequence"`
	AimSlot        int       `json:"aim_slot"`
	OccurredAt     time.Time `json:"occurred_at"`
}

type roundPlayerState struct {
	RoundID         string     `json:"round_id"`
	PlayerID        string     `json:"player_id"`
	Role            string     `json:"role"`
	Status          string     `json:"status"`
	HidingSlot      int        `json:"hiding_slot,omitempty"`
	ShellsRemaining int        `json:"shells_remaining"`
	ReloadUntil     *time.Time `json:"reload_until,omitempty"`
}

type casualHunterState struct {
	ShellsRemaining int
	ReloadUntil     time.Time
	Commands        map[string]hunterFireResult
}

type casualRoundState struct {
	RoundID          string
	Phase            string
	PhaseDeadline    time.Time
	HidingDuration   time.Duration
	HuntingDuration  time.Duration
	ReloadDuration   time.Duration
	TargetSlotCount  int
	Assignments      map[string]roundRoleAssignment
	HiderBySlot      map[int]string
	FoundHiders      map[string]roundDiscoverySnapshot
	Hunters          map[string]*casualHunterState
	Discoveries      []roundDiscoverySnapshot
	WinningSide      string
	CompletionReason string
}

func assignCasualHidingSlots(
	assignments []roundRoleAssignment,
	random io.Reader,
) (int, error) {
	hiderIndexes := make([]int, 0, len(assignments))
	for index := range assignments {
		if assignments[index].Role == "hider" {
			hiderIndexes = append(hiderIndexes, index)
		}
	}
	if len(hiderIndexes) == 0 {
		return 0, errors.New("casual round requires at least one hider")
	}
	targetSlotCount := len(hiderIndexes) + 2
	if targetSlotCount < minimumCasualTargetSlots {
		targetSlotCount = minimumCasualTargetSlots
	}
	slots := make([]int, targetSlotCount)
	for index := range slots {
		slots[index] = index + 1
	}
	if err := shuffleInts(slots, random); err != nil {
		return 0, err
	}
	for index, assignmentIndex := range hiderIndexes {
		assignments[assignmentIndex].HidingSlot = slots[index]
	}
	return targetSlotCount, nil
}

func newCasualRoundState(round *roundSnapshot) (*casualRoundState, error) {
	if round == nil || round.ID == "" || round.Mode != "casual" {
		return nil, errors.New("valid Casual round is required")
	}
	if round.HidingDurationSeconds <= 0 ||
		round.HuntingDurationSeconds <= 0 ||
		round.ShellLimit <= 0 ||
		round.ReloadDurationMS <= 0 {
		return nil, errors.New("Casual round rules are invalid")
	}

	state := &casualRoundState{
		RoundID:         round.ID,
		Phase:           "preparing",
		PhaseDeadline:   round.StartedAt.Add(casualPreparingDuration),
		HidingDuration:  time.Duration(round.HidingDurationSeconds) * time.Second,
		HuntingDuration: time.Duration(round.HuntingDurationSeconds) * time.Second,
		ReloadDuration:  time.Duration(round.ReloadDurationMS) * time.Millisecond,
		TargetSlotCount: round.TargetSlotCount,
		Assignments:     make(map[string]roundRoleAssignment, len(round.RoleAssignments)),
		HiderBySlot:     make(map[int]string),
		FoundHiders:     make(map[string]roundDiscoverySnapshot),
		Hunters:         make(map[string]*casualHunterState),
		Discoveries:     make([]roundDiscoverySnapshot, 0),
	}
	for _, assignment := range round.RoleAssignments {
		if assignment.PlayerID == "" {
			return nil, errors.New("Casual round assignment player is required")
		}
		if _, exists := state.Assignments[assignment.PlayerID]; exists {
			return nil, errors.New("Casual round assignments must be unique")
		}
		state.Assignments[assignment.PlayerID] = assignment
		switch assignment.Role {
		case "hunter":
			state.Hunters[assignment.PlayerID] = &casualHunterState{
				ShellsRemaining: round.ShellLimit,
				Commands:        make(map[string]hunterFireResult),
			}
		case "hider":
			if assignment.HidingSlot < 1 || assignment.HidingSlot > round.TargetSlotCount {
				return nil, errors.New("Casual Hider slot is invalid")
			}
			if _, occupied := state.HiderBySlot[assignment.HidingSlot]; occupied {
				return nil, errors.New("Casual Hider slots must be unique")
			}
			state.HiderBySlot[assignment.HidingSlot] = assignment.PlayerID
		default:
			return nil, errors.New("Casual round assignment role is invalid")
		}
	}
	if len(state.Hunters) == 0 || len(state.HiderBySlot) == 0 {
		return nil, errors.New("Casual round requires Hunters and Hiders")
	}
	state.Apply(round)
	return state, nil
}

func (s *casualRoundState) Advance(now time.Time) []string {
	phases := make([]string, 0, 2)
	for s.Phase != "terminal" && !now.Before(s.PhaseDeadline) {
		switch s.Phase {
		case "preparing":
			s.Phase = "hiding"
			s.PhaseDeadline = s.PhaseDeadline.Add(s.HidingDuration)
			phases = append(phases, s.Phase)
		case "hiding":
			s.Phase = "hunting"
			s.PhaseDeadline = s.PhaseDeadline.Add(s.HuntingDuration)
			phases = append(phases, s.Phase)
		case "hunting":
			s.complete("hiders", "hunt_timeout")
			phases = append(phases, s.Phase)
		default:
			s.complete("none", "invalid_phase")
			phases = append(phases, s.Phase)
		}
	}
	return phases
}

func (s *casualRoundState) HandleFire(
	playerID string,
	command hunterFireCommand,
	now time.Time,
) (hunterFireResult, *roundDiscoverySnapshot) {
	hunter := s.Hunters[playerID]
	if hunter != nil {
		if previous, exists := hunter.Commands[command.CommandID]; exists {
			return previous, nil
		}
	}
	result := hunterFireResult{
		RoundID:         s.RoundID,
		CommandID:       command.CommandID,
		Reason:          "invalid_command",
		AimSlot:         command.AimSlot,
		ShellsRemaining: 0,
		RoundIsTerminal: s.Phase == "terminal",
	}
	if hunter == nil {
		result.Reason = "not_hunter"
		return result, nil
	}
	result.ShellsRemaining = hunter.ShellsRemaining
	if !hunter.ReloadUntil.IsZero() {
		reloadUntil := hunter.ReloadUntil
		result.ReloadUntil = &reloadUntil
	}
	if len(hunter.Commands) >= maximumProcessedCommands {
		result.Reason = "command_limit_reached"
		return result, nil
	}
	if s.Phase != "hunting" {
		if s.Phase == "terminal" {
			result.Reason = "round_terminal"
		} else {
			result.Reason = "not_hunting"
		}
		hunter.Commands[command.CommandID] = result
		return result, nil
	}
	if command.AimSlot < 1 || command.AimSlot > s.TargetSlotCount {
		result.Reason = "invalid_aim_slot"
		hunter.Commands[command.CommandID] = result
		return result, nil
	}
	if now.Before(hunter.ReloadUntil) {
		result.Reason = "reloading"
		hunter.Commands[command.CommandID] = result
		return result, nil
	}
	if hunter.ShellsRemaining <= 0 {
		result.Reason = "out_of_shells"
		hunter.Commands[command.CommandID] = result
		return result, nil
	}

	hunter.ShellsRemaining--
	hunter.ReloadUntil = now.Add(s.ReloadDuration)
	result.Accepted = true
	result.Reason = "miss"
	result.ShellsRemaining = hunter.ShellsRemaining
	reloadUntil := hunter.ReloadUntil
	result.ReloadUntil = &reloadUntil

	hiderPlayerID := s.HiderBySlot[command.AimSlot]
	if hiderPlayerID != "" {
		if _, alreadyFound := s.FoundHiders[hiderPlayerID]; !alreadyFound {
			discovery := roundDiscoverySnapshot{
				RoundID:        s.RoundID,
				HunterPlayerID: playerID,
				HiderPlayerID:  hiderPlayerID,
				Sequence:       len(s.Discoveries) + 1,
				AimSlot:        command.AimSlot,
				OccurredAt:     now,
			}
			s.FoundHiders[hiderPlayerID] = discovery
			s.Discoveries = append(s.Discoveries, discovery)
			result.Reason = "hit"
			result.Hit = true
			result.HiderPlayerID = hiderPlayerID
			if len(s.FoundHiders) == len(s.HiderBySlot) {
				s.complete("hunters", "all_hiders_found")
				result.RoundIsTerminal = true
			}
			hunter.Commands[command.CommandID] = result
			return result, &discovery
		}
	}

	hunter.Commands[command.CommandID] = result
	return result, nil
}

func (s *casualRoundState) PlayerState(
	playerID string,
) (roundPlayerState, bool) {
	assignment, exists := s.Assignments[playerID]
	if !exists {
		return roundPlayerState{}, false
	}
	status := "active"
	if _, found := s.FoundHiders[playerID]; found {
		status = "found"
	}
	state := roundPlayerState{
		RoundID:    s.RoundID,
		PlayerID:   playerID,
		Role:       assignment.Role,
		Status:     status,
		HidingSlot: assignment.HidingSlot,
	}
	if hunter := s.Hunters[playerID]; hunter != nil {
		state.ShellsRemaining = hunter.ShellsRemaining
		if !hunter.ReloadUntil.IsZero() {
			reloadUntil := hunter.ReloadUntil
			state.ReloadUntil = &reloadUntil
		}
	}
	return state, true
}

func (s *casualRoundState) Apply(round *roundSnapshot) {
	if round == nil {
		return
	}
	round.Status = s.Phase
	round.TargetSlotCount = s.TargetSlotCount
	round.HidersTotal = len(s.HiderBySlot)
	round.HidersRemaining = len(s.HiderBySlot) - len(s.FoundHiders)
	round.WinningSide = s.WinningSide
	round.CompletionReason = s.CompletionReason
	round.DiscoveredHiderPlayerIDs = make([]string, 0, len(s.Discoveries))
	for _, discovery := range s.Discoveries {
		round.DiscoveredHiderPlayerIDs = append(
			round.DiscoveredHiderPlayerIDs,
			discovery.HiderPlayerID,
		)
	}
	if s.Phase == "terminal" {
		round.PhaseDeadline = nil
		return
	}
	deadline := s.PhaseDeadline
	round.PhaseDeadline = &deadline
}

func (s *casualRoundState) complete(winningSide string, reason string) {
	s.Phase = "terminal"
	s.PhaseDeadline = time.Time{}
	s.WinningSide = winningSide
	s.CompletionReason = reason
}

func decodeHunterFireCommand(payload []byte) (hunterFireCommand, error) {
	var command hunterFireCommand
	if len(payload) == 0 || len(payload) > maximumRoundCommandBytes {
		return command, errors.New("invalid Hunter fire command")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		return command, errors.New("invalid Hunter fire command")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return command, errors.New("invalid Hunter fire command")
	}
	if command.CommandID == "" ||
		len(command.CommandID) > maximumRoundCommandIDSize ||
		!roundCommandIDPattern.MatchString(command.CommandID) ||
		command.AimSlot < 1 {
		return command, errors.New("invalid Hunter fire command")
	}
	return command, nil
}

func shuffleInts(values []int, random io.Reader) error {
	for index := len(values) - 1; index > 0; index-- {
		selected, err := rand.Int(random, big.NewInt(int64(index+1)))
		if err != nil {
			return fmt.Errorf("read hiding-slot randomness: %w", err)
		}
		swap := int(selected.Int64())
		values[index], values[swap] = values[swap], values[index]
	}
	return nil
}

func sortedPlayerIDs(values map[string]roundRoleAssignment) []string {
	playerIDs := make([]string, 0, len(values))
	for playerID := range values {
		playerIDs = append(playerIDs, playerID)
	}
	sort.Strings(playerIDs)
	return playerIDs
}
