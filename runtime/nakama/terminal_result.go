package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"
)

const maximumCanonicalResultBytes = 1024 * 1024

var fixedScorePattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.[0-9]{4}$`)

type terminalParticipant struct {
	ID                 string
	PlayerID           string
	HunterVolunteer    bool
	InitialRole        string
	FinalRole          string
	CharacterForm      string
	SizePreset         string
	Outcome            string
	SurvivalDurationMS *int64
	FinalScore         string
	ScoreBreakdown     json.RawMessage
	FoundOrConvertedAt *time.Time
	Reconnected        bool
}

type terminalDiscovery struct {
	ID                        string
	HunterPlayerID            string
	HiderPlayerID             string
	Sequence                  int16
	OccurredAt                time.Time
	CausedInfectionConversion bool
}

type terminalLike struct {
	ID                  string
	VoterPlayerID       string
	TargetHiderPlayerID string
	CreatedAt           time.Time
}

type terminalResultCommit struct {
	RoundID                  string
	RevisionID               string
	PublicationRequestID     string
	EndedAt                  time.Time
	WinningSide              string
	ResultSchemaVersion      string
	ScoringRuleVersion       string
	CanonicalCompleteResult  []byte
	CanonicalResultObjectKey string
	Participants             []terminalParticipant
	Discoveries              []terminalDiscovery
	Likes                    []terminalLike
}

type terminalResultCommitOutcome string

const (
	terminalResultCommitted terminalResultCommitOutcome = "committed"
	terminalResultReplayed  terminalResultCommitOutcome = "replayed"
)

// commitTerminalResult is the authoritative terminal boundary used by future Nakama match code.
// It inserts detailed evidence, the initial immutable revision, and the publication request, then
// moves the round to completed last. PostgreSQL's deferred aggregate trigger validates the bundle
// at COMMIT. A retry for an already-completed round succeeds only when it names the same canonical
// result, schema versions, and object-store document.
func commitTerminalResult(
	ctx context.Context,
	database *sql.DB,
	input terminalResultCommit,
) (terminalResultCommitOutcome, error) {
	if database == nil {
		return "", errors.New("terminal result database is unavailable")
	}
	canonicalSHA256, err := validateTerminalResult(input)
	if err != nil {
		return "", err
	}

	tx, err := database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return "", fmt.Errorf("begin terminal result transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var status string
	var storedSHA256 sql.NullString
	if err := tx.QueryRowContext(
		ctx,
		`SELECT status::text, canonical_result_sha256::text
		   FROM game.game_round
		  WHERE id = $1
		  FOR UPDATE`,
		input.RoundID,
	).Scan(&status, &storedSHA256); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", errors.New("terminal result round does not exist")
		}
		return "", fmt.Errorf("lock terminal result round: %w", err)
	}

	if status == "completed" {
		if err := assertTerminalResultReplay(ctx, tx, input, canonicalSHA256, storedSHA256); err != nil {
			return "", err
		}
		if err := tx.Commit(); err != nil {
			return "", fmt.Errorf("commit terminal result replay: %w", err)
		}
		return terminalResultReplayed, nil
	}
	if status != "answer_check" {
		return "", fmt.Errorf("round cannot complete from status %q", status)
	}

	for _, participant := range input.Participants {
		scoreBreakdown := participant.ScoreBreakdown
		if len(scoreBreakdown) == 0 {
			scoreBreakdown = json.RawMessage(`{}`)
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO game.round_participant
			  (id, round_id, player_id, hunter_volunteer, initial_role, final_role,
			   character_form, size_preset, outcome, survival_duration_ms, final_score,
			   score_breakdown, found_or_converted_at, reconnected)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric,
			         $12::jsonb, $13, $14)`,
			participant.ID,
			input.RoundID,
			participant.PlayerID,
			participant.HunterVolunteer,
			participant.InitialRole,
			participant.FinalRole,
			participant.CharacterForm,
			participant.SizePreset,
			participant.Outcome,
			nullableInt64(participant.SurvivalDurationMS),
			participant.FinalScore,
			string(scoreBreakdown),
			nullableTime(participant.FoundOrConvertedAt),
			participant.Reconnected,
		); err != nil {
			return "", fmt.Errorf("insert terminal participant: %w", err)
		}
	}

	for _, discovery := range input.Discoveries {
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO game.round_discovery
			  (id, round_id, hunter_player_id, hider_player_id, discovery_sequence,
			   occurred_at, caused_infection_conversion)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			discovery.ID,
			input.RoundID,
			discovery.HunterPlayerID,
			discovery.HiderPlayerID,
			discovery.Sequence,
			discovery.OccurredAt,
			discovery.CausedInfectionConversion,
		); err != nil {
			return "", fmt.Errorf("insert terminal discovery: %w", err)
		}
	}

	for _, like := range input.Likes {
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO game.round_like
			  (id, round_id, voter_player_id, target_hider_player_id, created_at)
			 VALUES ($1, $2, $3, $4, $5)`,
			like.ID,
			input.RoundID,
			like.VoterPlayerID,
			like.TargetHiderPlayerID,
			like.CreatedAt,
		); err != nil {
			return "", fmt.Errorf("insert terminal like: %w", err)
		}
	}

	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.round_result_revision
		  (id, round_id, revision_number, revision_type, result_schema_version,
		   scoring_rule_version, canonical_complete_result_sha256, canonical_result_object_key)
		 VALUES ($1, $2, 1, 'initial', $3, $4, $5, $6)`,
		input.RevisionID,
		input.RoundID,
		input.ResultSchemaVersion,
		input.ScoringRuleVersion,
		canonicalSHA256,
		input.CanonicalResultObjectKey,
	); err != nil {
		return "", fmt.Errorf("insert initial result revision: %w", err)
	}

	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO game.match_publication_request
		  (id, round_id, result_revision_id, request_type, state)
		 VALUES ($1, $2, $3, 'initial', 'queued')`,
		input.PublicationRequestID,
		input.RoundID,
		input.RevisionID,
	); err != nil {
		return "", fmt.Errorf("insert initial publication request: %w", err)
	}

	result, err := tx.ExecContext(
		ctx,
		`UPDATE game.game_round
		    SET status = 'completed',
		        winning_side = $2,
		        canonical_result_sha256 = $3,
		        ended_at = $4
		  WHERE id = $1
		    AND status = 'answer_check'`,
		input.RoundID,
		input.WinningSide,
		canonicalSHA256,
		input.EndedAt,
	)
	if err != nil {
		return "", fmt.Errorf("complete terminal result round: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil || rowsAffected != 1 {
		return "", errors.New("terminal result round changed concurrently")
	}

	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit terminal result: %w", err)
	}
	return terminalResultCommitted, nil
}

func assertTerminalResultReplay(
	ctx context.Context,
	tx *sql.Tx,
	input terminalResultCommit,
	canonicalSHA256 string,
	storedRoundSHA256 sql.NullString,
) error {
	if !storedRoundSHA256.Valid || storedRoundSHA256.String != canonicalSHA256 {
		return errors.New("terminal result replay conflicts with completed round hash")
	}

	var revisionSHA256, objectKey, resultSchema, scoringRules string
	var requestCount int
	if err := tx.QueryRowContext(
		ctx,
		`SELECT revision.canonical_complete_result_sha256::text,
		        revision.canonical_result_object_key,
		        revision.result_schema_version,
		        revision.scoring_rule_version,
		        count(request.id)::integer
		   FROM game.round_result_revision AS revision
		   LEFT JOIN game.match_publication_request AS request
		     ON request.result_revision_id = revision.id
		    AND request.request_type = 'initial'
		    AND request.state <> 'cancelled'
		  WHERE revision.round_id = $1
		    AND revision.revision_type = 'initial'
		  GROUP BY revision.id`,
		input.RoundID,
	).Scan(&revisionSHA256, &objectKey, &resultSchema, &scoringRules, &requestCount); err != nil {
		return fmt.Errorf("load completed terminal result bundle: %w", err)
	}
	if revisionSHA256 != canonicalSHA256 ||
		objectKey != input.CanonicalResultObjectKey ||
		resultSchema != input.ResultSchemaVersion ||
		scoringRules != input.ScoringRuleVersion ||
		requestCount != 1 {
		return errors.New("terminal result replay conflicts with completed result bundle")
	}
	return nil
}

func validateTerminalResult(input terminalResultCommit) (string, error) {
	for label, value := range map[string]string{
		"round ID":               input.RoundID,
		"revision ID":            input.RevisionID,
		"publication request ID": input.PublicationRequestID,
	} {
		if _, err := canonicalUUIDV7ToCompact(value); err != nil {
			return "", fmt.Errorf("invalid %s", label)
		}
	}
	if input.EndedAt.IsZero() {
		return "", errors.New("terminal result ended-at timestamp is required")
	}
	if input.WinningSide != "hiders" && input.WinningSide != "hunters" && input.WinningSide != "none" {
		return "", errors.New("terminal result winning side is invalid")
	}
	if !controlledVersion(input.ResultSchemaVersion) || !controlledVersion(input.ScoringRuleVersion) {
		return "", errors.New("terminal result schema or scoring version is invalid")
	}
	if len(input.CanonicalCompleteResult) == 0 || len(input.CanonicalCompleteResult) > maximumCanonicalResultBytes {
		return "", errors.New("canonical complete result size is invalid")
	}
	if !json.Valid(input.CanonicalCompleteResult) {
		return "", errors.New("canonical complete result is not valid JSON")
	}
	if input.CanonicalResultObjectKey == "" || len(input.CanonicalResultObjectKey) > 1024 {
		return "", errors.New("canonical result object key is invalid")
	}
	if len(input.Participants) < 2 || len(input.Participants) > 10 {
		return "", errors.New("terminal result must contain 2..10 participants")
	}

	participantIDs := make(map[string]struct{}, len(input.Participants))
	players := make(map[string]terminalParticipant, len(input.Participants))
	winnerCount := 0
	for _, participant := range input.Participants {
		if _, err := canonicalUUIDV7ToCompact(participant.ID); err != nil {
			return "", errors.New("terminal participant ID is invalid")
		}
		if _, err := canonicalUUIDV7ToCompact(participant.PlayerID); err != nil {
			return "", errors.New("terminal participant player ID is invalid")
		}
		if _, exists := participantIDs[participant.ID]; exists {
			return "", errors.New("terminal participant IDs must be unique")
		}
		if _, exists := players[participant.PlayerID]; exists {
			return "", errors.New("terminal participant players must be unique")
		}
		participantIDs[participant.ID] = struct{}{}
		players[participant.PlayerID] = participant
		if !validPlayerRole(participant.InitialRole) || !validPlayerRole(participant.FinalRole) {
			return "", errors.New("terminal participant role is invalid")
		}
		if !validParticipantOutcome(participant.Outcome) || !fixedScorePattern.MatchString(participant.FinalScore) {
			return "", errors.New("terminal participant outcome or score is invalid")
		}
		if err := validateParticipantRoleOutcome(participant, input.WinningSide); err != nil {
			return "", err
		}
		if participant.Outcome == "hunter_win" || participant.Outcome == "hider_survived" {
			winnerCount++
		}
		if participant.SurvivalDurationMS != nil && *participant.SurvivalDurationMS < 0 {
			return "", errors.New("terminal participant survival duration is invalid")
		}
		if len(participant.ScoreBreakdown) == 0 {
			participant.ScoreBreakdown = json.RawMessage(`{}`)
		}
		if !json.Valid(participant.ScoreBreakdown) {
			return "", errors.New("terminal participant score breakdown is invalid")
		}
	}
	if (input.WinningSide == "none" && winnerCount != 0) ||
		(input.WinningSide != "none" && winnerCount == 0) {
		return "", errors.New("terminal participant outcomes do not match the winning side")
	}

	discoveryHiders := make(map[string]struct{}, len(input.Discoveries))
	discoverySequences := make([]int, 0, len(input.Discoveries))
	for _, discovery := range input.Discoveries {
		if _, err := canonicalUUIDV7ToCompact(discovery.ID); err != nil {
			return "", errors.New("terminal discovery ID is invalid")
		}
		hunter, hunterExists := players[discovery.HunterPlayerID]
		if !hunterExists || hunter.FinalRole != "hunter" {
			return "", errors.New("terminal discovery hunter is not a participant")
		}
		hider, hiderExists := players[discovery.HiderPlayerID]
		if !hiderExists || hider.InitialRole != "hider" {
			return "", errors.New("terminal discovery hider is not a participant")
		}
		if discovery.HunterPlayerID == discovery.HiderPlayerID || discovery.Sequence <= 0 || discovery.OccurredAt.IsZero() {
			return "", errors.New("terminal discovery is invalid")
		}
		if _, exists := discoveryHiders[discovery.HiderPlayerID]; exists {
			return "", errors.New("terminal result can discover each hider once")
		}
		discoveryHiders[discovery.HiderPlayerID] = struct{}{}
		discoverySequences = append(discoverySequences, int(discovery.Sequence))
	}
	sort.Ints(discoverySequences)
	for index, sequence := range discoverySequences {
		if sequence != index+1 {
			return "", errors.New("terminal discovery sequence must be contiguous")
		}
	}

	likeVoters := make(map[string]struct{}, len(input.Likes))
	for _, like := range input.Likes {
		if _, err := canonicalUUIDV7ToCompact(like.ID); err != nil {
			return "", errors.New("terminal like ID is invalid")
		}
		if _, voterExists := players[like.VoterPlayerID]; !voterExists {
			return "", errors.New("terminal like voter is not a participant")
		}
		target, targetExists := players[like.TargetHiderPlayerID]
		if !targetExists || target.InitialRole != "hider" {
			return "", errors.New("terminal like target is not a participant")
		}
		if like.VoterPlayerID == like.TargetHiderPlayerID || like.CreatedAt.IsZero() {
			return "", errors.New("terminal like is invalid")
		}
		if _, exists := likeVoters[like.VoterPlayerID]; exists {
			return "", errors.New("terminal result can record one like per voter")
		}
		likeVoters[like.VoterPlayerID] = struct{}{}
	}

	hash := sha256.Sum256(input.CanonicalCompleteResult)
	return hex.EncodeToString(hash[:]), nil
}

func controlledVersion(value string) bool {
	if len(value) == 0 || len(value) > 32 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == '-')) {
			continue
		}
		return false
	}
	return true
}

func validPlayerRole(value string) bool {
	return value == "hider" || value == "hunter"
}

func validParticipantOutcome(value string) bool {
	switch value {
	case "hunter_win", "hunter_loss", "hider_survived", "hider_found", "hider_converted":
		return true
	default:
		return false
	}
}

func validateParticipantRoleOutcome(participant terminalParticipant, winningSide string) error {
	if participant.InitialRole == "hunter" && participant.FinalRole != "hunter" {
		return errors.New("terminal participant cannot transition from hunter to hider")
	}
	switch participant.Outcome {
	case "hunter_win":
		if participant.InitialRole != "hunter" || participant.FinalRole != "hunter" || winningSide != "hunters" {
			return errors.New("terminal hunter-win outcome is inconsistent")
		}
	case "hunter_loss":
		if participant.InitialRole != "hunter" || participant.FinalRole != "hunter" || winningSide == "hunters" {
			return errors.New("terminal hunter-loss outcome is inconsistent")
		}
	case "hider_survived":
		if participant.InitialRole != "hider" || participant.FinalRole != "hider" || winningSide != "hiders" {
			return errors.New("terminal hider-survived outcome is inconsistent")
		}
	case "hider_found":
		if participant.InitialRole != "hider" || participant.FinalRole != "hider" || winningSide == "hiders" {
			return errors.New("terminal hider-found outcome is inconsistent")
		}
		if participant.FoundOrConvertedAt == nil {
			return errors.New("terminal hider-found outcome requires its timestamp")
		}
	case "hider_converted":
		if participant.InitialRole != "hider" || participant.FinalRole != "hunter" || winningSide == "hiders" {
			return errors.New("terminal hider-converted outcome is inconsistent")
		}
		if participant.FoundOrConvertedAt == nil {
			return errors.New("terminal hider-converted outcome requires its timestamp")
		}
	}
	return nil
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}
