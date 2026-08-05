package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

type canonicalRoundResultDocument struct {
	Version             int                          `json:"version"`
	RoundID             string                       `json:"round_id"`
	SequenceNumber      int                          `json:"sequence_number"`
	Mode                string                       `json:"mode"`
	StartedAt           string                       `json:"started_at"`
	EndedAt             string                       `json:"ended_at"`
	WinningSide         string                       `json:"winning_side"`
	CompletionReason    string                       `json:"completion_reason"`
	ResultSchemaVersion string                       `json:"result_schema_version"`
	ScoringRuleVersion  string                       `json:"scoring_rule_version"`
	Participants        []canonicalRoundParticipant  `json:"participants"`
	Discoveries         []canonicalRoundDiscovery    `json:"discoveries"`
	Likes               []canonicalRoundDisguiseLike `json:"likes"`
}

type canonicalRoundParticipant struct {
	PlayerID           string          `json:"player_id"`
	HunterVolunteer    bool            `json:"hunter_volunteer"`
	InitialRole        string          `json:"initial_role"`
	FinalRole          string          `json:"final_role"`
	Outcome            string          `json:"outcome"`
	SurvivalDurationMS *int64          `json:"survival_duration_ms,omitempty"`
	FinalScore         string          `json:"final_score"`
	ScoreBreakdown     json.RawMessage `json:"score_breakdown"`
	FoundAt            string          `json:"found_at,omitempty"`
	Reconnected        bool            `json:"reconnected"`
}

type canonicalRoundDiscovery struct {
	HunterPlayerID            string `json:"hunter_player_id"`
	HiderPlayerID             string `json:"hider_player_id"`
	Sequence                  int    `json:"sequence"`
	OccurredAt                string `json:"occurred_at"`
	CausedInfectionConversion bool   `json:"caused_infection_conversion"`
}

type canonicalRoundDisguiseLike struct {
	VoterPlayerID       string `json:"voter_player_id"`
	TargetHiderPlayerID string `json:"target_hider_player_id"`
	CreatedAt           string `json:"created_at"`
}

type terminalRoundStore interface {
	UpdateRoundPhase(context.Context, string, string) error
	CommitTerminalResult(
		context.Context,
		terminalResultCommit,
	) (terminalResultCommitOutcome, error)
}

func buildAuthoritativeTerminalResult(
	round *roundSnapshot,
	state *authoritativeRoundState,
) (terminalResultCommit, error) {
	if round == nil || state == nil || round.ID == "" || round.ID != state.RoundID {
		return terminalResultCommit{}, errors.New("matching round state is required")
	}
	if state.Phase != "answer_check" && state.Phase != "completed" {
		return terminalResultCommit{}, errors.New("round has not reached its terminal outcome")
	}
	if state.TerminalAt.IsZero() || state.TerminalAt.Before(round.StartedAt) {
		return terminalResultCommit{}, errors.New("round terminal timestamp is invalid")
	}
	completedAt := state.PhaseDeadline
	if completedAt.IsZero() || completedAt.Before(state.TerminalAt) {
		return terminalResultCommit{}, errors.New("round completion timestamp is invalid")
	}

	playerIDs := sortedPlayerIDs(state.Assignments)
	participants := make([]terminalParticipant, 0, len(playerIDs))
	canonicalParticipants := make([]canonicalRoundParticipant, 0, len(playerIDs))
	for _, playerID := range playerIDs {
		assignment := state.Assignments[playerID]
		found, wasFound := state.FoundHiders[playerID]
		outcome, err := authoritativeParticipantOutcome(
			state.Mode,
			assignment.Role,
			wasFound,
			state.WinningSide,
		)
		if err != nil {
			return terminalResultCommit{}, err
		}
		score, err := state.Score(round, playerID)
		if err != nil {
			return terminalResultCommit{}, err
		}
		if score.Outcome != outcome {
			return terminalResultCommit{}, errors.New(
				"round score outcome is inconsistent",
			)
		}

		var foundAt *time.Time
		var foundAtText string
		if wasFound {
			value := found.OccurredAt.UTC()
			foundAt = &value
			foundAtText = value.Format(time.RFC3339Nano)
		}
		var survivalDurationMS *int64
		if assignment.Role == "hider" {
			huntStartedAt := round.StartedAt.
				Add(casualPreparingDuration).
				Add(time.Duration(round.HidingDurationSeconds) * time.Second)
			survivalEnd := state.TerminalAt
			if wasFound {
				survivalEnd = found.OccurredAt
			}
			if survivalEnd.Before(huntStartedAt) {
				survivalEnd = huntStartedAt
			}
			duration := survivalEnd.Sub(huntStartedAt).Milliseconds()
			if duration < 0 {
				return terminalResultCommit{}, errors.New(
					"round participant survival duration is invalid",
				)
			}
			survivalDurationMS = &duration
		}

		participantID, err := deterministicUUIDV7(
			state.TerminalAt,
			round.ID+"|participant|"+playerID,
		)
		if err != nil {
			return terminalResultCommit{}, err
		}
		participants = append(participants, terminalParticipant{
			ID:                 participantID,
			PlayerID:           playerID,
			HunterVolunteer:    assignment.HunterVolunteer,
			InitialRole:        assignment.Role,
			FinalRole:          state.CurrentRoles[playerID],
			CharacterForm:      "humanoid",
			SizePreset:         "x1_0",
			Outcome:            outcome,
			SurvivalDurationMS: survivalDurationMS,
			FinalScore:         score.Total,
			ScoreBreakdown:     score.Breakdown,
			FoundOrConvertedAt: foundAt,
			Reconnected:        state.ReconnectedPlayers[playerID],
		})
		canonicalParticipants = append(
			canonicalParticipants,
			canonicalRoundParticipant{
				PlayerID:           playerID,
				HunterVolunteer:    assignment.HunterVolunteer,
				InitialRole:        assignment.Role,
				FinalRole:          state.CurrentRoles[playerID],
				Outcome:            outcome,
				SurvivalDurationMS: survivalDurationMS,
				FinalScore:         score.Total,
				ScoreBreakdown:     score.Breakdown,
				FoundAt:            foundAtText,
				Reconnected:        state.ReconnectedPlayers[playerID],
			},
		)
	}

	discoveries := append([]roundDiscoverySnapshot(nil), state.Discoveries...)
	sort.Slice(discoveries, func(left, right int) bool {
		return discoveries[left].Sequence < discoveries[right].Sequence
	})
	terminalDiscoveries := make([]terminalDiscovery, 0, len(discoveries))
	canonicalDiscoveries := make([]canonicalRoundDiscovery, 0, len(discoveries))
	for _, discovery := range discoveries {
		discoveryID, err := deterministicUUIDV7(
			discovery.OccurredAt,
			fmt.Sprintf(
				"%s|discovery|%d|%s|%s",
				round.ID,
				discovery.Sequence,
				discovery.HunterPlayerID,
				discovery.HiderPlayerID,
			),
		)
		if err != nil {
			return terminalResultCommit{}, err
		}
		terminalDiscoveries = append(terminalDiscoveries, terminalDiscovery{
			ID:                        discoveryID,
			HunterPlayerID:            discovery.HunterPlayerID,
			HiderPlayerID:             discovery.HiderPlayerID,
			Sequence:                  int16(discovery.Sequence),
			OccurredAt:                discovery.OccurredAt.UTC(),
			CausedInfectionConversion: discovery.CausedInfectionConversion,
		})
		canonicalDiscoveries = append(
			canonicalDiscoveries,
			canonicalRoundDiscovery{
				HunterPlayerID:            discovery.HunterPlayerID,
				HiderPlayerID:             discovery.HiderPlayerID,
				Sequence:                  discovery.Sequence,
				OccurredAt:                discovery.OccurredAt.UTC().Format(time.RFC3339Nano),
				CausedInfectionConversion: discovery.CausedInfectionConversion,
			},
		)
	}

	likeVoters := make([]string, 0, len(state.Likes))
	for voterPlayerID := range state.Likes {
		likeVoters = append(likeVoters, voterPlayerID)
	}
	sort.Strings(likeVoters)
	terminalLikes := make([]terminalLike, 0, len(likeVoters))
	canonicalLikes := make([]canonicalRoundDisguiseLike, 0, len(likeVoters))
	for _, voterPlayerID := range likeVoters {
		like := state.Likes[voterPlayerID]
		likeID, err := deterministicUUIDV7(
			like.CreatedAt,
			round.ID+"|like|"+like.VoterPlayerID+"|"+like.TargetHiderPlayerID,
		)
		if err != nil {
			return terminalResultCommit{}, err
		}
		terminalLikes = append(terminalLikes, terminalLike{
			ID:                  likeID,
			VoterPlayerID:       like.VoterPlayerID,
			TargetHiderPlayerID: like.TargetHiderPlayerID,
			CreatedAt:           like.CreatedAt.UTC(),
		})
		canonicalLikes = append(
			canonicalLikes,
			canonicalRoundDisguiseLike{
				VoterPlayerID:       like.VoterPlayerID,
				TargetHiderPlayerID: like.TargetHiderPlayerID,
				CreatedAt:           like.CreatedAt.UTC().Format(time.RFC3339Nano),
			},
		)
	}

	revisionID, err := deterministicUUIDV7(
		completedAt,
		round.ID+"|result-revision|1",
	)
	if err != nil {
		return terminalResultCommit{}, err
	}
	document := canonicalRoundResultDocument{
		Version:             1,
		RoundID:             round.ID,
		SequenceNumber:      round.SequenceNumber,
		Mode:                round.Mode,
		StartedAt:           round.StartedAt.UTC().Format(time.RFC3339Nano),
		EndedAt:             completedAt.UTC().Format(time.RFC3339Nano),
		WinningSide:         state.WinningSide,
		CompletionReason:    state.CompletionReason,
		ResultSchemaVersion: resultSchemaVersion,
		ScoringRuleVersion:  scoringRuleVersion,
		Participants:        canonicalParticipants,
		Discoveries:         canonicalDiscoveries,
		Likes:               canonicalLikes,
	}
	canonical, err := json.Marshal(document)
	if err != nil {
		return terminalResultCommit{}, fmt.Errorf("encode canonical round result: %w", err)
	}
	return terminalResultCommit{
		RoundID:                 round.ID,
		RevisionID:              revisionID,
		EndedAt:                 completedAt.UTC(),
		WinningSide:             state.WinningSide,
		ResultSchemaVersion:     resultSchemaVersion,
		ScoringRuleVersion:      scoringRuleVersion,
		CanonicalCompleteResult: canonical,
		Participants:            participants,
		Discoveries:             terminalDiscoveries,
		Likes:                   terminalLikes,
	}, nil
}

func deterministicUUIDV7(now time.Time, scope string) (string, error) {
	var value [16]byte
	milliseconds := now.UnixMilli()
	if milliseconds < 0 || milliseconds > 0x0000ffffffffffff {
		return "", errors.New("UUIDv7 timestamp is out of range")
	}
	for index := 5; index >= 0; index-- {
		value[index] = byte(milliseconds)
		milliseconds >>= 8
	}
	digest := sha256.Sum256([]byte(scope))
	copy(value[6:], digest[:10])
	value[6] = (value[6] & 0x0f) | 0x70
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[0:8] + "-" +
		encoded[8:12] + "-" +
		encoded[12:16] + "-" +
		encoded[16:20] + "-" +
		encoded[20:32], nil
}

func authoritativeParticipantOutcome(
	mode string,
	role string,
	found bool,
	winningSide string,
) (string, error) {
	switch role {
	case "hunter":
		switch winningSide {
		case "hunters":
			return "hunter_win", nil
		case "hiders":
			return "hunter_loss", nil
		case "none":
			return "no_contest", nil
		}
	case "hider":
		if found {
			if mode == "infection" {
				return "hider_converted", nil
			}
			return "hider_found", nil
		}
		switch winningSide {
		case "hiders":
			return "hider_survived", nil
		case "none":
			return "no_contest", nil
		}
	}
	return "", errors.New("round participant outcome is inconsistent")
}

func finalizeAuthoritativeRound(
	ctx context.Context,
	store terminalRoundStore,
	round *roundSnapshot,
	state *authoritativeRoundState,
) (terminalResultCommitOutcome, error) {
	if store == nil {
		return "", errors.New("lobby store is unavailable")
	}
	if err := store.UpdateRoundPhase(ctx, round.ID, "answer_check"); err != nil {
		return "", err
	}
	input, err := buildAuthoritativeTerminalResult(round, state)
	if err != nil {
		return "", err
	}
	outcome, err := store.CommitTerminalResult(ctx, input)
	if err != nil {
		return "", err
	}
	state.Phase = "completed"
	state.Apply(round)
	round.ResultRevisionID = input.RevisionID
	return outcome, nil
}
