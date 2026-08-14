# Third-party asset attribution

This file records every third-party asset redistributed in this repository, with its author,
licence, and source. It exists to satisfy the attribution obligations those licences carry.

Everything not listed here is project-authored.

---

## Neon Service Arcade map

Location: `clients/unity/Assets/HiveChameleon/Art/Maps/NeonServiceArcade/`

The map shell, walls, floors, doors, ceiling, rhythm platform, benches, café counter and
seating, prize shelves, vending machines, workshop benches, racks, cart, pegboards, bins,
neon strips and all procedural materials are project-authored. The following imported assets
are embedded in `HC_NeonServiceArcade_Visual.fbx` and its `Textures/` folder.

### Poly Haven — CC0 1.0 (public domain)

No obligations; credited as good practice. Source: https://polyhaven.com

| Asset | Files |
|---|---|
| Television 01 | `Television_01_nor_gl_1k.jpg` |
| Gaming Console | `gaming_console_diff_1k.jpg`, `gaming_console_emissive_1k.jpg`, `gaming_console_nor_gl_1k.jpg` |
| Drill 01 | `Drill_01_diff_1k.jpg`, `Drill_01_nor_gl_1k.jpg` |
| Dirty Carpet, Checkered Pavement Tiles, Dirty Tiles, Metal Plate | baked surface maps exported as `tmp*.jpg` |

### Sketchfab — CC Attribution 4.0 (credit required)

> **"Claw Machine"** by **Shorty_Digitan**, licensed **CC BY 4.0**, via Sketchfab.
> https://sketchfab.com/3d-models/claw-machine-be864ad5a9e04b1f8bc31cad1f973193

Files: `claw_machine_01_baseColor.png`, `claw_machine_01_normal.png`,
`claw_machine_01_emissive.png`, `claw_machine_01.glass_baseColor.png`,
`claw_machine_01.glass_normal.png`, `FigureBox_baseColor.png`

This credit must also appear in the shipped game's credits screen.

### Sketchfab — "Free Standard" licence ⚠️ open item

> **"Atari Asteroids Arcade Machine"** by **big_jojo**, via Sketchfab — UID `3968ff2a95134488aa10fb12f0008e5d`
> **"Bally Midway Tron Arcade Machine"** by **big_jojo**, via Sketchfab — UID `ada3f72316e4432aaadd043cdc3f257d`

Files include `Asteroids-Plate_baseColor.png`, `Marquee_baseColor.png`, `Bezel_Art_baseColor.png`,
`Back_Bezel_Rocks_baseColor.png`, `Front_Bezel_Rocks_baseColor.png`, `Coin_Door_baseColor.png`,
`Control_Panel_Decal_baseColor.png`, `Left_Decal_baseColor.png`, `Video_Image_baseColor.png`.

**Two unresolved issues, both must be settled before any public release:**

1. **Redistribution.** The Sketchfab Standard licence permits use of a model *inside* a product,
   but does not clearly permit redistributing the model files themselves. This repository is
   public, so the raw `.fbx` and textures are downloadable by anyone — which is plausibly
   redistribution. Terms: https://sketchfab.com/licenses

2. **Trademark.** These cabinets reproduce real branded products — *Asteroids* (Atari) and
   *Tron* (Bally Midway / Disney), including readable logos and marquee art. The model licence
   says nothing about those trademarks. This is the same class of problem that made the
   original Chroma District map unshippable, and it also conflicts with the project's own art
   direction, which excludes "readable text, letters, numbers, logos, branded imagery".

**Resolution options:** swap in generic unbranded CC-BY cabinets; repaint the marquee/side-art
textures with project-authored artwork; or revert to the fully procedural cabinets, which are
licence- and trademark-clean by construction and remain reproducible from the map build script.
