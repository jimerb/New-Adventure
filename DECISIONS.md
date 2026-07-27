# Decision record

**Working title:** TBD (currently "Adventure 4")
**Started:** 2026-07-27
**Status:** pre-build. Nothing is implemented yet.

`ANALYSIS.md` documents the *source* — how the 1978 ROM works.
**This file documents *our* game** — what we decided to build, and why.

Read both before writing code. If a decision here contradicts the original,
that's intentional and the reason is stated. If you're about to change
something in the "invariants" section, that's a real design change, not a
refactor — update this file and say why.

---

## 1. Product shape

A modern flatscreen 3D game, voxel/low-poly in feel, built on the map,
mechanics and creature logic of Atari's *Adventure* (1978), with new art, new
scale, and a new fourth scenario.

**Menu:**

| Entry | What it is | Cost |
|---|---|---|
| **Level 3** | The full original map, item placement randomized within bounds. *The headline mode.* | baseline |
| **Level 4** | New. Extended map, more castles, new creatures, tunneling. *The reason this project exists.* | the bulk of the work |
| Original Variants → Game 1 | Original small-map scenario | ~free |
| Original Variants → Game 2 | Full map, fixed layout | ~free |
| **Easter Egg Version** | Hidden. The flat top-down game, played in 2D on the same engine. | ~free (see below) |

**Why 1 and 2 ship anyway:** Game 2 is the same map as Game 3 with a fixed
starting layout instead of a randomized one — one data table, already
extracted, zero extra code. Game 1 needs the variant-exit indirection, which
Games 2 and 3 require regardless (six rooms have indirect exits). So Game 1 is
one extra column in a table we must build anyway. They're free; they're just
not the pitch.

**Level 4 is a fourth menu entry, not an unlock.** The original has no
progression concept. We're not adding one.

### The Easter Egg Version

The flat top-down view is **not a throwaway harness** — it ships, hidden, as a
playable retro mode. Same engine, second renderer, no duplicated game rules.

**Why this is worth doing beyond nostalgia:** two live renderers on one core
*enforce* the renderer-agnostic boundary that §4 asks for. Right now that
boundary is maintained by discipline; with a 2D and a 3D view both running, any
game rule that leaks into a renderer breaks the other one immediately. That is
what keeps a VR version reachable later.

**It is our interpretation, not a copy.** Same map, same mechanics, same
pacing — our own art. The temptation here is obvious and specific: a flat 2D
retro mode is exactly where someone would drop in the ROM's sprite bitmaps
because they'd "look right". Don't. See `ANALYSIS.md` §8; the rule doesn't
relax just because the view is 2D.

**Home for the `1978` pacing preset.** The retro mode defaults to authentic
timings — 0.4 s from a dragon's touch to being swallowed. That gives the preset
a purpose beyond A/B comparison, and it's the right place for the original's
cruelty to live.

**Unlock: the dot.** Proposed — reaching the credits room via the magic-dot
secret unlocks the Easter Egg Version. The original's hidden room becomes the
key to the hidden game. Costs nothing; the trigger already works.

**Debug chrome stays separate.** Hitboxes, room teleport, cheats and the tuning
keys are harness-only and must not appear in the shipped retro mode. Same
renderer, different chrome.

**Restructure timing:** deliberately deferred. The files stay in `src/debug/`
until the 3D renderer exists, because that is when the real boundary gets
tested and the right layout becomes obvious. Moving them now would be
speculative.

---

## 2. Invariants — things we keep

These are load-bearing. Changing any of them changes what game this is.

**One carried item at a time.** No inventory. This single constraint is what
makes the bat's theft sting, the magnet matter, and sword-vs-key a real
decision. An inventory would quietly gut the design.

**Being eaten is not death.** There are no lives, no health, no timer, no
score. A dragon swallows you and you are still there, inside it, rendered. If
something kills that dragon, you walk out. This is the strangest and best thing
about the original.

**Naive AI — no pathfinding.** Creatures step directly toward their target and
get stuck on walls. This is cheap, faithful, and it's what makes them read as
animals rather than terminators. A* would make dragons relentless and change
the game's character. It also happens to be what lets dynamic walls (tunneling)
work without a navmesh rebuild.

**The chase/flee pair-list system.** All creature behavior is a null-terminated
list of (subject, target) pairs, resolved in priority order, only when both are
in the same room. Every new creature in Level 4 must be expressible this way.
If a design idea doesn't fit the grammar, that's a signal to reshape the idea,
not to expand the engine.

**No text, anywhere.** The original explains nothing — no tutorial, no labels,
no HUD. That is the design. Fight to preserve it.

**Non-Euclidean rooms.** In the mazes, north-then-south does not return you
where you started. Rooms are discrete and connected by an exit table, not by
contiguous geometry. Keep this.

**The magic dot.** A nearly invisible one-pixel object that must be noticed,
picked up, carried out of its home room, and pressed against a specific wall.
Keep the whole mechanism.

---

## 3. Deliberate departures

**Art.** All new. The original's room bitmaps and sprites are reference, not
assets — see §8 and `ANALYSIS.md` §8.

**Scale and pacing.** See §5. The original crosses a room in 0.9 seconds; we
will not, and we're choosing our number deliberately rather than inheriting it.

**Verticality.** The original has zero height data. Wall height, ceilings, sky,
elevation are entirely free creative space with no fidelity to violate.

**The secret.** The credits room text becomes **"Created by Jim Berry"**,
rendered as our own art. The *mechanism* is unchanged. For Level 4 the trigger
needs re-homing — the original hardcodes it to the right edge of room `03` with
the dot moved out of room `15`, and the new map deserves its own hiding place.

**Tunneling.** New mechanic, Level 4 only. See §6.

**Level 4 randomization goes deeper than placement.** Game 3 only re-rolls
where 11 objects start; the map is identical to Game 2 every time. That's thin.
Level 4 should also vary which castle holds the goal, which dragon guards what
(the chase/flee lists are data), and starting gate states.

---

## 4. Technical decisions

**Stack: browser + Three.js / WebGL.**
Not because it's the best engine for a shipped game — Godot probably is — but
because it's the only option where the build/look/fix loop closes without a
human in it. That iteration speed is worth a lot through the art and feel
phases. It also keeps a VR version reachable later, since WebXR runs natively
in the Quest browser.

**Not a one-way door,** provided the next decision holds:

**The logic core is renderer-agnostic.** Map, objects, carry rules, gates, AI,
collision and win condition live in a pure module that knows nothing about
Three.js, cameras, or materials. Rendering and input are thin layers on top.
Moving to Godot or Unity later is then a renderer swap, not a rewrite.

**Simulate in the original's unit space.** 160 × 96 units per room, integer
coordinates, exactly as extracted. Scale to metres only at the render boundary.
This keeps every number in `data/` directly usable and keeps the port
verifiable against the source.

**Rooms are portals, not contiguous geometry.** Walking off a room edge
teleports you to the adjacent room's opposite edge. This is what makes the
non-Euclidean mazes possible at all, and it's cheaper than the alternative.

---

## 5. Space, scale and pacing

Derived in `ANALYSIS.md` §2; restated here as build numbers.

| Quantity | Original | Decision |
|---|---|---|
| Room, unit space | 160 × 96 | unchanged — simulate here |
| Wall grid | 40 × 7 cells | unchanged |
| Corridor | ~16 × 14 units (near-square) | **this is the block scale, not the 4-unit cell** |
| Navigable room | ~10 × 7 tiles | unchanged |
| Player speed | 3 units/frame ≈ 180 u/s | TBD — see below |
| Room crossing | **0.9 seconds** | target ~3 s |

**The pacing problem, stated plainly:** the original's tension is that rooms
are about one second wide. A dragon appears and you have a moment to decide.
Naively scaling to human proportions (4 m tiles, 1.5 m/s walk) makes a room
crossing take 27 seconds — a 30× slowdown that would destroy the feel.

**The fix is to shrink, not to speed up.** Working assumption: **~1.5–2 m
tiles, movement ~5 m/s**, giving a ~15 m room crossed in ~3 seconds. Still
slower than the original, but in the right emotional register. To be confirmed
empirically in build step 3.

**Do not use the 4-unit cell as the voxel size.** Cells are 4 wide × ~14 tall;
building on the cell makes every corridor a slot. Use the ~16-unit corridor.

### Step 3 findings — measured in `spike-camera.html`

Seven things the spike settled that could not be settled on paper. The first is
the important one.

**1. Tick rate is the speed knob, and it needs no engine change.** The engine
moves whole units per tick — 3 for the player, 2 for a dragon. Slowing the
player by moving *fewer units per tick* is impossible without sub-unit
positions, i.e. floats through the whole collision core. Ticking **less often**
and interpolating between ticks gives the same result, touches nothing, and
preserves every relative speed in the game exactly. One number.

**2. The original's speed is road speed.** At any scale where a room reads as a
real space, 3 units/frame at 60 Hz is 20–45 m/s. The 1978 preset shows this
honestly: it is faithful, and nothing at that rate can read as a person.

**3. The 0.25× dragon setting was tuned against 1978 player speed.** It makes
dragons **6× slower than you** — you walk away from them. The original ratio is
**1.5×**, and Rhindle's is **1.0×**: he exactly matches you, which is why he is
frightening. *Dragon speed must be specified as a ratio to player speed, not an
absolute multiplier* — otherwise re-tuning the player silently guts the threat.
Recommended ≈ 2.5× (outrunnable, still a threat).

**4. The 40 × 7 grid cannot give both square cells and a proportioned room.**
Squaring the cells flattens a room to a 40 × 7 strip. Deep cells are the right
answer: at `zStretch 1.0` a wall is 1 m wide × 4 m deep, which reads as a thick
castle wall and looks correct. Confirmed by looking at both.

**5. Sprite height is not real height.** A 20-unit dragon sprite scales to a 5 m
dragon. Figures need an explicit height table, decoupled from sprite metrics.

**6. Render narrower than you collide.** The player's collision box is 4 × 8
units — about 1 m × 2 m, far wider than a person. Drawing the figure at ~0.55×
its collision footprint keeps the original's forgiving feel while looking human.
Toggle *Collision boxes* in the spike to see the gap.

**7. Arrow keys are world-absolute, so the camera must not rotate.** A follow
camera that turns with movement breaks the mapping between key and direction.
North-up is the default; the rotating variant is a toggle so the problem is
demonstrable rather than theoretical.

### Camera: recommendation

**Raised third-person follow, ~50° down, ~16 m back, north-up.** First person
is genuinely unplayable here and the spike proves it — a maze room reduces to a
featureless corridor with no information. Overhead is faithful and the right
home for the Easter Egg Version. Fixed-tilt-per-room frames beautifully but
gives away the whole maze, which removes the point of a maze.

**Recommended numbers, pending playtest:** 1 m per cell (40 × 24 m room),
12 Hz tick → **9 m/s, 4.4 s to cross a room**, dragons at ~2.5× ratio, wall
height 2.5 m. Not yet a decision — see §10.

---

## 6. Tunneling (Level 4)

Minecraft-style digging, but scoped.

**Within-room only.** You may carve through any wall inside a room's own 10 × 7
grid. Room boundaries remain portals and stay indestructible.

**Why scoped:** tunneling demands that the space beyond a wall be physically
coherent; non-Euclidean rooms guarantee it isn't. These two ideas fight, and
this is the cheap resolution — the map model doesn't change at all.

**Why it's still a big deal:** the maze walls *are* the entire difficulty of
the mazes. Letting the player dig through them directly attacks the central
obstacle. That's a genuinely powerful ability, which is why it needs a cost.

**Cost model (initial):**
- Digging takes real time — long enough that a dragon can close on you.
- **Dragons can follow your tunnels.** You aren't just escaping; you're opening
  the maze up for everything else in it.

Both to be tuned. If tunneling turns out to trivialize the mazes, the first
lever is dig time, the second is restricting which wall materials are diggable.

**Stretch, not committed:** one purpose-built *Euclidean* region in Level 4
where tunneling works properly across room boundaries — possibly as fiction,
the place where the world stops folding.

---

## 7. What Level 4 gets cheaply

The original's grammar — every object is `(room, x, y)` plus one state byte,
every behavior is a pair list — means a lot of content is data entry.

| Nearly free | Needs new code |
|---|---|
| More castles (exterior room, interior room, gate object, key object — it's a table) | Tunneling |
| New creatures with novel pair lists | Anything needing more than one state byte |
| A creature that flees the chalice, hunts the bat, or steals only keys | Multi-item inventory *(rejected — see §2)* |
| More bats; a repelling magnet; a second magnet | Progression/unlocks *(rejected — see §1)* |
| New rooms — a room is a 40 × 7 ASCII grid, four exit IDs, and a colour | Verticality as gameplay (jumping, floors) |

**Level 4 size: open.** 31 rooms is a short evening; 50–60 is a meaningfully
larger authoring commitment. Deferred to build step 7.

---

## 8. Art direction

**Principles, not a style guide yet.**

**Voxel/Minecraft in feel**, at the ~16-unit corridor block scale.

**Mirror symmetry is an asset, not a limitation.** Every original room is
horizontally symmetric because of a hardware quirk, but symmetric floor plans
read as *built* in 3D — cathedrals, keeps, temples. Keep it. Two rooms (`14`
and `15`) *repeat* their left half instead of mirroring it, which is what makes
that corner of the black maze feel subtly wrong. Preserve that too.

**The colour scheme is already a system — keep the relationships, re-pick the
hues.** In the original: each castle owns a hue, its key matches it, every dark
region shares one value, and the entire five-room labyrinth is a single flat
colour *specifically so you can't tell the rooms apart by looking*. That last
one is a gameplay decision disguised as a palette decision.

**Height, ceilings and lighting are free.** No source data constrains them.

**The darkness mechanic wants to be lighting.** The original draws a solid
black box around the player in dark rooms. In 3D this becomes a light radius
and gets better essentially for free.

### Art sourcing — noted for later, not needed yet

Jim has offered to generate art via image-gen tools. Worth planning for, with
one important caveat: **image generation produces 2D images, not 3D models.**
The realistic uses are:

1. **Style/mood boards** — one per region (overworld, blue labyrinth,
   catacombs, each castle) to fix the palette and material language.
2. **Tileable texture maps** — stone, brick, moss, obsidian, gold. This is the
   highest-value use by far: in a voxel-ish look the geometry is simple and
   **the materials carry the entire identity.**
3. **Concept references** for creatures and items, to model or generate
   geometry against.

What it *cannot* produce: rigged, animated 3D dragons. Geometry will be
procedural or modelled; image-gen dresses it.

**Timing:** too early. The right moment is **build step 5**, after the camera
and scale are settled — because the camera angle determines what detail is even
visible, and generating textures before we know that wastes the effort. When we
get there I'll write out the specific list: which regions, which materials,
what tiling resolution, and the palette constraints.

Asset classes that will eventually be needed, for planning:
creature models (3 dragons × 3 poses, bat × 2 wing states, plus new Level 4
creatures) · items (chalice, sword, magnet, keys ×3+, bridge, dot) ·
architecture (castle exteriors, animated gates, keep interiors) · wall/floor
material sets per region · player character · sky and ground treatment.

**The debug view uses stand-in vector silhouettes.** Not the ROM's sprites, and
not a preview of the art direction — they exist so that *pose* is readable in
the harness. A dragon opens its jaws when winding up and lies on its back when
slain; a rectangle hides both, which makes the state machine untestable by eye.

**The player character is a blank slate.** In the original he's drawn with the
TIA's spare "ball" object — a featureless rectangle with no animation frames,
because that's what was left over. There is no canonical appearance to be
faithful to.

---

## 9. Build order

1. **Decision record** — this file. ✅
2. **Logic core + 2D debug view.** ✅ *Code complete; visual pass not yet done
   by a human.* `src/core/engine.js` (renderer-agnostic sim),
   `src/debug/view2d.js`, `debug.html`. Verified by scripted tests: exits and
   reciprocity, variant exits per game, wall collision, carry/drop, all three
   dragons' chase/flee, bite-delay difficulty, sword kills, swallow-and-drag,
   bat theft, magnet attraction, all three castles, the credits secret, the win
   condition, and a clean 40,000-frame random soak on each game.
3. **Camera and scale spike.** One or two rooms in 3D, several camera setups
   and speeds. Jim looks and picks. Settles §5.
4. **Vertical slice.** Game 3 fully playable in 3D, placeholder art, correct
   pacing. *This is where the project's real risk lives* — whether the
   fast-room-to-room feel survives a 3D world. Hit it early.
5. **Art pass.** Materials, height, lighting, darkness. Rooms stop being boxes.
   Art sourcing brief written here.
6. **Tunneling**, with cost model.
7. **Level 4** authoring — rooms, castles, creatures, relocated secret.
8. **Tuning and polish.**

Steps 2–4 carry the risk. After that it's mostly content.

---

## 10. Open questions

| # | Question | Needed by |
|---|---|---|
| 1 | ~~Camera~~ — spike recommends raised third-person, 50°, north-up. **Awaiting sign-off** | step 3 |
| 2 | ~~Tile scale and speed~~ — spike recommends 1 m/cell, 12 Hz tick, 9 m/s. **Awaiting sign-off** | step 3 |
| 2b | Dragon ratio: 1.5× (faithful, harsh) vs ~2.5× (outrunnable) | step 4 |
| 3 | Level 4 room count (~31 vs ~50–60) | step 7 |
| 4 | Working title | before art |
| 5 | Does tunneling trivialize the mazes? | step 6 |
| 6 | Euclidean sub-region in Level 4 — yes or drop it? | step 7 |

---

## 11. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-27 | Flatscreen 3D first, not VR | Iteration loop closes without a headset; ~80% of work is shared if the core stays renderer-agnostic; art is the gate on VR, not code |
| 2026-07-27 | Browser + Three.js | Build/look/fix loop closes autonomously; keeps WebXR reachable |
| 2026-07-27 | Level 3 is the focus; Level 4 is new | Games 1 and 2 are alternate setups, not difficulty tiers, and Game 1's small map holds nothing for a fan |
| 2026-07-27 | Ship Games 1 and 2 anyway, unpromoted | Effectively free — one data table and one table column |
| 2026-07-27 | Level 4 is a menu entry, not an unlock | Original has no progression concept |
| 2026-07-27 | Portal rooms, not contiguous geometry | Only way to keep non-Euclidean mazes; also cheaper |
| 2026-07-27 | Tunneling scoped within-room | Tunneling requires Euclidean space; scoping resolves the conflict at zero cost to the map model |
| 2026-07-27 | Keep naive AI | Faithful, cheap, better feel, and works with dynamic walls |
| 2026-07-27 | Keep one-item carry | Load-bearing for bat, magnet, and key decisions |
| 2026-07-27 | Secret text → "Created by Jim Berry", dot mechanism unchanged | Jim's project; the mechanism is the good part |
| 2026-07-27 | Simulate in 160 × 96 unit space | Keeps `data/` directly usable and the port verifiable |
| 2026-07-27 | Block scale = ~16-unit corridor, not the 4-unit cell | Cells are 4 × 14; building on them makes corridors into slots |
| 2026-07-27 | Collision uses a **foot box** (bottom 8 units), not full sprite bounds | A 20-unit dragon is taller than a ~14-unit row band, so its full box always overlaps a wall and it freezes on spawn. Also the right model for 3D |
| 2026-07-27 | Creatures slide per-axis; the player gets whole-frame revert | Sticky walls are part of the player's feel; creatures wedging in corners is just broken |
| 2026-07-27 | Being embedded in a wall never blocks movement | Otherwise anything shoved or spawned into geometry is stuck for the rest of the run |
| 2026-07-27 | **Creatures ignore walls entirely**; only the player collides | Faithful — dragons and the bat drift straight through maze geometry, which is why the labyrinth never protects you. That asymmetry is core to the feel. Kept behind a `creaturesCollide` flag for Level 4 tunneling |
| 2026-07-27 | Dragon speed default 0.25× | Playtested. 1.00× is the ROM and gives 0.4s from touch to swallowed |
| 2026-07-27 | Engine emits named events; presentation decides what they look/sound like | Keeps the core renderer-agnostic. Audio and the win flash consume events and know nothing about game rules |
| 2026-07-27 | Readability floor on object colours, at the view layer only | The black key is colour `00` on a `08` floor and is genuinely invisible in the black maze. `data/` stays faithful; presentation compensates. Whether the real game keeps that cruelty is a step 5 call |
| 2026-07-27 | **The 2D view ships as a hidden Easter Egg Version** rather than being thrown away | Two renderers on one core *enforce* the renderer-agnostic boundary instead of merely asking for it — the cheapest possible insurance for a later VR port. Nostalgia is the bonus, not the reason |
| 2026-07-27 | **Wall-clock speed is set by tick rate, not by units per tick** | Keeps the engine integer and untouched, preserves every relative speed exactly, and makes pacing a single number. Sub-unit movement would have meant floats through the whole collision core |
| 2026-07-27 | **Dragon speed is specified as a ratio to player speed** | An absolute multiplier silently guts the threat whenever the player is re-tuned — which is exactly what the 0.25× setting did. Original ratio is 1.5×; Rhindle is 1.0× |
| 2026-07-27 | Colour decoding moved to `src/core/palette.js` | The second renderer arrived and immediately needed it. First real proof the renderer-agnostic boundary does work |
