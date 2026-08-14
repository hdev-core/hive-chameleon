using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using HiveChameleon.Presentation;
using HiveChameleon.Realtime;
using NUnit.Framework;
using UnityEngine;

namespace HiveChameleon.Tests
{
    public sealed class AuthoritativeLobbyMenuTests
    {
        private const string HostPlayerId =
            "0199abc1-2345-7abc-8def-0123456789ab";
        private const string GuestPlayerId =
            "0199abc1-2345-7abc-9def-0123456789ac";
        private const string MapVersionId =
            "0199abc1-2345-7abc-adef-0123456789ad";
        private const string FirstRoundId =
            "0199abc1-2345-7abc-bdef-0123456789ae";
        private const string SecondRoundId =
            "0199abc1-2345-7abc-8def-0123456789b0";

        [TestCase("preparing")]
        [TestCase("hiding")]
        [TestCase("hunting")]
        [TestCase("answer_check")]
        public void AuthoritativeRoundStatesActivateGameplay(string status)
        {
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-bdef-0123456789ae",
                        map_version_id = MapVersionId,
                        map_slug = AuthoritativeArenaCatalog.NeonServiceArcadeSlug,
                        map_display_name =
                            AuthoritativeArenaCatalog.NeonServiceArcadeDisplayName,
                        map_content_version =
                            AuthoritativeArenaCatalog.NeonServiceArcadeContentVersion,
                        game_server_build_version =
                            LobbyMenuRules.SupportedGameServerBuildVersion,
                        protocol_version =
                            LobbyMenuRules.SupportedProtocolVersion,
                        authority_geometry_version =
                            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion,
                        authority_geometry_digest =
                            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest,
                        status = status,
                    }
                ),
                Is.True
            );
        }

        [TestCase("", "m2")]
        [TestCase("not-a-map-version", "m2")]
        [TestCase(MapVersionId, "")]
        [TestCase(MapVersionId, "m1")]
        public void GameplayRejectsMissingOrIncompatibleMapMetadata(
            string mapVersionId,
            string mapContentVersion
        )
        {
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-bdef-0123456789ae",
                        map_version_id = mapVersionId,
                        map_content_version = mapContentVersion,
                        game_server_build_version =
                            LobbyMenuRules.SupportedGameServerBuildVersion,
                        protocol_version =
                            LobbyMenuRules.SupportedProtocolVersion,
                        authority_geometry_version =
                            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion,
                        authority_geometry_digest =
                            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest,
                        status = "hunting",
                    }
                ),
                Is.False
            );
        }

        [Test]
        public void RoundSnapshotParsesAuthoritativeMapMetadata()
        {
            const string json =
                "{\"id\":\"0199abc1-2345-7abc-bdef-0123456789ae\","
                + "\"map_version_id\":\""
                + MapVersionId
                + "\",\"map_slug\":\""
                + AuthoritativeArenaCatalog.NeonServiceArcadeSlug
                + "\",\"map_display_name\":\""
                + AuthoritativeArenaCatalog.NeonServiceArcadeDisplayName
                + "\",\"map_content_version\":\"m2\","
                + "\"game_server_build_version\":\"hive-chameleon-m4-dev\","
                + "\"protocol_version\":\"m4-v2\","
                + "\"authority_geometry_version\":\""
                + AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion
                + "\",\"authority_geometry_digest\":\""
                + AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest
                + "\",\"status\":\"hunting\"}";

            RoundSnapshot round = JsonUtility.FromJson<RoundSnapshot>(json);

            Assert.That(round.map_version_id, Is.EqualTo(MapVersionId));
            Assert.That(
                round.map_slug,
                Is.EqualTo(AuthoritativeArenaCatalog.NeonServiceArcadeSlug)
            );
            Assert.That(
                round.map_display_name,
                Is.EqualTo(AuthoritativeArenaCatalog.NeonServiceArcadeDisplayName)
            );
            Assert.That(
                round.map_content_version,
                Is.EqualTo(AuthoritativeArenaCatalog.NeonServiceArcadeContentVersion)
            );
            Assert.That(
                round.game_server_build_version,
                Is.EqualTo(LobbyMenuRules.SupportedGameServerBuildVersion)
            );
            Assert.That(
                round.protocol_version,
                Is.EqualTo(LobbyMenuRules.SupportedProtocolVersion)
            );
            Assert.That(
                round.authority_geometry_version,
                Is.EqualTo(
                    AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion
                )
            );
            Assert.That(
                round.authority_geometry_digest,
                Is.EqualTo(
                    AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest
                )
            );
            Assert.That(LobbyMenuRules.IsGameplayRound(round), Is.True);
        }

        [TestCase("wrong-build", "m4-v2")]
        [TestCase("hive-chameleon-m4-dev", "wrong-protocol")]
        public void GameplayRejectsIncompatibleServerOrProtocol(
            string buildVersion,
            string protocolVersion
        )
        {
            var round = BuildRound(FirstRoundId, 1, "hunting");
            round.game_server_build_version = buildVersion;
            round.protocol_version = protocolVersion;

            Assert.That(LobbyMenuRules.IsGameplayRound(round), Is.False);
        }

        [TestCase(
            "wrong-geometry",
            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest
        )]
        [TestCase(
            AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion,
            "sha256:wrong"
        )]
        public void GameplayRejectsIncompatibleAuthorityGeometry(
            string geometryVersion,
            string geometryDigest
        )
        {
            var round = BuildRound(FirstRoundId, 1, "hunting");
            round.authority_geometry_version = geometryVersion;
            round.authority_geometry_digest = geometryDigest;

            Assert.That(LobbyMenuRules.IsGameplayRound(round), Is.False);
        }

        [Test]
        public void CompletedRoundReturnsPlayersToTheLobby()
        {
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-bdef-0123456789ae",
                        status = "completed",
                    }
                ),
                Is.False
            );
        }

        [Test]
        public void MissingOrUnknownRoundNeverActivatesGameplay()
        {
            Assert.That(LobbyMenuRules.IsGameplayRound(null), Is.False);
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot { id = string.Empty, status = "hunting" }
                ),
                Is.False
            );
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-bdef-0123456789ae",
                        status = "lobby",
                    }
                ),
                Is.False
            );
        }

        [Test]
        public void InterruptedLobbyKeepsItsReconnectPath()
        {
            LobbySnapshot lobby = BuildLobby(2, 1, MapVersionId);

            Assert.That(
                LobbyMenuRules.CanAttemptReconnect(
                    RealtimeConnectionState.Disconnected,
                    lobby
                ),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.CanAttemptReconnect(
                    RealtimeConnectionState.Faulted,
                    lobby
                ),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.CanAttemptReconnect(
                    RealtimeConnectionState.Connected,
                    lobby
                ),
                Is.False
            );

            lobby.closed = true;
            Assert.That(
                LobbyMenuRules.CanAttemptReconnect(
                    RealtimeConnectionState.Disconnected,
                    lobby
                ),
                Is.False
            );
        }

        [Test]
        public void ReconnectDescriptorParsesAValidColdReservation()
        {
            DateTimeOffset checkedAt = DateTimeOffset.Parse(
                "2026-08-01T12:00:00Z"
            );
            ReconnectDescriptor descriptor = ReconnectDescriptor.FromJson(
                "{\"available\":true,\"lobbyId\":\""
                    + MapVersionId
                    + "\",\"expiresAt\":\"2026-08-01T12:00:45Z\","
                    + "\"restorationMode\":\"same_role\"}",
                checkedAt
            );

            Assert.That(descriptor.Available, Is.True);
            Assert.That(descriptor.LobbyId, Is.EqualTo(MapVersionId));
            Assert.That(descriptor.ExpiresAt, Is.GreaterThan(checkedAt));
            Assert.That(descriptor.RestorationMode, Is.EqualTo("same_role"));
        }

        [Test]
        public void ReconnectDescriptorFailsClosed()
        {
            DateTimeOffset checkedAt = DateTimeOffset.Parse(
                "2026-08-01T12:00:00Z"
            );
            ReconnectDescriptor unavailable = ReconnectDescriptor.FromJson(
                "{\"available\":false}",
                checkedAt
            );

            Assert.That(unavailable.Available, Is.False);
            Assert.Throws<InvalidOperationException>(() =>
                ReconnectDescriptor.FromJson(
                    "{\"available\":true,\"lobbyId\":\"not-a-lobby\","
                        + "\"expiresAt\":\"2026-08-01T12:00:45Z\","
                        + "\"restorationMode\":\"same_role\"}",
                    checkedAt
                )
            );
            Assert.Throws<InvalidOperationException>(() =>
                ReconnectDescriptor.FromJson(
                    "{\"available\":true,\"lobbyId\":\""
                        + MapVersionId
                        + "\",\"expiresAt\":\"2026-08-01T12:00:00Z\","
                        + "\"restorationMode\":\"same_role\"}",
                    checkedAt
                )
            );
        }

        [Test]
        public void HostAndNominationComeFromAuthoritativeLobbyIds()
        {
            LobbySnapshot lobby = BuildLobby(2, 1, MapVersionId);
            lobby.hunter_nominee_player_ids = new[] { GuestPlayerId };

            Assert.That(LobbyMenuRules.IsHost(lobby, HostPlayerId), Is.True);
            Assert.That(LobbyMenuRules.IsHost(lobby, GuestPlayerId), Is.False);
            Assert.That(
                LobbyMenuRules.IsNominated(lobby, GuestPlayerId),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.IsNominated(lobby, HostPlayerId),
                Is.False
            );
        }

        [Test]
        public void HostCanStartOnlyWithPublishedMapAndEnoughPlayers()
        {
            LobbySnapshot ready = BuildLobby(2, 1, MapVersionId);
            Assert.That(
                LobbyMenuRules.CanStartRound(
                    ready,
                    null,
                    HostPlayerId,
                    out string readyReason
                ),
                Is.True,
                readyReason
            );

            LobbySnapshot missingMap = BuildLobby(2, 1, string.Empty);
            Assert.That(
                LobbyMenuRules.CanStartRound(
                    missingMap,
                    null,
                    HostPlayerId,
                    out string mapReason
                ),
                Is.False
            );
            Assert.That(mapReason, Does.Contain("available map"));

            LobbySnapshot missingHider = BuildLobby(2, 2, MapVersionId);
            Assert.That(
                LobbyMenuRules.CanStartRound(
                    missingHider,
                    null,
                    HostPlayerId,
                    out string playerReason
                ),
                Is.False
            );
            Assert.That(playerReason, Does.Contain("more player"));

            Assert.That(
                LobbyMenuRules.CanStartRound(
                    ready,
                    null,
                    GuestPlayerId,
                    out string hostReason
                ),
                Is.False
            );
            Assert.That(hostReason, Does.Contain("host"));
        }

        [Test]
        public void CompletedRoundAllowsAuthoritativeRematch()
        {
            LobbySnapshot lobby = BuildLobby(2, 1, MapVersionId);
            var completed = new RoundSnapshot
            {
                id = "0199abc1-2345-7abc-bdef-0123456789ae",
                status = "completed",
            };

            Assert.That(
                LobbyMenuRules.CanStartRound(
                    lobby,
                    completed,
                    HostPlayerId,
                    out string reason
                ),
                Is.True,
                reason
            );
        }

        [Test]
        public void LobbyFormsRejectInvalidUserInput()
        {
            Assert.That(
                LobbyMenuRules.ValidateCreateLobby(
                    "Night Hunt",
                    false,
                    string.Empty,
                    8,
                    "local",
                    out _
                ),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.ValidateCreateLobby(
                    "Private Hunt",
                    true,
                    "short",
                    8,
                    "local",
                    out string passwordReason
                ),
                Is.False
            );
            Assert.That(passwordReason, Does.Contain("8 to 72"));
            Assert.That(
                LobbyMenuRules.ValidateCreateLobby(
                    "Night Hunt",
                    false,
                    string.Empty,
                    8,
                    "Bad Region",
                    out string regionReason
                ),
                Is.False
            );
            Assert.That(regionReason, Does.Contain("Region"));
            Assert.That(
                LobbyMenuRules.ValidateJoinLobby(MapVersionId, out _),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.ValidateJoinLobby(
                    "not-a-lobby",
                    out string joinReason
                ),
                Is.False
            );
            Assert.That(joinReason, Does.Contain("valid lobby code"));
        }

        [Test]
        public void LobbyCodesRequireUuidVersionSeven()
        {
            Assert.That(LobbyMenuRules.IsUuidV7(MapVersionId), Is.True);
            Assert.That(
                LobbyMenuRules.IsUuidV7(
                    "0199abc1-2345-4abc-adef-0123456789ad"
                ),
                Is.False
            );
            Assert.That(LobbyMenuRules.IsUuidV7(string.Empty), Is.False);
        }

        [Test]
        public void PlayerLabelsPreferDisplayNamesAndNeverExposeIdentifiers()
        {
            Assert.That(
                LobbyMenuRules.PlayerDisplayLabel("  night-fox  ", 1),
                Is.EqualTo("night-fox")
            );
            Assert.That(
                LobbyMenuRules.PlayerDisplayLabel(HostPlayerId, 2),
                Is.EqualTo("Player 02")
            );
            Assert.That(
                LobbyMenuRules.PlayerDisplayLabel("0199abc1…89ab", 3),
                Is.EqualTo("Player 03")
            );
            Assert.That(
                LobbyMenuRules.PlayerDisplayLabel(
                    "hc_0199abc123457abc8def0123456789ab",
                    4
                ),
                Is.EqualTo("Player 04")
            );
            Assert.That(
                LobbyMenuRules.PlayerDisplayLabel(string.Empty),
                Is.EqualTo("Player")
            );
        }

        [Test]
        public void PlayerFacingErrorsNeverExposeEngineeringDetails()
        {
            const string internalMessage =
                "rpc failed against postgres://operator:secret@db:5432 with trace 7f2a";
            string sanitized = LobbyMenuRules.ProductErrorMessage(
                new InvalidOperationException(internalMessage)
            );

            Assert.That(
                sanitized,
                Is.EqualTo(
                    "Online services could not complete the request. Please try again."
                )
            );
            Assert.That(sanitized, Does.Not.Contain("postgres"));
            Assert.That(sanitized, Does.Not.Contain("secret"));
            Assert.That(sanitized, Does.Not.Contain("7f2a"));
            Assert.That(
                LobbyMenuRules.ProductErrorMessage(
                    new InvalidOperationException(
                        "credential endpoint returned HTTP 401"
                    )
                ),
                Is.EqualTo(
                    "Your session has expired. Reconnect and try again."
                )
            );
            Assert.That(
                LobbyMenuRules.ProductErrorMessage(
                    new InvalidOperationException("socket connection timed out")
                ),
                Is.EqualTo(
                    "Online services could not be reached. Please try again."
                )
            );
        }

        [Test]
        public void NetworkSnapshotsConsumeOptionalDisplayNames()
        {
            const string json =
                "{\"player_id\":\"opaque-id\",\"display_name\":\"night-fox\"}";

            Assert.That(
                JsonUtility.FromJson<LobbyMemberSnapshot>(json).display_name,
                Is.EqualTo("night-fox")
            );
            Assert.That(
                JsonUtility.FromJson<AvatarStateSnapshot>(json).display_name,
                Is.EqualTo("night-fox")
            );
            Assert.That(
                JsonUtility.FromJson<SpectatorPlayerSnapshot>(json).display_name,
                Is.EqualTo("night-fox")
            );
            Assert.That(
                JsonUtility.FromJson<AnswerCheckReveal>(json).display_name,
                Is.EqualTo("night-fox")
            );
            Assert.That(
                JsonUtility.FromJson<RoundScoreEntry>(json).display_name,
                Is.EqualTo("night-fox")
            );
        }

        [Test]
        public void CodeOnlyLobbyCopyMatchesTheJoinTransport()
        {
            string realtimeRoot = Path.Combine(
                Application.dataPath,
                "HiveChameleon",
                "Runtime",
                "Realtime"
            );
            string menu = File.ReadAllText(
                Path.Combine(realtimeRoot, "DevelopmentLobbyPanel.cs")
            );
            string models = File.ReadAllText(
                Path.Combine(realtimeRoot, "LobbyModels.cs")
            );

            Assert.That(
                menu,
                Does.Contain(
                    "private static readonly string[] VisibilityOptions = { \"OPEN\", \"PRIVATE\" };"
                )
            );
            Assert.That(models, Does.Contain("join_source = \"access_code\";"));
            Assert.That(menu, Does.Not.Contain("{ \"PUBLIC\", \"PRIVATE\" }"));
        }

        [Test]
        public void ReleaseBuildAcceptsOnlyPageIssuedRuntimeCredentials()
        {
            string runtimeRoot = Path.Combine(
                Application.dataPath,
                "HiveChameleon",
                "Runtime"
            );
            string bootstrap = File.ReadAllText(
                Path.Combine(runtimeRoot, "Bootstrap.cs")
            );
            string realtime = File.ReadAllText(
                Path.Combine(
                    runtimeRoot,
                    "Realtime",
                    "DevelopmentRealtimeBootstrap.cs"
                )
            );
            string developmentCredentials = File.ReadAllText(
                Path.Combine(
                    runtimeRoot,
                    "Realtime",
                    "AuthoritativeDevelopmentCredentials.cs"
                )
            );
            string lobby = File.ReadAllText(
                Path.Combine(
                    runtimeRoot,
                    "Realtime",
                    "DevelopmentLobbyPanel.cs"
                )
            );

            Assert.That(
                bootstrap,
                Does.Contain("gameObject.AddComponent<DevelopmentRealtimeBootstrap>();")
            );
            Assert.That(
                bootstrap,
                Does.Not.Contain("#if UNITY_EDITOR || DEVELOPMENT_BUILD")
            );
            Assert.That(
                realtime.TrimStart(),
                Does.StartWith("using System;")
            );
            Assert.That(
                lobby.TrimStart(),
                Does.StartWith("using System;")
            );
            Assert.That(
                developmentCredentials,
                Does.Contain("#if UNITY_EDITOR || DEVELOPMENT_BUILD")
            );
            Assert.That(
                developmentCredentials,
                Does.Contain("#if !UNITY_EDITOR")
            );
            Assert.That(
                developmentCredentials,
                Does.Contain("--hc-authoritative-runtime")
            );
            Assert.That(
                realtime,
                Does.Contain("AuthoritativeDevelopmentCredentials.TryResolve(")
            );
        }

        [Test]
        public void MatchStateFromAnotherJoinedMatchIsIgnored()
        {
            const string joinedMatchId = "joined-match";
            var connection = CreateJoinedConnection(joinedMatchId);
            int lobbyEvents = 0;
            connection.LobbyStateChanged += _ => lobbyEvents++;
            var lobby = new LobbySnapshot
            {
                id = "0199abc1-2345-7abc-bdef-0123456789af",
                name = "Authoritative Lobby",
            };

            ApplyMatchState(connection, "previous-match", 1, lobby);

            Assert.That(connection.CurrentLobby, Is.Null);
            Assert.That(lobbyEvents, Is.Zero);

            ApplyMatchState(connection, joinedMatchId, 1, lobby);

            Assert.That(connection.CurrentLobby, Is.Not.Null);
            Assert.That(connection.CurrentLobby.id, Is.EqualTo(lobby.id));
            Assert.That(lobbyEvents, Is.EqualTo(1));
        }

        [Test]
        public void NewRoundClearsPrivateStateAndLatePacketsAreIgnored()
        {
            const string matchId = "joined-match";
            var connection = CreateJoinedConnection(matchId);
            ApplyMatchState(
                connection,
                matchId,
                3,
                BuildRound(FirstRoundId, 1, "hunting")
            );
            ApplyMatchState(
                connection,
                matchId,
                2,
                new RoundRoleAssignment
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    initial_role = "hunter",
                    role = "hunter",
                }
            );
            Assert.That(connection.CurrentRoleAssignment, Is.Not.Null);

            ApplyMatchState(
                connection,
                matchId,
                3,
                BuildRound(SecondRoundId, 2, "preparing")
            );

            Assert.That(connection.CurrentRound.id, Is.EqualTo(SecondRoundId));
            Assert.That(connection.CurrentRoleAssignment, Is.Null);

            int avatarEvents = 0;
            connection.AvatarStateReceived += _ => avatarEvents++;
            ApplyMatchState(
                connection,
                matchId,
                2,
                new RoundRoleAssignment
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    initial_role = "hunter",
                    role = "hunter",
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                4,
                new RoundDiscoverySnapshot
                {
                    round_id = FirstRoundId,
                    hunter_player_id = HostPlayerId,
                    hider_player_id = GuestPlayerId,
                    sequence = 1,
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                5,
                new RoundPlayerState
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    initial_role = "hunter",
                    role = "hunter",
                    status = "active",
                    shells_remaining = 6,
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                6,
                new HunterFireResult
                {
                    round_id = FirstRoundId,
                    reason = "miss",
                    shells_remaining = 5,
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                7,
                new SpectatorStateSnapshot { round_id = FirstRoundId }
            );
            ApplyMatchState(
                connection,
                matchId,
                8,
                new RoundScoreSnapshot
                {
                    round_id = FirstRoundId,
                    scoring_rule_version = "scoring-1",
                    batch_sequence = 1,
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                9,
                new AnswerCheckSnapshot
                {
                    round_id = FirstRoundId,
                    deadline = "2026-07-29T12:00:00Z",
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                12,
                new AnswerCheckLikeResult
                {
                    round_id = FirstRoundId,
                    reason = "accepted",
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                13,
                new RoundReconnectSnapshot
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    status = "restored",
                    outcome_preserved = true,
                }
            );
            ApplyMatchState(
                connection,
                matchId,
                15,
                new AvatarStateSnapshot
                {
                    round_id = FirstRoundId,
                    player_id = GuestPlayerId,
                    role = "hider",
                    status = "active",
                    sequence = 1,
                }
            );

            Assert.That(connection.CurrentRoleAssignment, Is.Null);
            Assert.That(connection.CurrentRoundPlayerState, Is.Null);
            Assert.That(connection.LastDiscovery, Is.Null);
            Assert.That(connection.LastFireResult, Is.Null);
            Assert.That(connection.CurrentSpectatorState, Is.Null);
            Assert.That(connection.CurrentScores, Is.Null);
            Assert.That(connection.CurrentAnswerCheck, Is.Null);
            Assert.That(connection.LastLikeResult, Is.Null);
            Assert.That(connection.CurrentReconnectState, Is.Null);
            Assert.That(avatarEvents, Is.Zero);

            ApplyMatchState(
                connection,
                matchId,
                2,
                new RoundRoleAssignment
                {
                    round_id = SecondRoundId,
                    player_id = HostPlayerId,
                    initial_role = "hider",
                    role = "hider",
                }
            );
            Assert.That(
                connection.CurrentRoleAssignment.round_id,
                Is.EqualTo(SecondRoundId)
            );

            ApplyMatchState(
                connection,
                matchId,
                3,
                BuildRound(SecondRoundId, 2, "hunting")
            );
            Assert.That(connection.CurrentRound.status, Is.EqualTo("hunting"));

            ApplyMatchState(
                connection,
                matchId,
                3,
                BuildRound(FirstRoundId, 1, "answer_check")
            );
            Assert.That(connection.CurrentRound.id, Is.EqualTo(SecondRoundId));
            Assert.That(connection.CurrentRound.status, Is.EqualTo("hunting"));
            Assert.That(
                connection.CurrentRoleAssignment.round_id,
                Is.EqualTo(SecondRoundId)
            );
        }

        [Test]
        public void JoiningWindowAcceptsOnlyTheExplicitlyExpectedMatch()
        {
            const string expectedMatchId = "joining-match";
            var connection = new NakamaRealtimeConnection("test-server-key");
            FieldInfo expectedField = typeof(NakamaRealtimeConnection).GetField(
                "_expectedJoiningMatchId",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            Assert.That(expectedField, Is.Not.Null);
            expectedField.SetValue(connection, expectedMatchId);
            var lobby = new LobbySnapshot
            {
                id = "0199abc1-2345-7abc-bdef-0123456789af",
                name = "Joining Lobby",
            };

            ApplyMatchState(connection, "unrelated-match", 1, lobby);
            Assert.That(connection.CurrentLobby, Is.Null);

            ApplyMatchState(connection, expectedMatchId, 1, lobby);
            Assert.That(connection.CurrentLobby, Is.Not.Null);
            Assert.That(connection.CurrentLobby.id, Is.EqualTo(lobby.id));
        }

        [Test]
        public void PrivateAvatarCorrectionMayRepeatTheAcceptedLocalSequence()
        {
            const string matchId = "joined-match";
            var connection = CreateJoinedConnection(matchId);
            ApplyMatchState(
                connection,
                matchId,
                3,
                BuildRound(FirstRoundId, 1, "hunting")
            );
            ApplyMatchState(
                connection,
                matchId,
                5,
                new RoundPlayerState
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    initial_role = "hunter",
                    role = "hunter",
                    status = "active",
                }
            );

            int avatarEvents = 0;
            bool lastWasCorrection = false;
            connection.AvatarStateReceived += avatar =>
            {
                avatarEvents++;
                lastWasCorrection = avatar.correction;
            };
            var accepted = new AvatarStateSnapshot
            {
                round_id = FirstRoundId,
                player_id = HostPlayerId,
                role = "hunter",
                status = "active",
                sequence = 4,
                pitch = 12f,
            };
            ApplyMatchState(connection, matchId, 15, accepted);
            ApplyMatchState(
                connection,
                matchId,
                15,
                new AvatarStateSnapshot
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    role = "hunter",
                    status = "active",
                    sequence = 4,
                    pitch = 12f,
                    correction = true,
                }
            );
            ApplyMatchState(connection, matchId, 15, accepted);

            Assert.That(avatarEvents, Is.EqualTo(2));
            Assert.That(lastWasCorrection, Is.True);
        }

        [Test]
        public void SpectatorAndPlayerControlRequireCurrentServerAuthority()
        {
            RoundSnapshot round = BuildRound(
                FirstRoundId,
                1,
                "hunting"
            );
            var activeHider = new RoundPlayerState
            {
                round_id = FirstRoundId,
                player_id = HostPlayerId,
                role = "hider",
                status = "active",
            };
            var eligibleSpectator = new SpectatorStateSnapshot
            {
                round_id = FirstRoundId,
                eligible = true,
                camera_modes = new[] { "third_person" },
            };

            Assert.That(
                LobbyMenuRules.HasPlayerControlAuthority(
                    round,
                    activeHider,
                    null
                ),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.IsEligibleSpectator(round, eligibleSpectator),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.HasPlayerControlAuthority(
                    round,
                    activeHider,
                    eligibleSpectator
                ),
                Is.False
            );

            activeHider.status = "found";
            Assert.That(
                LobbyMenuRules.HasPlayerControlAuthority(
                    round,
                    activeHider,
                    null
                ),
                Is.False,
                "A found player must wait for authoritative spectator eligibility without retaining control."
            );

            activeHider.status = "active";
            round.status = "answer_check";
            Assert.That(
                LobbyMenuRules.HasPlayerControlAuthority(
                    round,
                    activeHider,
                    null
                ),
                Is.False
            );
            activeHider.role = "hunter";
            Assert.That(
                LobbyMenuRules.HasPlayerControlAuthority(
                    round,
                    activeHider,
                    null
                ),
                Is.True
            );

            eligibleSpectator.round_id = SecondRoundId;
            Assert.That(
                LobbyMenuRules.IsEligibleSpectator(round, eligibleSpectator),
                Is.False
            );
        }

        [Test]
        public void UnsupportedLobbyAutomationStaysOutOfThePlayerUi()
        {
            string source = File.ReadAllText(
                Path.Combine(
                    Application.dataPath,
                    "HiveChameleon",
                    "Runtime",
                    "Realtime",
                    "DevelopmentLobbyPanel.cs"
                )
            );

            Assert.That(source, Does.Not.Contain("Enable periodic taunts"));
            Assert.That(source, Does.Not.Contain("TAUNT INTERVAL"));
            Assert.That(source, Does.Not.Contain("Start automatically"));
            Assert.That(source, Does.Not.Contain("AUTO-START PLAYERS"));

            var snapshot = new LobbyConfigurationSnapshot
            {
                taunt_enabled = false,
                taunt_interval_seconds = 47,
                auto_start_enabled = false,
                auto_start_threshold = 9,
            };
            LobbyConfigurationDraft preserved =
                LobbyConfigurationDraft.FromSnapshot(snapshot);
            Assert.That(preserved.TauntEnabled, Is.False);
            Assert.That(preserved.TauntIntervalSeconds, Is.EqualTo(47));
            Assert.That(preserved.AutoStartEnabled, Is.False);
            Assert.That(preserved.AutoStartThreshold, Is.EqualTo(9));
        }

        [Test]
        public void FailedMatchJoinRollbackReturnsTheClientHome()
        {
            var connection = new NakamaRealtimeConnection("test-server-key");
            SetPrivateProperty(
                connection,
                "CurrentLobby",
                new LobbySnapshot
                {
                    id = "0199abc1-2345-7abc-bdef-0123456789af",
                    name = "Half Joined Lobby",
                }
            );
            SetPrivateProperty(
                connection,
                "CurrentRound",
                BuildRound(FirstRoundId, 1, "hunting")
            );
            SetPrivateProperty(
                connection,
                "CurrentRoleAssignment",
                new RoundRoleAssignment
                {
                    round_id = FirstRoundId,
                    player_id = HostPlayerId,
                    role = "hunter",
                }
            );
            int lobbyEvents = 0;
            LobbySnapshot lastLobby = new LobbySnapshot();
            connection.LobbyStateChanged += lobby =>
            {
                lobbyEvents++;
                lastLobby = lobby;
            };

            MethodInfo rollback = typeof(NakamaRealtimeConnection).GetMethod(
                "RollbackFailedLobbyJoinAsync",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            Assert.That(rollback, Is.Not.Null);
            var task = (Task)rollback.Invoke(
                connection,
                new object[]
                {
                    "0199abc1-2345-7abc-bdef-0123456789af",
                }
            );
            task.GetAwaiter().GetResult();

            Assert.That(connection.CurrentLobby, Is.Null);
            Assert.That(connection.CurrentRound, Is.Null);
            Assert.That(connection.CurrentRoleAssignment, Is.Null);
            Assert.That(lobbyEvents, Is.EqualTo(1));
            Assert.That(lastLobby, Is.Null);

            string source = File.ReadAllText(
                Path.Combine(
                    Application.dataPath,
                    "HiveChameleon",
                    "Runtime",
                    "Realtime",
                    "NakamaRealtimeConnection.cs"
                )
            );
            Assert.That(
                CountOccurrences(
                    source,
                    "await JoinLobbyMatchOrRollbackAsync(response, cancellationToken);"
                ),
                Is.EqualTo(2)
            );
        }

        private static NakamaRealtimeConnection CreateJoinedConnection(
            string matchId
        )
        {
            var connection = new NakamaRealtimeConnection("test-server-key");
            FieldInfo matchField = typeof(NakamaRealtimeConnection).GetField(
                "_match",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            Assert.That(matchField, Is.Not.Null);
            Type matchType = matchField.FieldType.Assembly.GetType(
                "Nakama.Match",
                true
            );
            object match = Activator.CreateInstance(matchType, true);
            PropertyInfo idProperty = matchType.GetProperty(
                "Id",
                BindingFlags.Instance | BindingFlags.Public
            );
            Assert.That(idProperty, Is.Not.Null);
            idProperty.SetValue(match, matchId);
            matchField.SetValue(connection, match);
            return connection;
        }

        private static void ApplyMatchState(
            NakamaRealtimeConnection connection,
            string matchId,
            long opcode,
            object payload
        )
        {
            MethodInfo handler = typeof(NakamaRealtimeConnection).GetMethod(
                "HandleMatchState",
                BindingFlags.Instance | BindingFlags.NonPublic
            );
            Assert.That(handler, Is.Not.Null);
            Type matchStateType = handler
                .GetParameters()[0]
                .ParameterType.Assembly.GetType("Nakama.MatchState", true);
            object matchState = Activator.CreateInstance(matchStateType, true);
            SetPublicProperty(matchStateType, matchState, "MatchId", matchId);
            SetPublicProperty(
                matchStateType,
                matchState,
                "OpCodeField",
                opcode.ToString()
            );
            SetPublicProperty(
                matchStateType,
                matchState,
                "StateField",
                Convert.ToBase64String(
                    Encoding.UTF8.GetBytes(JsonUtility.ToJson(payload))
                )
            );
            handler.Invoke(
                connection,
                new[] { matchState }
            );
        }

        private static void SetPublicProperty(
            Type type,
            object instance,
            string propertyName,
            object value
        )
        {
            PropertyInfo property = type.GetProperty(
                propertyName,
                BindingFlags.Instance | BindingFlags.Public
            );
            Assert.That(property, Is.Not.Null);
            property.SetValue(instance, value);
        }

        private static void SetPrivateProperty(
            object instance,
            string propertyName,
            object value
        )
        {
            PropertyInfo property = instance.GetType().GetProperty(
                propertyName,
                BindingFlags.Instance | BindingFlags.Public
            );
            Assert.That(property, Is.Not.Null);
            MethodInfo setter = property.GetSetMethod(true);
            Assert.That(setter, Is.Not.Null);
            setter.Invoke(instance, new[] { value });
        }

        private static int CountOccurrences(string source, string value)
        {
            int count = 0;
            int offset = 0;
            while (
                (offset = source.IndexOf(
                    value,
                    offset,
                    StringComparison.Ordinal
                )) >= 0
            )
            {
                count++;
                offset += value.Length;
            }
            return count;
        }

        private static RoundSnapshot BuildRound(
            string id,
            int sequenceNumber,
            string status
        )
        {
            return new RoundSnapshot
            {
                id = id,
                sequence_number = sequenceNumber,
                mode = "casual",
                map_version_id = MapVersionId,
                map_slug = AuthoritativeArenaCatalog.NeonServiceArcadeSlug,
                map_display_name =
                    AuthoritativeArenaCatalog.NeonServiceArcadeDisplayName,
                map_content_version =
                    AuthoritativeArenaCatalog.NeonServiceArcadeContentVersion,
                game_server_build_version =
                    LobbyMenuRules.SupportedGameServerBuildVersion,
                protocol_version =
                    LobbyMenuRules.SupportedProtocolVersion,
                authority_geometry_version =
                    AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryVersion,
                authority_geometry_digest =
                    AuthoritativeArenaCatalog.NeonServiceArcadeAuthorityGeometryDigest,
                status = status,
            };
        }

        private static LobbySnapshot BuildLobby(
            int memberCount,
            int hunterCount,
            string mapVersionId
        )
        {
            var members = new LobbyMemberSnapshot[memberCount];
            for (int index = 0; index < members.Length; index++)
            {
                members[index] = new LobbyMemberSnapshot
                {
                    player_id = index == 0
                        ? HostPlayerId
                        : index == 1
                            ? GuestPlayerId
                            : $"0199abc1-2345-7abc-8def-{index + 10:000000000000}",
                    display_name = index == 0
                        ? "host-player"
                        : $"player-{index + 1:00}",
                };
            }

            return new LobbySnapshot
            {
                id = "0199abc1-2345-7abc-bdef-0123456789af",
                name = "Test Lobby",
                max_players = 10,
                current_host_player_id = HostPlayerId,
                members = members,
                configuration = new LobbyConfigurationSnapshot
                {
                    mode = "casual",
                    map_version_id = mapVersionId,
                    hunter_count = hunterCount,
                    hiding_duration_seconds = 60,
                    hunting_duration_seconds = 180,
                    shell_limit = 6,
                    reload_duration_ms = 2000,
                    auto_start_threshold = 7,
                    row_version = 1,
                },
            };
        }

    }
}
