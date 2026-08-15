# Body painting system

Status: implemented vertical slice; human visual acceptance pending.

## Player-facing mechanic

Every Hider enters a round with a matte-white body. During the server-owned preparing and hiding
phases, press `P` to edit that body while standing in the real arena. Paint visible skin with
freehand strokes, orbit around the character, sample the map's underlying material or its current
lit screen color, tune the surface response, and inspect poses under the map lights. Painting
changes only the character's rendered material; it never changes geometry, colliders, movement,
or the authoritative role.

The Hunter cannot paint. The server closes Paint Mode when hunting starts. Cast shadows remain on
because shadow policy is competitive game state, not a local cosmetic toggle.

## Interaction flow

1. Nakama starts a round and initializes every Hider with `standard-humanoid-v1`, no strokes, and
   a neutral-white base.
2. A Hider moves to a hiding location and presses `P` during preparing or hiding.
3. The CharacterController stops. The body stays at the same world position and becomes visible
   to its local orbit camera.
4. Left-drag paints only the nearest visible registered body surface. Right-drag orbits; wheel
   zooms; `Shift` + wheel resizes the brush; `[` and `]` are discrete alternatives.
5. Hold `F` for Material Sample. Press `R` for Rendered Sample. These are distinct states, icons,
   labels, algorithms, and results.
6. Choose base/emission color, RGB/hex, opacity, radius, hardness, metallic, roughness, channel
   locks, averaging region, saved swatches, x-ray, and an inspection pose.
7. Release the mouse to close a stroke. The client paints immediately, then sends a bounded
   command to Nakama. An accepted echo makes that local stroke authoritative; a rejection removes
   only the rejected stroke while preserving accepted and still-pending work.
8. Press `P` or **Return to Game**. Camera and movement bindings are restored without moving the
   player. The server automatically closes the editor at the end of hiding.
9. Nakama replays accepted strokes in order to reconnecting and late-joining permitted clients.

There is no offline fallback, texture upload, simulated opponent, or paint-through-wall path.

## Input and state machine

The serializable `PaintInputBindings` contract is stored in player preferences rather than spread
through gameplay code. It can be replaced by Unity Input System actions later without changing
the state machine or network messages.

| State | Entry | Permitted input | Exit |
| --- | --- | --- | --- |
| Gameplay | Default | Movement, look, fire, `P` | `P` while server says Hider + preparing/hiding |
| Paint idle | Paint Mode open | Choose next action | Paint, orbit, resize, sampler, palette, x-ray, `P` |
| Painting stroke | Left-drag over owned body | Continue sampled-distance stamps | Button release, miss, UI, another renderer |
| Camera orbit | Right-drag | Yaw/pitch; wheel zoom | Right release |
| Brush resizing | `Shift` + wheel or brackets | Radius only | Modifier/wheel ends |
| Material sampler armed | Hold `F` | Ray sample every 120 ms | Release returns directly to brush |
| Rendered sampler armed | Press `R` | One explicit scene-color capture | Immediately returns to brush |
| Palette interaction | Pointer over editor | UI widgets only | Pointer leaves panel |
| X-ray paint view | `X` or button | Normal paint/orbit controls | `X`, button, or Paint Mode exit |

X-ray modifies only the local body's depth test. The paint ray still stops at the first opaque map
collider, so it cannot expose or sample through world geometry. Paint colliders exist only while
editing and are ignored by normal targeting.

## UI wireframe

The editor is a narrow right rail. It deliberately leaves the arena and body visible.

```text
┌──────────────────────── BODY PAINT ────────────────────────┐
│ [previous] [current]                         BASE/EMISSION │
│ ┌──── saturation/value ────┐  ┌── neutral-lit sphere ──┐ │
│ │                           │  │                         │ │
│ └───────────────────────────┘  └─────────────────────────┘ │
│ Hue ─────────────────────────────────────────────── 0.52  │
│ R [127]  G [163]  B [201]  A [255]                       │
│ [7FA3C9FF]       [x] sRGB preview                         │
│ Radius / Hardness / Brush opacity                         │
│ Metallic / Roughness / Emission intensity                 │
│ [Color] [Metal] [Rough] [Emit]                            │
│ [ ] sampler copies supported material channels            │
│ saved and map swatches                                    │
│ ┌ MATERIAL/raw ┐  ┌ RENDERED/LIT ┐   [1×1] [3×3] [5×5]  │
│ [Stand] [Run] [Crouch] [Aim] [Paint] [X-ray]             │
│                    [ RETURN TO GAME ]                     │
│ Shadow: locked on                                         │
└────────────────────────────────────────────────────────────┘
```

Every non-obvious control has a plain-language tooltip. “Brush opacity” is never labelled alpha
or transparency. The rendered result explicitly says it includes current lighting.

## Color management and blending

The Unity project uses Linear color space. Runtime material values, atlas render targets, sampled
material values, and blending operate in linear space. RGB entry, hex entry, swatches, and the
optional sRGB display are presentation values:

```text
hex/RGB UI (sRGB) -> Unity sRGB-to-linear conversion -> working value
working value -> Unity linear-to-sRGB conversion -> hex/RGB UI
```

Alpha is retained by color entry but means brush-layer coverage; the character remains opaque.
There is no second gamma conversion in a sampling shader. Automated tests round-trip
`7FA3C9BF` exactly.

For every enabled channel, a stamp uses source-over interpolation:

```text
new = brush × clamp01(opacity × edgeCoverage)
    + old × (1 - clamp01(opacity × edgeCoverage))
```

Base color, metallic, roughness, emission color, and emission intensity use this same formula but
are independently gated by the channel mask. A disabled channel is bitwise untouched. At alpha
0 the old value remains; at 0.5 it moves halfway; at 1 it becomes the brush value. Repeated 0.5
strokes compound rather than replacing each other.

## The two samplers

### Material Sample

1. Cast from the paint camera through the pointer.
2. Ignore the local edit proxy/body and trigger layers; stop on the nearest map surface.
3. Ask every `IPaintSampleProvider` on the hit hierarchy first. Terrain, decals, procedural
   shaders, blended workshop materials, and future custom renderers must implement this contract.
4. For the Standard fallback, resolve the triangle's material slot, `_BaseColor`/`_Color`,
   material-property block, `_BaseMap`/`_MainTex`, texture scale/offset, hit UV, and vertex tint.
5. Sample the underlying texture through a GPU readback path, point or 3×3/5×5 region, before
   dynamic lighting. Read scalar metallic and inverse smoothness when exposed. Normalize emission
   color and intensity.
6. If the material does not expose reliable data, report “needs a material sample provider.” It
   never silently returns white.

Direct lights, shadows, reflection probes, fog, bloom, grading, and tone mapping are absent by
construction.

### Rendered Sample

1. Copy the gameplay camera lens, transform, clear flags, and culling mask to an isolated camera.
2. Exclude the edit-collider layer and temporarily hide only the local body.
3. Render the scene into a game-owned sRGB render target. IMGUI and the brush cursor have not been
   drawn, so neither can enter the sample. Desktop windows are never accessible.
4. Read and average the chosen 1×1, 3×3, or 5×5 region at the pointer.
5. Convert the screen-space sRGB result once to the internal linear value. Change base color only.

The comparison tile labels this result **Rendered / lit**. Repainting a tone-mapped lit color on a
body that will be lit again can produce a double-lighting mismatch; the tooltip and status explain
that limitation.

## Body painting, model replacement, and animation

`PaintableBody` is the only bridge from painting to character art. It contains a body contract ID
and stable semantic renderer IDs such as `body.chest` and `body.left-forearm`. Gameplay and Nakama
never use an FBX filename, transform path, mesh name, or material name. The current factory derives
the initial mapping for the bundled model; a replacement model should author and serialize the
same mapping (or introduce a versioned body contract and matching server allow-list).

Each registered renderer receives a tile in three 512×512 linear runtime atlases:

- RGBA8 base color and painted coverage;
- RGBA8 metallic in R and roughness in G;
- RGBA16F emission RGB on supported devices, with an RGBA8 low-end fallback that clamps emission
  intensity to 1.

The custom surface shader reads these atlases on the original skinned renderer, so paint follows
all animations. The editor bakes temporary mesh colliders from the current skinned pose at 30 Hz.
A ray chooses only the first visible triangle; it cannot paint the hidden back. Orbit exposes the
back. UV wrap duplication catches strokes that cross a cylindrical U seam. Atlas tiles have a
six-pixel inset, clamp sampling, and independent scissor bounds so one part cannot bleed into
another island. A model with more complex islands must provide seam adjacency/dilation metadata
in its `PaintableBody` authoring definition before acceptance.

`HumanoidPresentationRig` is a second model adapter. A future Humanoid Animator can implement the
documented `MoveSpeed`, `Grounded`, `Crouching`, `Aiming`, `Painting`, and `AimPitch` parameters.
The current Generic prototype rig uses semantic bones to provide procedural walk, crouch, paint,
and rifle-hold motion. The equipped rifle is bound to the semantic right hand. First-person rifle
bob derives from the same real movement velocity and layers with recoil, so walking cannot detach
or overwrite firing feedback.

## Multiplayer protocol and reconciliation

Opcode 16 is a client paint command, opcode 17 is a live accepted snapshot, opcode 18 is a private
accept/reject result, and opcode 19 is a bounded history batch. A command contains:

```text
body ID; semantic renderer ID; up to 40 normalized UV points;
radius; hardness; opacity; linear base RGB;
metallic; roughness; linear emission RGB + intensity;
channel mask; monotonic client sequence; client simulation tick
```

Nakama validates that the sender is the active owner, an initial Hider, in preparing/hiding, using
a known body/renderer contract, finite bounded values, at most 20 commands/second, at most 256
commands and 4,096 UV points for that player/round, and a strictly newer client sequence. No image
upload exists.
The client renders locally while drawing, groups up to 40 points, and sends at most one command per
authoritative tick. Forty is a wire-level limit: Unity's round-trip float JSON retains deliberate
headroom below Nakama's 4 KiB inbound WebSocket limit after SDK base64/envelope overhead. Accepted commands
receive a server sequence/time, enter the private live-round
checkpoint, and are broadcast only to clients allowed to see that Hider. A rejection removes only
that optimistic command; accepted and other pending work is rebuilt in order. Hunters receive the
completed history when hunting starts. Reconnects replay up to eight commands in one message per
client per tick (up to ten commands per batch), preventing a history burst from overflowing
Nakama's reliable outgoing queue. The owner receives its accepted snapshot immediately so a
reconnect backlog cannot delay acknowledgement. A
client ignores an old server sequence and resumes above the largest echoed client sequence.
The socket retains bounded headroom for phase-state fan-out, but paint history is still paced and
never depends on queue growth for correctness.

The checkpoint is capped at 2 MiB. The 256-command and 4,096-point limits keep worst-case paint
history bounded while the vertical slice is profiled. Atlas snapshot compaction is the
next scaling optimization: server-approved compressed atlas snapshots plus a trailing command
suffix, with a digest and explicit sequence boundary. It is intentionally not implemented as an
unvalidated client image upload.

Clones, decoys, and holograms do not exist in the current game slice. When introduced, they must
copy an immutable accepted sequence boundary or server-produced atlas digest at creation. They
must not share a live mutable atlas with their owner.

## Components and responsibilities

| Component | Responsibility |
| --- | --- |
| `PlayerPaintMode` | Input state machine, compact editor, stroke interpolation, sampler selection, ordered outbox |
| `PaintableBody` | Model binding, atlases, skinned edit proxies, ray hit, GPU stamps, shader state |
| `PaintMaterialSampler` | Pre-lighting ray/material/provider sampling |
| `PaintRenderedColorSampler` | Game-camera scene-color sampling before UI |
| `IPaintSampleProvider` | Exact values for custom/terrain/procedural map materials |
| `HumanoidPresentationRig` | Semantic Animator/procedural locomotion and equipped-weapon binding |
| `NakamaRealtimeConnection` | Typed opcode 16–19 transport, acknowledgement, batched replay, and de-duplication |
| Nakama `paint_state.go` | Ownership/phase/range/rate validation, ordering, persistence, visibility-filtered replay |

Representative algorithms:

```text
paint ray:
  sortedHits = RaycastAll(camera -> pointer)
  for hit in nearest-first:
    if hit is owned PaintSurfaceProxy: return semanticRenderer + hit.textureCoord
    if hit is opaque world geometry: stop (no paint-through)

stroke interpolation:
  spacing = max(0.002, radius * spacingRatio)
  n = floor(distance(previousUV, currentUV) / spacing)
  append lerp(previousUV, currentUV, i * spacing / distance), i=1..n
  flush at 40 points or renderer boundary

replication:
  enqueue(command with next client sequence)
  server validates -> appends server sequence -> checkpoint -> visibility broadcast
  client applies only if server sequence > lastApplied[player]
```

## Performance and memory budgets

One 512² RGBA8 atlas is 1 MiB and one RGBA16F atlas is 2 MiB. The default two RGBA8 + one RGBA16F
set is 4 MiB/player without mipmaps (3 MiB on the low-end all-RGBA8 path). A 1024² HDR set is
16 MiB/player. The implemented default is 512²; the 256² low-end tier is 1 MiB/player HDR or
0.75 MiB/player all-RGBA8.
Only visible permitted players need live GPU atlases.
The hider and hunter presentations of one player share that same atlas set by semantic renderer
ID, so changing roles does not double this budget or require repainting a second model instance.

| Players | 512² GPU paint memory | Command bandwidth target | Paint GPU target |
| ---: | ---: | ---: | ---: |
| 2 | 8 MiB HDR / 6 MiB fallback | under 20 KiB/s normal, 80 KiB/s burst | under 0.6 ms/frame while painting |
| 6 | 24 MiB HDR / 18 MiB fallback | under 60 KiB/s normal, 240 KiB/s burst | under 1.2 ms/frame aggregate |
| 10 | 40 MiB HDR / 30 MiB fallback | under 100 KiB/s normal, 400 KiB/s burst | under 2.0 ms/frame aggregate |

The 1024² option is not enabled for the ten-player WebGL target until device telemetry proves a
160 MiB HDR atlas budget is safe. Collider baking runs only for the local body while Paint Mode is
open. Remote clients replay GPU stamps but never build body edit colliders.

## Failure handling

| Failure | Player behavior | System behavior |
| --- | --- | --- |
| Unsupported material | Clear sample-unavailable status | Requires `IPaintSampleProvider`; no white fallback |
| No surface under pointer | No color change | Sampler remains armed while held |
| Map blocks body | Stroke stops | X-ray cannot bypass map collider |
| Nakama rejects command | Only the rejected optimistic stroke is removed | Private result; accepted and pending history is rebuilt |
| Socket drops with queued stroke | Status says paint was not saved | Outbox clears; reconnect replays accepted history |
| Duplicate/out-of-order snapshot | No visible change | Client sequence map discards it |
| Refresh/restart | Body initially white, then reconstructs | Server replays visible history in order |
| Unknown body/renderer ID | No visible change | Server rejects before persistence |
| Atlas/shader missing | Character creation fails closed | Build/test failure, never a silent unpainted body |
| Stroke/rate budget exhausted | Further changes do not appear | Server rejects bounded abuse |
| Rendered readback unsupported | Clear unavailable status | Material sampling and manual color remain available |
| Phase changes while editing | Editor closes immediately | Server would reject any late command |

## QA and acceptance

Automated now:

- source-over alpha 0/0.5/1 and repeated compounding;
- exact sRGB/hex round trip and independent material channels;
- semantic body mapping, procedural limb movement, and rifle/hand binding;
- payload/body/renderer/UV/PBR/rate/phase/ownership validation;
- live-checkpoint encode/decode and ordered reconnect replay paths;
- all existing lobby, concealment, targeting, scoring, reconnect, and map tests.

Human visual acceptance still required before any push:

1. Paint the chest and verify the back remains white; orbit and deliberately paint the back.
2. Paint every current body part while standing, running, crouching, aiming, and painting. Verify
   no stroke swims or detaches.
3. Paint across each cylindrical seam. Verify no visible gap or neighboring-part bleed.
4. Sample one material, change map light intensity, and verify the material result is stable.
5. Repeat with Rendered Sample and verify it changes with lighting.
6. Verify neither result includes the editor, cursor, or local body.
7. Compare 1×1, 3×3, and 5×5 on a textured edge.
8. Test alpha 0, 0.5 twice, and 1; independently lock every PBR channel.
9. Draw fast at 30, 60, and 120 fps and check continuity.
10. Run two clients: paint, observe the peer, refresh one client, and verify an identical rebuild.
11. Run ten clients and profile GPU memory, paint-frame time, checkpoint size, and network burst.
12. Confirm one client can never paint another avatar and x-ray cannot sample through a wall.
13. Walk/sprint/crouch with both roles. Fire while moving and verify arm, world rifle, viewmodel bob,
    and recoil remain aligned.

## Staged backlog

1. **Implemented vertical slice:** linear color pipeline, compact editor, visible-surface painting,
   orbit/x-ray, two samplers, PBR/channel controls, saved swatches, semantic model adapter,
   procedural locomotion/rifle integration, authoritative commands, checkpoint replay, tests.
2. **Visual acceptance and profiling:** execute the matrix above in Editor and WebGL at 2/6/10
   clients; tune UV padding, brush radius, input feel, and budgets from measurements.
3. **Atlas compaction:** server-approved compressed snapshot + digest + trailing commands when
   profiling shows history replay/checkpoint cost needs it.
4. **Model-production pass:** author serialized `PaintableBody` definitions and Animator
   Controllers for final humanoids, plus model-specific seam adjacency and low-end atlas tier.
5. **Optional QoL, separately approved:** undo/redo (network history and memory cost), whole-body
   base coat/fill (balance risk), softness (clarity/performance), symmetry (competitive impact),
   tablet pressure, controller palette navigation, and clone snapshot semantics.

## Decisions requiring approval

- Should painting remain limited to preparing/hiding (implemented), or may a Hider reopen it while
  hunting? The latter changes balance and concealment visibility.
- Is emission allowed in competitive modes, and is the implemented cap of 8 acceptable?
- Is 512² the approved default, with 256² low-end and 1024² opt-in after profiling?
- Should saved swatches remain device-local, or follow the authenticated account?
- Which input-remapping UI/controller layout is required before controller support is considered
  complete?
- When a final humanoid replaces the prototype, will it reuse `standard-humanoid-v1`, or ship a
  new body contract and server allow-list?
- Should shadow always remain on (implemented), or should a future mode expose a server-owned
  rule? Local disabling is intentionally unavailable.
- Which optional QoL feature, if any, should be promoted into the first release scope?
