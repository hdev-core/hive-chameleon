using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using HiveChameleon.Painting;
using HiveChameleon.Presentation;
using HiveChameleon.Realtime;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HiveChameleon.Tests
{
    public sealed class CorrectedRoundPresentationTests
    {
        private const BindingFlags DeclaredMembers =
            BindingFlags.Public
            | BindingFlags.NonPublic
            | BindingFlags.Instance
            | BindingFlags.Static
            | BindingFlags.DeclaredOnly;

        private readonly List<GameObject> _createdObjects = new List<GameObject>();

        [Test]
        public void RuntimePresentationContainsNoPreviewOrSyntheticEntryPoints()
        {
            Type[] playerFacingTypes =
            {
                typeof(OfficialArenaExperience),
                typeof(DevelopmentRealtimeBootstrap),
                typeof(DevelopmentLobbyPanel),
            };
            string[] forbiddenIdentifierFragments =
            {
                "preview",
                "fake",
                "synthetic",
            };

            foreach (Type type in playerFacingTypes)
            {
                string[] offenders = type
                    .GetMembers(DeclaredMembers)
                    .Select(member => member.Name)
                    .Where(
                        name =>
                            forbiddenIdentifierFragments.Any(
                                fragment =>
                                    name.IndexOf(
                                        fragment,
                                        StringComparison.OrdinalIgnoreCase
                                    ) >= 0
                            )
                    )
                    .ToArray();
                Assert.That(
                    offenders,
                    Is.Empty,
                    $"{type.Name} still exposes non-authoritative entry points."
                );
            }

            string runtimeRoot = Path.Combine(
                Application.dataPath,
                "HiveChameleon",
                "Runtime"
            );
            foreach (
                string sourcePath in Directory.GetFiles(
                    runtimeRoot,
                    "*.cs",
                    SearchOption.AllDirectories
                )
            )
            {
                if (
                    sourcePath.Contains(
                        Path.DirectorySeparatorChar + "Painting" + Path.DirectorySeparatorChar,
                        StringComparison.Ordinal
                    )
                )
                {
                    // Material previews are a real in-match editor feature. This guard targets
                    // the retired offline/synthetic gameplay mode, not ordinary rendering terms.
                    continue;
                }
                string source = File.ReadAllText(sourcePath);
                foreach (string fragment in forbiddenIdentifierFragments)
                {
                    Assert.That(
                        source.IndexOf(
                            fragment,
                            StringComparison.OrdinalIgnoreCase
                        ),
                        Is.LessThan(0),
                        $"{Path.GetFileName(sourcePath)} contains '{fragment}'."
                    );
                }
            }
        }

        [Test]
        public void ArenaAndHudAreGatedByAuthoritativeRoundState()
        {
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-8def-0123456789ab",
                        map_version_id =
                            "0199abc1-2345-7abc-adef-0123456789ad",
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
                        status = "hunting",
                    }
                ),
                Is.True
            );
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = "0199abc1-2345-7abc-8def-0123456789ab",
                        status = "lobby",
                    }
                ),
                Is.False
            );
            Assert.That(
                LobbyMenuRules.IsGameplayRound(
                    new RoundSnapshot
                    {
                        id = string.Empty,
                        status = "hunting",
                    }
                ),
                Is.False
            );

            PropertyInfo gate = typeof(OfficialArenaExperience).GetProperty(
                nameof(OfficialArenaExperience.HasAuthoritativeRound),
                DeclaredMembers
            );
            Assert.That(gate, Is.Not.Null);
            Assert.That(gate.CanWrite, Is.False);

            string compactSource = CompactSource(
                ReadRuntimeSource(
                    "Presentation",
                    "OfficialArenaExperience.cs"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "_connection.State!=RealtimeConnectionState.Connected"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "LobbyMenuRules.HasCompatibleMap(_connection.CurrentRound)"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "if(!HasAuthoritativeRound){EnterDormantState();return;}"
                ),
                "Update must stop the arena before processing local gameplay."
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "privatevoidAwake(){Application.targetFrameRate=60;}"
                ),
                "Awake must not construct an arena before a server round exists."
            );
            Assert.That(
                compactSource,
                Does.Contain("BuildExperience();if(_map==null"),
                "The arena must be constructed lazily after the authority gate."
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "privatevoidActivateArena(){if(!HasAuthoritativeRound){EnterDormantState();return;}BuildExperience();"
                ),
                "Event callbacks must not activate the arena around the authority gate."
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "privatevoidOnDisable(){_pauseOpen=false;_pauseStatus=string.Empty;EnterDormantState();}"
                ),
                "Disconnecting or leaving gameplay must return the arena to a dormant state."
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "privatevoidOnGUI(){if(!HasAuthoritativeRound){return;}"
                ),
                "The round HUD must not render without an authoritative round."
            );
            Assert.That(
                compactSource,
                Does.Contain("_controller.enabled=false;")
            );
        }

        [UnityTest]
        public IEnumerator AnswerCheckRevealFlashesInWorldWithNameAndOutcome()
        {
            CamouflagedPlayerAvatar avatar = CreateAvatar(
                "0199abc1-2345-7abc-8def-0123456789ab",
                "Aria",
                "hider",
                new Color(0.22f, 0.33f, 0.44f),
                new Color(0.7f, 0.55f, 0.16f)
            );
            CapsuleCollider hitbox = avatar.GetComponent<CapsuleCollider>();
            TextMesh nameplate = avatar
                .GetComponentsInChildren<TextMesh>(true)
                .Single();

            Assert.That(hitbox.enabled, Is.True);
            Assert.That(nameplate.gameObject.activeSelf, Is.False);
            Assert.That(nameplate.GetComponentInParent<Canvas>(), Is.Null);

            avatar.SetReveal(true, true);
            avatar.SetTargetable(false);
            Color foundStart = ReadBodyOverride(avatar);

            Assert.That(hitbox.enabled, Is.False);
            Assert.That(nameplate.gameObject.activeSelf, Is.True);
            Assert.That(nameplate.text, Is.EqualTo("Aria\nFOUND"));
            Assert.That(foundStart.b, Is.GreaterThan(foundStart.r));

            yield return new WaitForSecondsRealtime(0.16f);

            Color foundLater = ReadBodyOverride(avatar);
            Assert.That(
                ColorDistance(foundStart, foundLater),
                Is.GreaterThan(0.005f),
                "A found Hider must visibly flash in the 3D world."
            );

            avatar.SetReveal(false, false);
            Assert.That(nameplate.gameObject.activeSelf, Is.False);

            avatar.SetStatus("active");
            avatar.SetReveal(true, false);
            avatar.SetTargetable(false);
            Color unfoundStart = ReadBodyOverride(avatar);

            Assert.That(nameplate.gameObject.activeSelf, Is.True);
            Assert.That(nameplate.text, Is.EqualTo("Aria\nUNFOUND"));
            Assert.That(unfoundStart.r, Is.GreaterThan(unfoundStart.b));

            yield return new WaitForSecondsRealtime(0.19f);

            Color unfoundLater = ReadBodyOverride(avatar);
            Assert.That(
                ColorDistance(unfoundStart, unfoundLater),
                Is.GreaterThan(0.005f),
                "An unfound Hider must visibly flash in the 3D world."
            );
        }

        [Test]
        public void InfectionConversionShowsHunterAndRemovesHiderTargetability()
        {
            Color body = new Color(0.22f, 0.33f, 0.44f);
            Color accent = new Color(0.7f, 0.55f, 0.16f);
            CamouflagedPlayerAvatar avatar = CreateAvatar(
                "0199abc1-2345-7abc-8def-0123456789ab",
                "Aria",
                "hider",
                body,
                accent
            );
            CapsuleCollider hitbox = avatar.GetComponent<CapsuleCollider>();
            Transform hiderArt = avatar
                .GetComponentsInChildren<Transform>(true)
                .Single(value => value.name == "Hider character");
            Transform hunterArt = avatar
                .GetComponentsInChildren<Transform>(true)
                .Single(value => value.name == "Hunter character");
            TextMesh nameplate = avatar
                .GetComponentsInChildren<TextMesh>(true)
                .Single();

            Assert.That(hiderArt.gameObject.activeSelf, Is.True);
            Assert.That(hunterArt.gameObject.activeSelf, Is.False);
            Assert.That(hitbox.enabled, Is.True);

            avatar.SetStatus("converted");
            avatar.SetRole("hunter");
            avatar.SetNameplate(true, "CONVERTED");

            Assert.That(avatar.Role, Is.EqualTo("hunter"));
            Assert.That(avatar.Status, Is.EqualTo("converted"));
            Assert.That(avatar.IsFound, Is.True);
            Assert.That(hiderArt.gameObject.activeSelf, Is.False);
            Assert.That(hunterArt.gameObject.activeSelf, Is.True);
            Assert.That(hitbox.enabled, Is.False);
            Assert.That(nameplate.gameObject.activeSelf, Is.True);
            Assert.That(nameplate.text, Is.EqualTo("Aria\nCONVERTED"));
            Assert.That(avatar.BodyColor, Is.EqualTo(body));
            Assert.That(avatar.AccentColor, Is.EqualTo(accent));
        }

        [Test]
        public void ScoreboardUsesUpToTenAuthoritativeRowsWithoutFallbackPlayers()
        {
            var scores = new RoundScoreSnapshot
            {
                round_id = "0199abc1-2345-7abc-8def-0123456789ab",
                scoring_rule_version = "scoring-1",
                entries = Enumerable
                    .Range(0, 10)
                    .Select(
                        index =>
                            new RoundScoreEntry
                            {
                                player_id =
                                    $"0199abc1-2345-7abc-8def-{index + 1:000000000000}",
                                display_name = $"player-{index + 1:00}",
                                rank = index + 1,
                                total = $"{1000 - index * 10}.0000",
                                breakdown = new RoundScoreBreakdown
                                {
                                    total = 1000 - index * 10,
                                },
                            }
                    )
                    .ToArray(),
            };

            Assert.That(scores.entries, Has.Length.EqualTo(10));
            Assert.That(
                scores.entries.Select(entry => entry.player_id).Distinct().Count(),
                Is.EqualTo(10)
            );
            Assert.That(
                scores.entries.Select(entry => entry.display_name),
                Is.All.Not.Empty
            );

            MethodInfo scoreboard = typeof(OfficialArenaExperience).GetMethod(
                "DrawScoreboard",
                DeclaredMembers
            );
            Assert.That(scoreboard, Is.Not.Null);

            string source = ReadRuntimeSource(
                "Presentation",
                "OfficialArenaExperience.cs"
            );
            string compactSource = CompactSource(source);
            Assert.That(
                compactSource,
                Does.Contain(
                    "intcount=Mathf.Min(10,scores.entries.Length);"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "RoundScoreEntryentry=scores.entries[index];"
                ),
                "Scoreboard rows must come from the authoritative snapshot."
            );
            Assert.That(compactSource, Does.Contain("entry.display_name"));
            Assert.That(source, Does.Not.Contain("HUNTER-ALPHA"));
            Assert.That(source, Does.Not.Contain("HIDER-01"));
            Assert.That(source, Does.Not.Contain("HIDER-02"));
        }

        [Test]
        public void SpectatorCameraControlsAreGuardedBySpectatorEligibility()
        {
            Type arenaType = typeof(OfficialArenaExperience);
            Assert.That(
                arenaType.GetProperty("IsSpectating", DeclaredMembers),
                Is.Not.Null
            );
            Assert.That(
                arenaType.GetMethod("UpdateSpectatorCamera", DeclaredMembers),
                Is.Not.Null
            );
            Assert.That(
                arenaType.GetMethod("DrawSpectatorHud", DeclaredMembers),
                Is.Not.Null
            );
            Assert.That(
                arenaType.GetMethod("SetSpectatorCameraMode", DeclaredMembers),
                Is.Not.Null
            );
            Assert.That(
                arenaType.GetProperty(
                    "HasPlayerControlAuthority",
                    DeclaredMembers
                ),
                Is.Not.Null
            );

            string source = ReadRuntimeSource(
                "Presentation",
                "OfficialArenaExperience.cs"
            );
            string compactSource = CompactSource(
                source
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "LobbyMenuRules.IsEligibleSpectator(_connection?.CurrentRound,_connection?.CurrentSpectatorState)"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "if(IsSpectating){UpdateSpectatorCamera();}else{UpdatePlayer();}"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain(
                    "if(IsSpectating){DrawSpectatorHud(width,height);}"
                )
            );
            Assert.That(compactSource, Does.Contain("SetSpectatorCameraMode(0);"));
            Assert.That(compactSource, Does.Contain("SetSpectatorCameraMode(1);"));
            Assert.That(compactSource, Does.Contain("SetSpectatorCameraMode(2);"));
            Assert.That(compactSource, Does.Contain("camera_modes"));
            Assert.That(compactSource, Does.Contain("visible_hider_player_ids"));
            Assert.That(compactSource, Does.Contain("visible_player_name_ids"));
            Assert.That(
                compactSource,
                Does.Contain("IsVisibleSpectatorPlayer(spectatorPlayer)")
            );
            Assert.That(
                source,
                Does.Not.Contain(
                    "CurrentRoundPlayerState?.status == \"found\""
                )
            );
        }

        [Test]
        public void AnswerCheckLikesRequireAnAuthoritativeHiderReveal()
        {
            Type arenaType = typeof(OfficialArenaExperience);
            Assert.That(
                arenaType.GetMethod(
                    "CanLikeAnswerCheckCandidate",
                    DeclaredMembers
                ),
                Is.Not.Null
            );

            string compactSource = CompactSource(
                ReadRuntimeSource(
                    "Presentation",
                    "OfficialArenaExperience.cs"
                )
            );
            Assert.That(
                compactSource,
                Does.Contain("reveal.player_id==candidate.PlayerId")
            );
            Assert.That(compactSource, Does.Not.Contain("candidate.Role!=\"hider\""));
        }

        [Test]
        public void EscapeMenuProvidesProfessionalResumeAndLeaveFlow()
        {
            Type arenaType = typeof(OfficialArenaExperience);
            Assert.That(
                arenaType.GetMethod("DrawPauseOverlay", DeclaredMembers),
                Is.Not.Null
            );
            Assert.That(
                arenaType.GetMethod("LeaveLobbyFromPause", DeclaredMembers),
                Is.Not.Null
            );

            string arena = ReadRuntimeSource(
                "Presentation",
                "OfficialArenaExperience.cs"
            );
            string bootstrap = ReadRuntimeSource(
                "Realtime",
                "DevelopmentRealtimeBootstrap.cs"
            );
            Assert.That(arena, Does.Contain("KeyCode.Escape"));
            Assert.That(arena, Does.Contain("\"RESUME\""));
            Assert.That(arena, Does.Contain("\"LEAVE LOBBY\""));
            Assert.That(arena, Does.Contain("#if UNITY_STANDALONE && !UNITY_EDITOR"));
            Assert.That(bootstrap, Does.Contain("LeaveActiveLobbyAsync"));
            Assert.That(
                bootstrap,
                Does.Contain(
                    "_experience.Initialize(\n                    _connection,\n                    _shutdown.Token,\n                    LeaveActiveLobbyAsync"
                )
            );
        }

        [Test]
        public void HunterFeedbackHasNoCenterStatusChannel()
        {
            Type arenaType = typeof(OfficialArenaExperience);
            FieldInfo[] fields = arenaType.GetFields(DeclaredMembers);
            Assert.That(
                fields.Any(
                    field =>
                        string.Equals(
                            field.Name,
                            "_status",
                            StringComparison.OrdinalIgnoreCase
                        )
                        || field.Name.IndexOf(
                            "centerStatus",
                            StringComparison.OrdinalIgnoreCase
                        ) >= 0
                ),
                Is.False
            );
            Assert.That(
                arenaType.GetMethod("DrawBottomHud", DeclaredMembers),
                Is.Null
            );
            Assert.That(
                arenaType.GetMethod("DrawCenterStatus", DeclaredMembers),
                Is.Null
            );
            Assert.That(
                arenaType.GetMethod("DrawStatusMessage", DeclaredMembers),
                Is.Null
            );

            string source = ReadRuntimeSource(
                "Presentation",
                "OfficialArenaExperience.cs"
            );
            string[] forbiddenPlayerMessages =
            {
                "\"Miss.\"",
                "\"Shot registered",
                "\"Find the camouflaged",
                "\"Body paint changed.\"",
                "\"Environment color sampled.\"",
            };
            foreach (string message in forbiddenPlayerMessages)
            {
                Assert.That(source, Does.Not.Contain(message));
            }
        }

        [Test]
        public void HiderUsesDedicatedPaintEditorWithoutLegacyAccentControls()
        {
            string source = ReadRuntimeSource(
                "Presentation",
                "OfficialArenaExperience.cs"
            );

            Assert.That(source, Does.Contain("PlayerPaintMode"));
            Assert.That(source, Does.Not.Contain("CAMOUFLAGE PALETTE"));
            Assert.That(source, Does.Not.Contain("CamouflagePalette"));
            Assert.That(source, Does.Not.Contain("AccentPalette"));
            Assert.That(source, Does.Not.Contain("CycleAccentColor"));
            Assert.That(source, Does.Not.Contain("KeyCode.Z"));
            Assert.That(source, Does.Not.Contain("KeyCode.X"));
            Assert.That(source, Does.Not.Contain("\"ACCENT\""));
        }

        [Test]
        public void WorldNameplatesNeverExposeOpaquePlayerIdentifiers()
        {
            const string playerId =
                "0199abc1-2345-7abc-8def-0123456789ab";
            CamouflagedPlayerAvatar avatar = CreateAvatar(
                playerId,
                playerId,
                "hider",
                new Color(0.22f, 0.33f, 0.44f),
                new Color(0.7f, 0.55f, 0.16f)
            );
            TextMesh nameplate = avatar
                .GetComponentsInChildren<TextMesh>(true)
                .Single();

            avatar.SetReveal(true, false);

            Assert.That(avatar.DisplayName, Is.EqualTo("Player"));
            Assert.That(nameplate.text, Is.EqualTo("Player\nUNFOUND"));
            Assert.That(nameplate.text, Does.Not.Contain(playerId));
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            for (int index = _createdObjects.Count - 1; index >= 0; index--)
            {
                if (_createdObjects[index] != null)
                {
                    UnityEngine.Object.Destroy(_createdObjects[index]);
                }
            }
            _createdObjects.Clear();
            yield return null;
        }

        private CamouflagedPlayerAvatar CreateAvatar(
            string playerId,
            string displayName,
            string role,
            Color body,
            Color accent
        )
        {
            var avatarObject = new GameObject($"Test avatar // {displayName}");
            _createdObjects.Add(avatarObject);
            CamouflagedPlayerAvatar avatar =
                avatarObject.AddComponent<CamouflagedPlayerAvatar>();
            avatar.Configure(
                playerId,
                displayName,
                role,
                body,
                accent,
                false
            );
            return avatar;
        }

        private static Color ReadBodyOverride(
            CamouflagedPlayerAvatar avatar
        )
        {
            PaintableBody paintable = avatar.GetComponentInChildren<PaintableBody>(true);
            if (paintable != null && paintable.PresentationOverrideAmount > 0f)
            {
                return paintable.PresentationOverrideColor;
            }
            Renderer[] renderers = avatar.GetComponentsInChildren<Renderer>(true);
            var block = new MaterialPropertyBlock();
            for (int rendererIndex = 0; rendererIndex < renderers.Length; rendererIndex++)
            {
                Material[] materials = renderers[rendererIndex].sharedMaterials;
                for (int materialIndex = 0; materialIndex < materials.Length; materialIndex++)
                {
                    Material material = materials[materialIndex];
                    if (
                        material == null
                        || !material.name.Contains("HC Body White")
                    )
                    {
                        continue;
                    }
                    renderers[rendererIndex].GetPropertyBlock(
                        block,
                        materialIndex
                    );
                    return block.GetColor("_BaseColor");
                }
            }
            Assert.Fail("The humanoid has no body material to verify.");
            return Color.clear;
        }

        private static float ColorDistance(Color left, Color right)
        {
            return Mathf.Abs(left.r - right.r)
                + Mathf.Abs(left.g - right.g)
                + Mathf.Abs(left.b - right.b)
                + Mathf.Abs(left.a - right.a);
        }

        private static string ReadRuntimeSource(params string[] segments)
        {
            string path = Path.Combine(
                new[]
                {
                    Application.dataPath,
                    "HiveChameleon",
                    "Runtime",
                }.Concat(segments).ToArray()
            );
            Assert.That(File.Exists(path), Is.True, $"Missing source file: {path}");
            return File.ReadAllText(path);
        }

        private static string CompactSource(string source)
        {
            return new string(
                source.Where(character => !char.IsWhiteSpace(character)).ToArray()
            );
        }
    }
}
