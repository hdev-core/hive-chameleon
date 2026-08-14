# Neon Service Arcade official arena

Neon Service Arcade is Hive Chameleon's sole selectable arena for the current vertical slice. It
is a compact 20×16 metre interior divided into a main arcade, prize café, and repair workshop. The
three zones provide different lighting, surface colors, sightlines, and cover while keeping a
single connected pursuit space.

## Release identity

- Map slug: `neon-service-arcade`
- Content version: `m2`
- Authority geometry: `neon-service-arcade-authority-2`
- Supported clients: desktop and WebGL on `hive-chameleon-m4-dev` / `m4-v2`
- Recommended lobby size: 2–6 players

The Unity client loads the bundled prefab only when the round's map slug, content version,
authority version, and authority digest all match its catalog. Nakama uses the corresponding
embedded analytic geometry for movement and weapon line-of-sight validation. Earlier official map
distributions remain in PostgreSQL only as historical data and are withdrawn from lobby selection.

## Unity content

The rendered environment and extracted textures live under
`clients/unity/Assets/HiveChameleon/Art/Maps/NeonServiceArcade/`. Traversal collision and spawn
markers remain separate from rendered geometry, and the runtime prefab is built under
`Assets/HiveChameleon/Resources/Maps/NeonServiceArcade/`.

The arena is included in a clean clone; contributors do not download an Asset Store environment.
Before any public distribution, the packed source material still requires the project's normal
asset-provenance and license review.
