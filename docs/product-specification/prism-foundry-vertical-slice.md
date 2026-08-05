# Chroma District official arena

Chroma District is the player-facing identity of Hive Chameleon's first
playable official arena. The stable backend and map-catalog slug remains
`prism-foundry` for compatibility; it is not the arena's display name or a
gameplay concept. The current bundled content version is `m4-4`.

## M4 gameplay boundary

The vertical slice demonstrates character camouflage and character
identification:

- A Hider remains a humanoid player character throughout the round.
- Hiders move through the map, repaint their own character, adjust supported
  material properties, select preset poses, and use position, silhouette,
  color, material, lighting, and the environment to camouflage themselves.
- Hunters search with an identification weapon and fire at actual Hider
  characters. A successful hit identifies that Hider; an incorrect or empty
  shot still consumes a shell and follows the normal reload rules.
- Buildings, street furniture, vegetation, and other map geometry are static,
  non-interactive cover and visual context. They are not disguises, target
  slots, hiding containers, or clickable inspection points.
- The Answer Check reveals the real Hider characters in their final positions:
  found Hiders are blue and unfound Hiders are red, with a non-color status cue
  for accessibility.

The word “Chameleon” describes the color-changing camouflage mechanic. Player
characters are not literal chameleons or animal-shaped avatars, and the game
does not depict tails, eye stalks, reptile bodies, or other animal features.

## Arena concept

Chroma District is a compact low-poly city block with readable streets,
crossings, plazas, towers, trees, and building edges. Its spaces provide
different colors, surface materials, lighting, sight lines, and silhouette
breaks so Hiders can make deliberate camouflage choices while remaining
physically present and discoverable.

The map defines traversal boundaries and separate Hunter and Hider spawn areas.
Location names such as West Crossing, Cafe Plaza, Park Edge, and Central
Towers are navigation cues only; no location has a special targeting or
inspection behavior.

## Character and weapon

The vertical slice uses an original humanoid character with a neutral,
faceless silhouette and separate surfaces suitable for repainting. The same
humanoid foundation supports Hider and Hunter presentation; Hunters carry the
identification weapon, while role and round state determine the available
actions.

The editable character and weapon source is stored in
`art/blender/HiveHumanoid.blend`, with Unity-ready exports and prefabs under:

- `clients/unity/Assets/HiveChameleon/Art/Models/`;
- `clients/unity/Assets/HiveChameleon/Resources/Characters/`.

External character references are design references only. No third-party
Meccha Chameleon character model, pose model, or literal chameleon model is
included in the playable content.

## Player experience

Desktop and WebGL share the core movement and camera controls:

- `WASD`: move;
- `Shift`: sprint;
- `Ctrl`: crouch;
- `Space`: jump;
- mouse: look;
- `C`: switch between eligible camera views;
- `Escape`: release the pointer.

Role-specific interaction is kept separate:

- a Hunter aims the weapon and fires at a Hider character;
- a Hider uses the available paint, material, eyedropper, and pose controls on
  their own character.

The Hunter view must not reveal a Hider through hover labels, target outlines,
object prompts, or other inspection aids. Map geometry never responds to a
Hunter click as a candidate hiding place.

The normal HUD is intentionally small: arena/role, phase timer, remaining
Hiders, ammunition, and role-specific controls. It never displays test
instructions, developer shortcuts, shot/miss prose, or tutorial-style objective
messages in the center of play. Hider HUD shows the active camouflage controls
without presenting them as developer tools. Authoritative score batches appear
briefly on the left at the server's 30-second live cadence and remain available
during Answer Check.

The arena never runs without an authenticated, authoritative Nakama round.
When a connection or session is unavailable, the player remains at the entry
screen and no gameplay actors, scores, or local round simulation are created.
Presentation binds to authoritative Nakama role, phase, ammunition, discovery,
spectator, Answer Check, score, and reconnect events. Shots and discoveries
refer to players, not map slots.

## Answer Check

At the end of the round:

- Hunters remain free to move through the map;
- Hiders enter spectator presentation;
- every Hider is revealed at the character's final location;
- found Hiders display blue plus a “Found” label/icon or distinct flash;
- unfound Hiders display red plus an “Unfound” label/icon or distinct flash;
- eligible players may like one non-self Hider disguise.

The reveal identifies players and outcomes. It does not show hiding-place
names, prop names, target slots, internal protocol values, test instructions,
or developer shortcuts.

## Bundled asset provenance

The city environment is assembled from the imported
[Low Poly City — Starter Pack by MiniWorld Studio](https://assetstore.unity.com/packages/3d/environments/urban/low-poly-city-starter-pack-mini-world-studio-380946)
under `clients/unity/Assets/MiniWorld Studio/City – Starter Pack/`. Its exact
Asset Store entitlement and redistribution requirements must be recorded in
the release asset inventory before publication.

The source repository is public. Until that review is complete, the raw
MiniWorld Studio Asset Store files must remain local and must not be staged,
committed, or pushed. Recording their provenance in the official-map catalog
does not approve public raw-source redistribution.

The humanoid character and identification weapon are project-authored Blender
assets. The former Kenney botanical/space prototype is not the active official
arena.

## Verification

Automated and manual acceptance must verify:

- the compatibility slug remains `prism-foundry` and the content version is
  `m4-4`;
- Chroma District loads with static, non-interactive environment geometry and
  valid Hunter/Hider spawn areas;
- Hiders are humanoid player characters and can move, camouflage their own
  materials/colors, and select supported poses;
- Hunters can fire at actual Hider character hitboxes, while shots at empty
  space or map geometry count as misses and consume ammunition;
- no target-slot, clickable-prop, hover-reveal, literal-animal, or
  hiding-container mechanic appears in gameplay;
- Answer Check marks found Hiders blue and unfound Hiders red with an
  additional non-color cue;
- first-person, third-person, painting, pose, hit, miss, reveal, and round HUD
  flows pass visual review;
- Unity compiles cleanly and the relevant EditMode/PlayMode tests pass;
- local desktop and WebGL development builds both complete and receive visual
  confirmation before publication.
