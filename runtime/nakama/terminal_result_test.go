package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestCommitTerminalResultCommitsBundleAndCompletesRoundLast(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	input := terminalResultFixture()
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT status::text, canonical_result_sha256::text
		   FROM game.game_round
		  WHERE id = $1
		  FOR UPDATE`)).WithArgs(input.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{"status", "canonical_result_sha256"}).AddRow("answer_check", nil))
	mock.ExpectExec("INSERT INTO game.round_participant").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.round_participant").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.round_discovery").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.round_like").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.round_result_revision").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO game.match_publication_request").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE game.game_round").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	outcome, err := commitTerminalResult(context.Background(), database, input)
	if err != nil {
		t.Fatalf("commit terminal result: %v", err)
	}
	if outcome != terminalResultCommitted {
		t.Fatalf("expected committed, got %q", outcome)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet SQL expectations: %v", err)
	}
}

func TestCommitTerminalResultReplaysSameCanonicalBundle(t *testing.T) {
	database, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("create SQL mock: %v", err)
	}
	defer database.Close()

	input := terminalResultFixture()
	hash := sha256.Sum256(input.CanonicalCompleteResult)
	hashString := hex.EncodeToString(hash[:])
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT status::text").WithArgs(input.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{"status", "canonical_result_sha256"}).AddRow("completed", hashString))
	mock.ExpectQuery("SELECT revision.canonical_complete_result_sha256").WithArgs(input.RoundID).
		WillReturnRows(sqlmock.NewRows([]string{
			"canonical_complete_result_sha256",
			"canonical_result_object_key",
			"result_schema_version",
			"scoring_rule_version",
			"request_count",
		}).AddRow(hashString, input.CanonicalResultObjectKey, input.ResultSchemaVersion, input.ScoringRuleVersion, 1))
	mock.ExpectCommit()

	outcome, err := commitTerminalResult(context.Background(), database, input)
	if err != nil {
		t.Fatalf("replay terminal result: %v", err)
	}
	if outcome != terminalResultReplayed {
		t.Fatalf("expected replayed, got %q", outcome)
	}
}

func TestValidateTerminalResultRejectsNonParticipantDiscovery(t *testing.T) {
	input := terminalResultFixture()
	input.Discoveries[0].HiderPlayerID = "01900000-0000-7000-8000-000000000099"
	if _, err := validateTerminalResult(input); err == nil {
		t.Fatal("expected invalid discovery to fail")
	}
}

func terminalResultFixture() terminalResultCommit {
	endedAt := time.Date(2026, time.July, 23, 12, 5, 0, 0, time.UTC)
	foundAt := endedAt.Add(-time.Minute)
	return terminalResultCommit{
		RoundID:                  "01900000-0000-7000-8000-000000000001",
		RevisionID:               "01900000-0000-7000-8000-000000000002",
		PublicationRequestID:     "01900000-0000-7000-8000-000000000003",
		EndedAt:                  endedAt,
		WinningSide:              "hunters",
		ResultSchemaVersion:      "match-result-1",
		ScoringRuleVersion:       "scoring-1",
		CanonicalCompleteResult:  []byte(`{"v":1,"round_id":"01900000-0000-7000-8000-000000000001"}`),
		CanonicalResultObjectKey: "round-results/01900000-0000-7000-8000-000000000001/1.json",
		Participants: []terminalParticipant{
			{
				ID: "01900000-0000-7000-8000-000000000010", PlayerID: "01900000-0000-7000-8000-000000000011",
				InitialRole: "hunter", FinalRole: "hunter", CharacterForm: "humanoid", SizePreset: "x1_0",
				Outcome: "hunter_win", FinalScore: "1000.0000", ScoreBreakdown: []byte(`{"base":"1000.0000"}`),
			},
			{
				ID: "01900000-0000-7000-8000-000000000012", PlayerID: "01900000-0000-7000-8000-000000000013",
				InitialRole: "hider", FinalRole: "hider", CharacterForm: "humanoid", SizePreset: "x1_0",
				Outcome: "hider_found", FinalScore: "500.0000", ScoreBreakdown: []byte(`{"base":"500.0000"}`),
				FoundOrConvertedAt: &foundAt,
			},
		},
		Discoveries: []terminalDiscovery{{
			ID: "01900000-0000-7000-8000-000000000020", HunterPlayerID: "01900000-0000-7000-8000-000000000011",
			HiderPlayerID: "01900000-0000-7000-8000-000000000013", Sequence: 1, OccurredAt: endedAt.Add(-time.Minute),
		}},
		Likes: []terminalLike{{
			ID: "01900000-0000-7000-8000-000000000030", VoterPlayerID: "01900000-0000-7000-8000-000000000011",
			TargetHiderPlayerID: "01900000-0000-7000-8000-000000000013", CreatedAt: endedAt,
		}},
	}
}
