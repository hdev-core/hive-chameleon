package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"time"
)

const (
	casualPreparingDuration   = 2 * time.Second
	maximumRoundCommandBytes  = 1024
	maximumRoundCommandIDSize = 64
	maximumPlayerIDSize       = 128
	maximumProcessedCommands  = 256
)

var roundCommandIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type hunterFireCommand struct {
	CommandID      string   `json:"command_id"`
	TargetPlayerID string   `json:"target_player_id,omitempty"`
	AimYaw         *float64 `json:"aim_yaw,omitempty"`
	AimPitch       *float64 `json:"aim_pitch,omitempty"`
}

type hunterFireResult struct {
	RoundID         string     `json:"round_id"`
	CommandID       string     `json:"command_id"`
	Accepted        bool       `json:"accepted"`
	Reason          string     `json:"reason"`
	TargetPlayerID  string     `json:"target_player_id,omitempty"`
	Hit             bool       `json:"hit"`
	HiderPlayerID   string     `json:"hider_player_id,omitempty"`
	ShellsRemaining int        `json:"shells_remaining"`
	ReloadUntil     *time.Time `json:"reload_until,omitempty"`
	RoundIsTerminal bool       `json:"round_is_terminal"`
}

type roundDiscoverySnapshot struct {
	RoundID                   string    `json:"round_id"`
	HunterPlayerID            string    `json:"hunter_player_id"`
	HiderPlayerID             string    `json:"hider_player_id"`
	Sequence                  int       `json:"sequence"`
	OccurredAt                time.Time `json:"occurred_at"`
	CausedInfectionConversion bool      `json:"caused_infection_conversion"`
}

type roundPlayerState struct {
	RoundID         string     `json:"round_id"`
	PlayerID        string     `json:"player_id"`
	DisplayName     string     `json:"display_name,omitempty"`
	InitialRole     string     `json:"initial_role"`
	Role            string     `json:"role"`
	Status          string     `json:"status"`
	ShellsRemaining int        `json:"shells_remaining"`
	ReloadUntil     *time.Time `json:"reload_until,omitempty"`
}

type casualHunterState struct {
	ShellsRemaining int
	ReloadUntil     time.Time
	Commands        map[string]hunterFireResult
}

type authoritativeRoundState struct {
	RoundID            string
	Mode               string
	Phase              string
	PhaseDeadline      time.Time
	TerminalAt         time.Time
	HidingDuration     time.Duration
	HuntingDuration    time.Duration
	ReloadDuration     time.Duration
	ShellLimit         int
	Assignments        map[string]roundRoleAssignment
	CurrentRoles       map[string]string
	Hiders             map[string]struct{}
	FoundHiders        map[string]roundDiscoverySnapshot
	Hunters            map[string]*casualHunterState
	Discoveries        []roundDiscoverySnapshot
	WinningSide        string
	CompletionReason   string
	Likes              map[string]roundLikeSnapshot
	LikeCommands       map[string]map[string]answerCheckLikeResult
	ReconnectedPlayers map[string]bool
}

func newAuthoritativeRoundState(
	round *roundSnapshot,
) (*authoritativeRoundState, error) {
	if round == nil ||
		round.ID == "" ||
		(round.Mode != "casual" && round.Mode != "infection") {
		return nil, errors.New("valid authoritative round is required")
	}
	if round.HidingDurationSeconds <= 0 ||
		round.HuntingDurationSeconds <= 0 ||
		round.ShellLimit <= 0 ||
		round.ReloadDurationMS <= 0 {
		return nil, errors.New("authoritative round rules are invalid")
	}

	state := &authoritativeRoundState{
		RoundID:            round.ID,
		Mode:               round.Mode,
		Phase:              "preparing",
		PhaseDeadline:      round.StartedAt.Add(casualPreparingDuration),
		HidingDuration:     time.Duration(round.HidingDurationSeconds) * time.Second,
		HuntingDuration:    time.Duration(round.HuntingDurationSeconds) * time.Second,
		ReloadDuration:     time.Duration(round.ReloadDurationMS) * time.Millisecond,
		ShellLimit:         round.ShellLimit,
		Assignments:        make(map[string]roundRoleAssignment, len(round.RoleAssignments)),
		CurrentRoles:       make(map[string]string, len(round.RoleAssignments)),
		Hiders:             make(map[string]struct{}),
		FoundHiders:        make(map[string]roundDiscoverySnapshot),
		Hunters:            make(map[string]*casualHunterState),
		Discoveries:        make([]roundDiscoverySnapshot, 0),
		Likes:              make(map[string]roundLikeSnapshot),
		LikeCommands:       make(map[string]map[string]answerCheckLikeResult),
		ReconnectedPlayers: make(map[string]bool),
	}
	for _, assignment := range round.RoleAssignments {
		if assignment.PlayerID == "" {
			return nil, errors.New("authoritative round assignment player is required")
		}
		if _, exists := state.Assignments[assignment.PlayerID]; exists {
			return nil, errors.New("authoritative round assignments must be unique")
		}
		state.Assignments[assignment.PlayerID] = assignment
		state.CurrentRoles[assignment.PlayerID] = assignment.Role
		switch assignment.Role {
		case "hunter":
			state.Hunters[assignment.PlayerID] = &casualHunterState{
				ShellsRemaining: round.ShellLimit,
				Commands:        make(map[string]hunterFireResult),
			}
		case "hider":
			state.Hiders[assignment.PlayerID] = struct{}{}
		default:
			return nil, errors.New("authoritative round assignment role is invalid")
		}
	}
	if len(state.Hunters) == 0 || len(state.Hiders) == 0 {
		return nil, errors.New("authoritative round requires Hunters and Hiders")
	}
	state.Apply(round)
	return state, nil
}

func (s *authoritativeRoundState) Advance(now time.Time) []string {
	phases := make([]string, 0, 2)
	for s.Phase != "answer_check" &&
		s.Phase != "completed" &&
		!now.Before(s.PhaseDeadline) {
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
			s.BeginAnswerCheck("hiders", "hunt_timeout", s.PhaseDeadline)
			phases = append(phases, s.Phase)
		default:
			s.BeginAnswerCheck("none", "invalid_phase", now)
			phases = append(phases, s.Phase)
		}
	}
	return phases
}

func (s *authoritativeRoundState) HandleFire(
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
		TargetPlayerID:  command.TargetPlayerID,
		ShellsRemaining: 0,
		RoundIsTerminal: s.Phase == "answer_check" || s.Phase == "completed",
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
		if s.Phase == "answer_check" || s.Phase == "completed" {
			result.Reason = "round_terminal"
		} else {
			result.Reason = "not_hunting"
		}
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

	hiderPlayerID := command.TargetPlayerID
	if _, isHider := s.Hiders[hiderPlayerID]; isHider {
		if _, alreadyFound := s.FoundHiders[hiderPlayerID]; !alreadyFound {
			discovery := roundDiscoverySnapshot{
				RoundID:                   s.RoundID,
				HunterPlayerID:            playerID,
				HiderPlayerID:             hiderPlayerID,
				Sequence:                  len(s.Discoveries) + 1,
				OccurredAt:                now,
				CausedInfectionConversion: s.Mode == "infection",
			}
			s.FoundHiders[hiderPlayerID] = discovery
			s.Discoveries = append(s.Discoveries, discovery)
			if s.Mode == "infection" {
				s.CurrentRoles[hiderPlayerID] = "hunter"
				s.Hunters[hiderPlayerID] = &casualHunterState{
					ShellsRemaining: s.ShellLimit,
					Commands:        make(map[string]hunterFireResult),
				}
			}
			result.Reason = "hit"
			result.Hit = true
			result.HiderPlayerID = hiderPlayerID
			if len(s.FoundHiders) == len(s.Hiders) {
				s.BeginAnswerCheck("hunters", "all_hiders_found", now)
				result.RoundIsTerminal = true
			}
			hunter.Commands[command.CommandID] = result
			return result, &discovery
		}
	}

	hunter.Commands[command.CommandID] = result
	return result, nil
}

func (s *authoritativeRoundState) PlayerState(
	playerID string,
) (roundPlayerState, bool) {
	assignment, exists := s.Assignments[playerID]
	if !exists {
		return roundPlayerState{}, false
	}
	status := "active"
	if _, found := s.FoundHiders[playerID]; found {
		if s.Mode == "infection" {
			status = "converted"
		} else {
			status = "found"
		}
	}
	state := roundPlayerState{
		RoundID:     s.RoundID,
		PlayerID:    playerID,
		DisplayName: assignment.DisplayName,
		InitialRole: assignment.Role,
		Role:        s.CurrentRoles[playerID],
		Status:      status,
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

func (s *authoritativeRoundState) Apply(round *roundSnapshot) {
	if round == nil {
		return
	}
	round.Status = s.Phase
	round.HidersTotal = len(s.Hiders)
	round.HidersRemaining = len(s.Hiders) - len(s.FoundHiders)
	round.WinningSide = s.WinningSide
	round.CompletionReason = s.CompletionReason
	round.DiscoveredHiderPlayerIDs = make([]string, 0, len(s.Discoveries))
	for _, discovery := range s.Discoveries {
		round.DiscoveredHiderPlayerIDs = append(
			round.DiscoveredHiderPlayerIDs,
			discovery.HiderPlayerID,
		)
	}
	if s.Phase == "completed" {
		round.PhaseDeadline = nil
		round.EndedAt = s.PhaseDeadline
		return
	}
	deadline := s.PhaseDeadline
	round.PhaseDeadline = &deadline
}

func (s *authoritativeRoundState) complete(
	winningSide string,
	reason string,
	terminalAt time.Time,
) {
	s.Phase = "answer_check"
	s.PhaseDeadline = time.Time{}
	s.TerminalAt = terminalAt.UTC()
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
		len(command.TargetPlayerID) > maximumPlayerIDSize ||
		(command.TargetPlayerID != "" &&
			!roundCommandIDPattern.MatchString(command.TargetPlayerID)) {
		return command, errors.New("invalid Hunter fire command")
	}
	if (command.AimYaw == nil) != (command.AimPitch == nil) {
		return command, errors.New("invalid Hunter fire command")
	}
	if command.AimYaw != nil {
		if !finiteNumber(*command.AimYaw) ||
			!validAvatarPitch(*command.AimPitch) {
			return command, errors.New("invalid Hunter fire command")
		}
		normalizedYaw := normalizeAvatarYaw(*command.AimYaw)
		command.AimYaw = &normalizedYaw
	}
	return command, nil
}

func sortedPlayerIDs(values map[string]roundRoleAssignment) []string {
	playerIDs := make([]string, 0, len(values))
	for playerID := range values {
		playerIDs = append(playerIDs, playerID)
	}
	sort.Strings(playerIDs)
	return playerIDs
}
