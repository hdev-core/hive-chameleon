package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"
)

const (
	answerCheckDuration       = 15 * time.Second
	liveScoreBatchInterval    = 30 * time.Second
	maximumLikeCommands       = 64
	maximumAnswerCheckPayload = 1024
)

type answerCheckLikeCommand struct {
	CommandID           string `json:"command_id"`
	TargetHiderPlayerID string `json:"target_hider_player_id"`
}

type answerCheckLikeResult struct {
	RoundID             string `json:"round_id"`
	CommandID           string `json:"command_id"`
	Accepted            bool   `json:"accepted"`
	Reason              string `json:"reason"`
	TargetHiderPlayerID string `json:"target_hider_player_id,omitempty"`
}

type roundLikeSnapshot struct {
	VoterPlayerID       string    `json:"voter_player_id"`
	TargetHiderPlayerID string    `json:"target_hider_player_id"`
	CreatedAt           time.Time `json:"created_at"`
}

type answerCheckReveal struct {
	PlayerID             string     `json:"player_id"`
	DisplayName          string     `json:"display_name,omitempty"`
	Role                 string     `json:"role"`
	Status               string     `json:"status"`
	Cue                  string     `json:"cue"`
	Found                bool       `json:"found"`
	AvatarStateAvailable bool       `json:"avatar_state_available"`
	PositionX            float64    `json:"position_x"`
	PositionY            float64    `json:"position_y"`
	PositionZ            float64    `json:"position_z"`
	Yaw                  float64    `json:"yaw"`
	BodyR                float64    `json:"body_r"`
	BodyG                float64    `json:"body_g"`
	BodyB                float64    `json:"body_b"`
	AccentR              float64    `json:"accent_r"`
	AccentG              float64    `json:"accent_g"`
	AccentB              float64    `json:"accent_b"`
	Pose                 string     `json:"pose"`
	AvatarSequence       uint64     `json:"avatar_sequence"`
	AvatarOccurredAt     *time.Time `json:"avatar_occurred_at,omitempty"`
}

type answerCheckSnapshot struct {
	RoundID      string              `json:"round_id"`
	Mode         string              `json:"mode"`
	WinningSide  string              `json:"winning_side"`
	Deadline     time.Time           `json:"deadline"`
	Reveals      []answerCheckReveal `json:"reveals"`
	LikeCount    int                 `json:"like_count"`
	ScoringRules string              `json:"scoring_rules"`
}

type roundScoreEntry struct {
	PlayerID    string          `json:"player_id"`
	DisplayName string          `json:"display_name,omitempty"`
	Rank        int             `json:"rank"`
	Total       string          `json:"total"`
	Outcome     string          `json:"outcome"`
	Breakdown   json.RawMessage `json:"breakdown"`
}

type roundScoreSnapshot struct {
	RoundID            string            `json:"round_id"`
	Phase              string            `json:"phase"`
	Final              bool              `json:"final"`
	BatchSequence      uint64            `json:"batch_sequence"`
	ScoringRuleVersion string            `json:"scoring_rule_version"`
	ComputedAt         time.Time         `json:"computed_at"`
	Entries            []roundScoreEntry `json:"entries"`
}

type spectatorStateSnapshot struct {
	RoundID               string                 `json:"round_id"`
	Phase                 string                 `json:"phase"`
	Eligible              bool                   `json:"eligible"`
	Reason                string                 `json:"reason"`
	CameraModes           []string               `json:"camera_modes"`
	VisibleHiderPlayerIDs []string               `json:"visible_hider_player_ids"`
	VisiblePlayerNameIDs  []string               `json:"visible_player_name_ids"`
	Players               []spectatorPlayerState `json:"players"`
}

type spectatorPlayerState struct {
	PlayerID    string `json:"player_id"`
	DisplayName string `json:"display_name,omitempty"`
	Role        string `json:"role"`
	Status      string `json:"status"`
}

type authoritativeScore struct {
	Total     string
	Outcome   string
	Breakdown json.RawMessage
}

func (s *authoritativeRoundState) BeginAnswerCheck(
	winningSide string,
	reason string,
	outcomeAt time.Time,
) {
	s.complete(winningSide, reason, outcomeAt)
	s.PhaseDeadline = s.TerminalAt.Add(answerCheckDuration)
}

func (s *authoritativeRoundState) ReadyToCommit(now time.Time) bool {
	return s.Phase == "answer_check" &&
		!s.PhaseDeadline.IsZero() &&
		!now.Before(s.PhaseDeadline)
}

func (s *authoritativeRoundState) HandleLike(
	playerID string,
	command answerCheckLikeCommand,
	now time.Time,
) answerCheckLikeResult {
	result := answerCheckLikeResult{
		RoundID:             s.RoundID,
		CommandID:           command.CommandID,
		Reason:              "invalid_command",
		TargetHiderPlayerID: command.TargetHiderPlayerID,
	}
	commands := s.LikeCommands[playerID]
	if previous, exists := commands[command.CommandID]; exists {
		return previous
	}
	if commands == nil {
		commands = make(map[string]answerCheckLikeResult)
		s.LikeCommands[playerID] = commands
	}
	if len(commands) >= maximumLikeCommands {
		result.Reason = "command_limit_reached"
		return result
	}
	if s.Phase != "answer_check" || !now.Before(s.PhaseDeadline) {
		result.Reason = "answer_check_closed"
		commands[command.CommandID] = result
		return result
	}
	voter, eligible := s.Assignments[playerID]
	if !eligible {
		result.Reason = "not_eligible"
		commands[command.CommandID] = result
		return result
	}
	target, targetExists := s.Assignments[command.TargetHiderPlayerID]
	if !targetExists || target.Role != "hider" {
		result.Reason = "target_not_hider"
		commands[command.CommandID] = result
		return result
	}
	if voter.PlayerID == target.PlayerID {
		result.Reason = "cannot_like_self"
		commands[command.CommandID] = result
		return result
	}
	if existing, alreadyLiked := s.Likes[playerID]; alreadyLiked {
		result.Reason = "already_liked"
		result.TargetHiderPlayerID = existing.TargetHiderPlayerID
		commands[command.CommandID] = result
		return result
	}

	s.Likes[playerID] = roundLikeSnapshot{
		VoterPlayerID:       playerID,
		TargetHiderPlayerID: command.TargetHiderPlayerID,
		CreatedAt:           now.UTC(),
	}
	result.Accepted = true
	result.Reason = "accepted"
	commands[command.CommandID] = result
	return result
}

func (s *authoritativeRoundState) AnswerCheck(
	avatarStates map[string]roundAvatarStateSnapshot,
) answerCheckSnapshot {
	playerIDs := sortedPlayerIDs(s.Assignments)
	reveals := make([]answerCheckReveal, 0, len(s.Hiders))
	for _, playerID := range playerIDs {
		assignment := s.Assignments[playerID]
		if assignment.Role != "hider" {
			continue
		}
		_, found := s.FoundHiders[playerID]
		cue := "survived"
		if found && s.Mode == "infection" {
			cue = "converted"
		} else if found {
			cue = "found"
		}
		playerState, _ := s.PlayerState(playerID)
		reveal := answerCheckReveal{
			PlayerID:    playerID,
			DisplayName: assignment.DisplayName,
			Role:        playerState.Role,
			Status:      playerState.Status,
			Cue:         cue,
			Found:       found,
		}
		if avatar, available := avatarStates[playerID]; available &&
			avatar.RoundID == s.RoundID &&
			avatar.PlayerID == playerID &&
			avatar.Sequence > 0 {
			occurredAt := avatar.OccurredAt.UTC()
			reveal.AvatarStateAvailable = true
			reveal.PositionX = avatar.PositionX
			reveal.PositionY = avatar.PositionY
			reveal.PositionZ = avatar.PositionZ
			reveal.Yaw = avatar.Yaw
			reveal.BodyR = avatar.BodyR
			reveal.BodyG = avatar.BodyG
			reveal.BodyB = avatar.BodyB
			reveal.AccentR = avatar.AccentR
			reveal.AccentG = avatar.AccentG
			reveal.AccentB = avatar.AccentB
			reveal.Pose = avatar.Pose
			reveal.AvatarSequence = avatar.Sequence
			reveal.AvatarOccurredAt = &occurredAt
		}
		reveals = append(reveals, reveal)
	}
	return answerCheckSnapshot{
		RoundID:      s.RoundID,
		Mode:         s.Mode,
		WinningSide:  s.WinningSide,
		Deadline:     s.PhaseDeadline,
		Reveals:      reveals,
		LikeCount:    len(s.Likes),
		ScoringRules: scoringRuleVersion,
	}
}

func (s *authoritativeRoundState) SpectatorState(
	playerID string,
) spectatorStateSnapshot {
	snapshot := spectatorStateSnapshot{
		RoundID:               s.RoundID,
		Phase:                 s.Phase,
		CameraModes:           make([]string, 0),
		VisibleHiderPlayerIDs: make([]string, 0),
		VisiblePlayerNameIDs:  make([]string, 0),
		Players:               make([]spectatorPlayerState, 0),
	}
	assignment, participant := s.Assignments[playerID]
	switch {
	case s.Phase == "completed":
		snapshot.Eligible = true
		snapshot.Reason = "round_terminal"
	case !participant:
		snapshot.Eligible = true
		snapshot.Reason = "joined_in_progress"
	case s.Phase == "answer_check" && assignment.Role == "hider":
		snapshot.Eligible = true
		snapshot.Reason = "answer_check_hider"
	case s.Phase == "answer_check" && assignment.Role == "hunter":
		snapshot.Reason = "answer_check_hunter"
	case s.Mode == "casual" && assignment.Role == "hider":
		if _, found := s.FoundHiders[playerID]; found {
			snapshot.Eligible = true
			snapshot.Reason = "found_hider"
		}
	}
	if !snapshot.Eligible {
		if snapshot.Reason == "" {
			snapshot.Reason = "active_participant"
		}
		return snapshot
	}
	snapshot.CameraModes = []string{"first_person", "third_person", "free"}
	for playerID := range s.Assignments {
		playerState, available := s.PlayerState(playerID)
		if !available {
			continue
		}
		snapshot.VisiblePlayerNameIDs = append(
			snapshot.VisiblePlayerNameIDs,
			playerID,
		)
		if playerState.Role == "hider" {
			snapshot.VisibleHiderPlayerIDs = append(
				snapshot.VisibleHiderPlayerIDs,
				playerID,
			)
		}
		snapshot.Players = append(snapshot.Players, spectatorPlayerState{
			PlayerID:    playerID,
			DisplayName: s.Assignments[playerID].DisplayName,
			Role:        playerState.Role,
			Status:      playerState.Status,
		})
	}
	sort.Strings(snapshot.VisiblePlayerNameIDs)
	sort.Strings(snapshot.VisibleHiderPlayerIDs)
	sort.Slice(snapshot.Players, func(left, right int) bool {
		return snapshot.Players[left].PlayerID < snapshot.Players[right].PlayerID
	})
	return snapshot
}

func (s *authoritativeRoundState) ScoreSnapshot(
	round *roundSnapshot,
	computedAt time.Time,
) (roundScoreSnapshot, error) {
	return s.scoreSnapshot(round, computedAt, true)
}

func (s *authoritativeRoundState) ProvisionalScoreSnapshot(
	round *roundSnapshot,
	computedAt time.Time,
) (roundScoreSnapshot, error) {
	return s.scoreSnapshot(round, computedAt, false)
}

func (s *authoritativeRoundState) scoreSnapshot(
	round *roundSnapshot,
	computedAt time.Time,
	final bool,
) (roundScoreSnapshot, error) {
	playerIDs := sortedPlayerIDs(s.Assignments)
	entries := make([]roundScoreEntry, 0, len(playerIDs))
	for _, playerID := range playerIDs {
		assignment := s.Assignments[playerID]
		if assignment.Role != "hider" {
			continue
		}
		score, err := s.scoreAt(round, playerID, computedAt, final)
		if err != nil {
			return roundScoreSnapshot{}, err
		}
		entries = append(entries, roundScoreEntry{
			PlayerID:    playerID,
			DisplayName: assignment.DisplayName,
			Total:       score.Total,
			Outcome:     score.Outcome,
			Breakdown:   score.Breakdown,
		})
	}
	sort.Slice(entries, func(left, right int) bool {
		leftScore := parseWholeFixedScore(entries[left].Total)
		rightScore := parseWholeFixedScore(entries[right].Total)
		if leftScore != rightScore {
			return leftScore > rightScore
		}
		return entries[left].PlayerID < entries[right].PlayerID
	})
	for index := range entries {
		entries[index].Rank = index + 1
	}
	return roundScoreSnapshot{
		RoundID:            s.RoundID,
		Phase:              s.Phase,
		Final:              final,
		ScoringRuleVersion: scoringRuleVersion,
		ComputedAt:         computedAt.UTC(),
		Entries:            entries,
	}, nil
}

func (s *authoritativeRoundState) Score(
	round *roundSnapshot,
	playerID string,
) (authoritativeScore, error) {
	return s.scoreAt(round, playerID, s.TerminalAt, true)
}

func (s *authoritativeRoundState) scoreAt(
	round *roundSnapshot,
	playerID string,
	computedAt time.Time,
	final bool,
) (authoritativeScore, error) {
	if round == nil || round.ID != s.RoundID {
		return authoritativeScore{}, errors.New("matching round is required for scoring")
	}
	assignment, exists := s.Assignments[playerID]
	if !exists {
		return authoritativeScore{}, errors.New("round participant is required for scoring")
	}
	_, found := s.FoundHiders[playerID]
	outcome := "in_progress"
	if final {
		var err error
		outcome, err = authoritativeParticipantOutcome(
			s.Mode,
			assignment.Role,
			found,
			s.WinningSide,
		)
		if err != nil {
			return authoritativeScore{}, err
		}
	}

	huntStartedAt := round.StartedAt.
		Add(casualPreparingDuration).
		Add(time.Duration(round.HidingDurationSeconds) * time.Second)
	huntEndedAt := s.TerminalAt
	if !final {
		huntEndedAt = computedAt.UTC()
		scheduledEnd := huntStartedAt.
			Add(time.Duration(round.HuntingDurationSeconds) * time.Second)
		if huntEndedAt.After(scheduledEnd) {
			huntEndedAt = scheduledEnd
		}
	}
	if huntEndedAt.Before(huntStartedAt) {
		huntEndedAt = huntStartedAt
	}
	survivalPoints := 0
	survivalBonus := 0
	infectionFinalBonus := 0
	discoveryPoints := 0
	speedPoints := 0
	hunterWinBonus := 0
	likePoints := 0

	if assignment.Role == "hider" {
		survivalEnd := huntEndedAt
		if discovery, wasFound := s.FoundHiders[playerID]; wasFound {
			survivalEnd = discovery.OccurredAt
		}
		if survivalEnd.Before(huntStartedAt) {
			survivalEnd = huntStartedAt
		}
		survivalPoints = int(survivalEnd.Sub(huntStartedAt).Seconds()) * 10
		if final && !found && s.WinningSide == "hiders" {
			survivalBonus = 500
			if s.Mode == "infection" &&
				len(s.Hiders)-len(s.FoundHiders) == 1 {
				infectionFinalBonus = 250
			}
		}
	}
	for _, discovery := range s.Discoveries {
		if discovery.HunterPlayerID != playerID {
			continue
		}
		discoveryPoints += 300
		elapsed := discovery.OccurredAt.Sub(huntStartedAt)
		remaining := time.Duration(round.HuntingDurationSeconds)*time.Second -
			elapsed
		if remaining > 0 {
			bonus := int(remaining.Seconds()) * 2
			if bonus > 300 {
				bonus = 300
			}
			speedPoints += bonus
		}
	}
	if final &&
		s.CurrentRoles[playerID] == "hunter" &&
		s.WinningSide == "hunters" {
		hunterWinBonus = 400
	}
	if final {
		for _, like := range s.Likes {
			if like.TargetHiderPlayerID == playerID {
				likePoints += 100
			}
		}
	}
	total := survivalPoints +
		survivalBonus +
		infectionFinalBonus +
		discoveryPoints +
		speedPoints +
		hunterWinBonus +
		likePoints
	breakdown, err := json.Marshal(struct {
		Rule                   string `json:"rule"`
		Survival               int    `json:"survival"`
		SurvivedTimeout        int    `json:"survived_timeout"`
		InfectionFinalSurvivor int    `json:"infection_final_survivor"`
		Discoveries            int    `json:"discoveries"`
		DiscoverySpeed         int    `json:"discovery_speed"`
		HunterWin              int    `json:"hunter_win"`
		DisguiseLikes          int    `json:"disguise_likes"`
		Total                  int    `json:"total"`
	}{
		Rule:                   scoringRuleVersion,
		Survival:               survivalPoints,
		SurvivedTimeout:        survivalBonus,
		InfectionFinalSurvivor: infectionFinalBonus,
		Discoveries:            discoveryPoints,
		DiscoverySpeed:         speedPoints,
		HunterWin:              hunterWinBonus,
		DisguiseLikes:          likePoints,
		Total:                  total,
	})
	if err != nil {
		return authoritativeScore{}, fmt.Errorf("encode score breakdown: %w", err)
	}
	return authoritativeScore{
		Total:     fmt.Sprintf("%d.0000", total),
		Outcome:   outcome,
		Breakdown: breakdown,
	}, nil
}

func (s *persistentLobbyState) resetScoreCache() {
	s.CachedScore = nil
	s.NextScoreBatchAt = time.Time{}
	s.ScoreBatchSequence = 0
	s.markLiveRoundDirty()
}

func (s *persistentLobbyState) initializeScoreCache(
	computedAt time.Time,
) (roundScoreSnapshot, error) {
	s.resetScoreCache()
	snapshot, err := s.cacheProvisionalScore(computedAt)
	if err != nil {
		return roundScoreSnapshot{}, err
	}
	s.NextScoreBatchAt = computedAt.UTC().Add(liveScoreBatchInterval)
	return snapshot, nil
}

func (s *persistentLobbyState) scoreBatchDue(now time.Time) bool {
	if s == nil ||
		s.Round == nil ||
		s.AuthoritativeRound == nil ||
		(s.AuthoritativeRound.Phase != "preparing" &&
			s.AuthoritativeRound.Phase != "hiding" &&
			s.AuthoritativeRound.Phase != "hunting") {
		return false
	}
	return s.NextScoreBatchAt.IsZero() || !now.Before(s.NextScoreBatchAt)
}

func (s *persistentLobbyState) refreshProvisionalScore(
	computedAt time.Time,
) (roundScoreSnapshot, error) {
	snapshot, err := s.cacheProvisionalScore(computedAt)
	if err != nil {
		return roundScoreSnapshot{}, err
	}
	if s.NextScoreBatchAt.IsZero() {
		s.NextScoreBatchAt = computedAt.UTC().Add(liveScoreBatchInterval)
	} else {
		for !s.NextScoreBatchAt.After(computedAt) {
			s.NextScoreBatchAt = s.NextScoreBatchAt.Add(liveScoreBatchInterval)
		}
	}
	return snapshot, nil
}

func (s *persistentLobbyState) cacheProvisionalScore(
	computedAt time.Time,
) (roundScoreSnapshot, error) {
	if s == nil || s.Round == nil || s.AuthoritativeRound == nil {
		return roundScoreSnapshot{}, errors.New("active round score state is required")
	}
	snapshot, err := s.AuthoritativeRound.ProvisionalScoreSnapshot(
		s.Round,
		computedAt,
	)
	if err != nil {
		return roundScoreSnapshot{}, err
	}
	s.ScoreBatchSequence++
	snapshot.BatchSequence = s.ScoreBatchSequence
	s.CachedScore = &snapshot
	s.markLiveRoundDirty()
	return snapshot, nil
}

func (s *persistentLobbyState) cacheFinalScore(
	snapshot roundScoreSnapshot,
) roundScoreSnapshot {
	s.ScoreBatchSequence++
	snapshot.BatchSequence = s.ScoreBatchSequence
	snapshot.Final = true
	s.CachedScore = &snapshot
	s.NextScoreBatchAt = time.Time{}
	s.markLiveRoundDirty()
	return snapshot
}

func (s *persistentLobbyState) ensureFinalScoreCache() error {
	if s == nil || s.Round == nil || s.AuthoritativeRound == nil {
		return errors.New("active round score state is required")
	}
	if s.AuthoritativeRound.Phase != "answer_check" &&
		s.AuthoritativeRound.Phase != "completed" {
		return nil
	}
	if s.CachedScore != nil && s.CachedScore.Final {
		return nil
	}
	snapshot, err := s.AuthoritativeRound.ScoreSnapshot(
		s.Round,
		s.AuthoritativeRound.TerminalAt,
	)
	if err != nil {
		return err
	}
	s.cacheFinalScore(snapshot)
	return nil
}

func decodeAnswerCheckLikeCommand(
	payload []byte,
) (answerCheckLikeCommand, error) {
	var command answerCheckLikeCommand
	if len(payload) == 0 || len(payload) > maximumAnswerCheckPayload {
		return command, errors.New("invalid Answer Check like command")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command); err != nil {
		return command, errors.New("invalid Answer Check like command")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return command, errors.New("invalid Answer Check like command")
	}
	if command.CommandID == "" ||
		len(command.CommandID) > maximumRoundCommandIDSize ||
		!roundCommandIDPattern.MatchString(command.CommandID) {
		return command, errors.New("invalid Answer Check like command")
	}
	if _, err := canonicalUUIDV7ToCompact(command.TargetHiderPlayerID); err != nil {
		return command, errors.New("invalid Answer Check like command")
	}
	return command, nil
}

func parseWholeFixedScore(value string) int {
	var whole int
	_, _ = fmt.Sscanf(value, "%d.0000", &whole)
	return whole
}
