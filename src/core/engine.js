// engine.js -- the renderer-agnostic simulation core.
//
// Everything here runs in the original's unit space: a room is 160 x 96 units,
// y increases UPWARD, and an object's y is its TOP edge (sprites extend
// downward from it). Scale to metres only at the render boundary. See
// ANALYSIS.md section 2.
//
// FIDELITY NOTE. Where the ROM's intent was clear from the 6502, this matches
// it. Where it wasn't, this implements the game's *observed* behaviour and says
// so in a RECONSTRUCTED comment. We are building a new game, not an emulator,
// so observable behaviour is the contract -- but the distinction matters when
// something feels wrong and you're deciding whether to trust this file.

(function (ADV) {
  'use strict';

  // ---------------------------------------------------------------- geometry

  const FIELD = {
    xMin: 0x03, xMax: 0x9F,     // player's range; other objects stop at 0x9A
    yMin: 0x0D, yMax: 0x69,
    top: 0x68, bottom: 0x08,
    cols: 40, rows: 7,
    width: 160, height: 96
  };

  const OBJ_X_MAX = 0x9A;
  const PLAYER_W = 4;           // ball, size 2 in most rooms => 4 units
  const PLAYER_H = 8;

  // Playfield rows are NOT evenly spaced: the kernel advances a row whenever
  // the scanline counter crosses a multiple of 16 while descending 0x68 -> 0x08,
  // so the top and bottom bands are short. Verified against the kernel.
  function rowOf(y) {
    const r = 6 - Math.floor((y - 1) / 16);
    return r < 0 ? 0 : (r > 6 ? 6 : r);
  }
  function colOf(x) {
    const c = Math.floor(x / 4);
    return c < 0 ? 0 : (c > 39 ? 39 : c);
  }

  const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };

  // ------------------------------------------------------------------ tables

  function byName(list) {
    const m = {};
    for (const o of list) m[o.name] = o;
    return m;
  }

  function hex(s) { return parseInt(s, 16); }

  // ------------------------------------------------------------------ engine

  class Engine {
    constructor(data) {
      this.data = data;
      this.rooms = {};
      for (const r of data.rooms) this.rooms[hex(r.id)] = r;
      this.objMeta = byName(data.objects);
      this.beh = data.behaviour;

      // exit code (>=0x80) -> [game1, game2, game3]
      this.variantExits = {};
      for (const v of this.beh.variantExits) {
        this.variantExits[hex(v.exitCode)] = [hex(v.game1), hex(v.game2), hex(v.game3)];
      }

      this.reset(3);
    }

    // ---------------------------------------------------------------- setup

    // PACING. The 1978 numbers are faithful and they are also brutal: a dragon
    // that touches you swallows you 12 frames later, which is a fifth of a
    // second. That worked on a machine where a room was one second wide. It is
    // not a bug to fix, it's a design choice to make -- see DECISIONS.md 5.
    // Both presets are kept so they can be compared directly.
    setPacing(mode) {
      this.pacing = mode;
      this.tuning = (mode === '1978')
        ? { playerSteps: 3, dragonSpeedScale: 1.00, batSpeedScale: 1.00,
            biteFrames: null, creaturesCollide: false }
        : { playerSteps: 3, dragonSpeedScale: 0.25, batSpeedScale: 0.50,
            biteFrames: 45, creaturesCollide: false };
    }

    reset(game) {
      this.game = game || this.game || 3;
      this.frame = 0;
      this.won = false;
      if (!this.tuning) this.setPacing('modern');
      this.difficultyBite = 'B';   // left switch  -> how fast dragons bite
      this.difficultySword = 'A';  // right switch -> do dragons fear the sword
      this.log = [];

      // Player start is NOT in the layout table; the reset path hardcodes it.
      this.player = { room: 0x11, x: 0x50, y: 0x20 };
      this.carrying = null;
      this.justDropped = null;
      this.events = [];
      this.winFrame = 0;

      this.ents = {};
      const layout = this.data.layouts[Math.min(this.game, 3) - 1];
      for (const p of layout.placements) {
        if (p.owner === 'portcullis-states') {
          this.gates = {
            'portcullis-gold': hex(p.goldState),
            'portcullis-white': hex(p.whiteState),
            'portcullis-black': hex(p.blackState)
          };
          continue;
        }
        if (p.owner === 'bat-internals') continue;
        this.ents[p.owner] = {
          name: p.owner,
          room: hex(p.room), x: hex(p.x), y: hex(p.y),
          state: p.state !== undefined ? hex(p.state) : 0,
          lastDir: 0
        };
      }

      // Bat internals. RECONSTRUCTED: the ROM keeps a grabbed-object pointer
      // and a hold timer in $D0/$D1, but the initial values there don't parse
      // as object addresses, so this models the behaviour instead.
      this.bat = { carrying: null, hold: 0, flap: 0, wander: 0 };

      if (this.game >= 3) this.randomise();
      this.note('reset to game ' + this.game);
    }

    // Game 3 re-rolls placements inside per-object bounds. Those bounds are the
    // designer's hand on the scale -- the chalice is always in a maze.
    randomise() {
      for (const r of this.data.random) {
        const e = this.ents[r.owner];
        if (!e) continue;
        const lo = hex(r.minRoom), hi = hex(r.maxRoom);
        e.room = lo + Math.floor(Math.random() * (hi - lo + 1));
      }
    }

    note(msg) {
      this.log.push('[' + this.frame + '] ' + msg);
      if (this.log.length > 12) this.log.shift();
    }

    // The core stays renderer-agnostic, so it does not play sounds or flash
    // screens -- it just says what happened. Presentation layers consume this
    // and decide what that should look and sound like. The ROM's six sound
    // slots map onto these names; see ANALYSIS.md.
    emit(name) { this.events.push(name); }

    // ------------------------------------------------------------ collision

    room(id) { return this.rooms[id]; }

    solidAt(roomId, col, row) {
      const r = this.room(roomId);
      if (!r) return true;
      return r.walls[row][col] === '#';
    }

    // Box is given in unit space with y as the TOP edge.
    boxHitsWall(roomId, x, y, w, h) {
      const c0 = colOf(x), c1 = colOf(x + w - 1);
      const r0 = rowOf(y), r1 = rowOf(y - h + 1);
      for (let c = c0; c <= c1; c++) {
        for (let r = r0; r <= r1; r++) {
          if (this.solidAt(roomId, c, r)) return true;
        }
      }
      return false;
    }

    // The bridge is a hole in the world: while you're inside its span, walls
    // stop existing. This is why it can be carried into a maze and used to
    // cross a wall you could never walk around.
    inBridge(ent) {
      const b = this.ents['bridge'];
      if (!b || b.room !== ent.room) return false;
      const dx = ent.x - b.x;
      const dy = b.y - ent.y;
      return dx >= 0x0A && dx < 0x17 && dy >= -4 && dy < 0x19;
    }

    // ------------------------------------------------------------- movement

    // DEPARTURE, deliberate. Collision uses a *foot* box -- the bottom 8 units
    // of the sprite -- not its full bounds. A dragon is 20 units tall and a row
    // band is ~14, so its full box always overlaps a wall somewhere and a
    // naive test freezes it permanently on spawn. Treating tall sprites as
    // occupying only their base is the standard top-down fix and it's the right
    // shape for the 3D port too, where a dragon's height is irrelevant to where
    // it can stand.
    footBox(ent, isPlayer) {
      if (isPlayer) return { x: ent.x, y: ent.y, w: PLAYER_W, h: PLAYER_H };
      const meta = this.objMeta[ent.name];
      const w = meta ? meta.width : 8;
      const h = this.heightOf(ent);
      const foot = Math.min(8, h);
      return { x: ent.x, y: (ent.y - h + foot) & 0xFF, w: w, h: foot };
    }

    // One frame of movement for any mover. `steps` is units per axis per frame:
    // 3 for the player and Rhindle, 2 for the other dragons.
    moveEntity(ent, mask, steps, isPlayer) {
      // Creatures ignore walls. This is faithful -- dragons and the bat drift
      // straight through maze geometry, which is exactly why the labyrinth
      // never protects you. Walls are the *player's* problem alone, and that
      // asymmetry is a big part of why the game feels the way it does.
      // Level 4's tunneling may want to flip this back on for some creature,
      // hence the flag rather than deleting the code.
      if (!isPlayer && !this.tuning.creaturesCollide) {
        for (let i = 0; i < steps; i++) {
          if (mask & 0x80) ent.x = (ent.x + 1) & 0xFF;
          if (mask & 0x40) ent.x = (ent.x - 1) & 0xFF;
          if (mask & 0x10) ent.y = (ent.y + 1) & 0xFF;
          if (mask & 0x20) ent.y = (ent.y - 1) & 0xFF;
        }
        this.applyEdges(ent, false);
        return mask;
      }
      // Being already inside a wall never blocks you. Without this, anything
      // that spawns or gets shoved into geometry is stuck for the whole game.
      const f0 = this.footBox(ent, isPlayer);
      const embedded = this.boxHitsWall(ent.room, f0.x, f0.y, f0.w, f0.h);

      const tryAxis = (dx, dy) => {
        const b = { room: ent.room, x: ent.x, y: ent.y };
        for (let i = 0; i < steps; i++) {
          ent.x = (ent.x + dx) & 0xFF;
          ent.y = (ent.y + dy) & 0xFF;
        }
        this.applyEdges(ent, isPlayer);
        if (embedded || this.inBridge(ent)) return true;
        if (ent.room !== b.room) return true;
        const f = this.footBox(ent, isPlayer);
        if (!this.boxHitsWall(ent.room, f.x, f.y, f.w, f.h)) return true;
        ent.room = b.room; ent.x = b.x; ent.y = b.y;
        return false;
      };

      // Both bits set on an axis cancel -- that is how the original expresses
      // "no movement here", and it falls out of the arithmetic for free.
      const dx = (mask & 0x80 ? 1 : 0) + (mask & 0x40 ? -1 : 0);
      const dy = (mask & 0x10 ? 1 : 0) + (mask & 0x20 ? -1 : 0);

      if (isPlayer) {
        // The player gets a whole-frame revert, not a slide. That is why
        // Adventure feels sticky -- moving diagonally into a wall stops you
        // dead on both axes. Keep it; it's part of the handling.
        if (dx || dy) return tryAxis(dx, dy) ? mask : 0;
        return 0;
      }
      // Creatures slide per axis instead, so they round corners rather than
      // wedging themselves against walls and giving up.
      let moved = false;
      if (dx) moved = tryAxis(dx, 0) || moved;
      if (dy) moved = tryAxis(0, dy) || moved;
      return moved ? mask : 0;
    }

    // Screen-edge wrap and the room change that goes with it.
    applyEdges(ent, isPlayer) {
      const xHi = isPlayer ? 0x9F : OBJ_X_MAX;
      const xReturn = isPlayer ? 0x9E : 0x9A;
      let dir = -1;

      if (ent.y >= 0x6A && ent.y < 0xF0) { ent.y = 0x0D; dir = DIR.UP; }
      else if (ent.y < 0x0D || ent.y >= 0xF0) { ent.y = 0x69; dir = DIR.DOWN; }
      else if (ent.x < 0x03 || ent.x >= 0xF0) { ent.x = xReturn; dir = DIR.LEFT; }
      else if (ent.x >= xHi) { ent.x = 0x03; dir = DIR.RIGHT; }

      // Moving diagonally can push past two edges in a single frame. Only one
      // of them can become a room change, so the chain above picks it -- but
      // the other axis is then left overflowed and leaks out of the field.
      // Clamp whatever the chain didn't consume.
      if (ent.x >= 0xF0 || ent.x < 0x03) ent.x = 0x03;
      else if (ent.x >= xHi) ent.x = xHi - 1;
      if (ent.y >= 0xF0 || ent.y < 0x0D) ent.y = 0x0D;
      else if (ent.y > 0x69) ent.y = 0x69;

      if (dir < 0) return;

      // The credits secret: carry the dot out of its home room, then walk into
      // the right-hand wall of room 03. Four comparisons in the original.
      if (isPlayer && dir === DIR.RIGHT && ent.room === 0x03 &&
          this.ents['dot'] && this.ents['dot'].room !== 0x15) {
        ent.room = 0x1E; ent.x = 0x03;
        this.note('secret: entered the credits room');
        return;
      }

      // Leaving a castle has to be intercepted here, before the normal exit
      // table runs -- the gold keep's exits all point at itself, so a wrap
      // would just spit you back into the same room.
      if (isPlayer && dir === DIR.DOWN) {
        for (const c of this.beh.castles) {
          if (ent.room !== hex(c.interiorRoom)) continue;
          if (this.gates[c.gate] === 0x1C) {          // shut: you're locked in
            ent.y = 0x69;
            this.note('the ' + c.castle + ' gate is shut behind you');
            return;
          }
          ent.room = hex(c.exteriorRoom);
          // Drop clear of the gateway, not level with it. Landing exactly on
          // the entry threshold re-triggers entry on the same frame and
          // ping-pongs you between the two rooms forever.
          ent.x = 0x50; ent.y = 0x20;
          this.gates[c.gate] = 1;                     // swings shut on the way out
          this.note('left the ' + c.castle + ' castle');
          return;
        }
      }
      ent.room = this.resolveExit(ent.room, dir);
    }

    resolveExit(roomId, dir) {
      const r = this.room(roomId);
      if (!r) return roomId;
      const code = hex(r.exits[dir]);
      if (code < 0x80) return code;
      const row = this.variantExits[code];
      return row ? row[Math.min(this.game, 3) - 1] : roomId;
    }

    // -------------------------------------------------------------- sprites

    heightOf(ent) {
      const meta = this.objMeta[ent.name];
      if (!meta) return 8;
      for (const f of meta.frames) {
        if (ent.state <= hex(f.maxState)) return f.height;
      }
      return meta.frames[meta.frames.length - 1].height;
    }

    boxOf(ent) {
      const meta = this.objMeta[ent.name];
      const w = meta ? meta.width : 8;
      const h = this.heightOf(ent);
      return { x: ent.x, y: ent.y, w: w, h: h };
    }

    overlaps(a, b) {
      return a.x < b.x + b.w && b.x < a.x + a.w &&
             (a.y - a.h) < b.y && (b.y - b.h) < a.y;
    }

    playerBox() {
      return { x: this.player.x, y: this.player.y, w: PLAYER_W, h: PLAYER_H };
    }

    touching(ent) {
      return ent.room === this.player.room &&
             this.overlaps(this.playerBox(), this.boxOf(ent));
    }

    // ------------------------------------------------------------------- AI

    // Direction mask so that `from` moves toward `to`. Both bits set on an axis
    // cancel, which is how the original expresses "no movement on this axis".
    towardMask(from, to) {
      let m = 0xFF;
      if (to.x < from.x) m &= ~0x80; else if (to.x > from.x) m &= ~0x40;
      if (to.y < from.y) m &= ~0x10; else if (to.y > from.y) m &= ~0x20;
      return m;
    }

    // Pair lists are the whole AI. The mask is always computed as "first moves
    // toward second" and then applied to the creature -- so when the creature
    // is the second member of a pair, the same mask carries it away. That is
    // the entire flee mechanism; there is no separate flee code.
    pairMask(creatureName, rules, ignore) {
      for (const rule of rules) {
        const a = this.lookup(rule.first);
        const b = this.lookup(rule.second);
        if (!a || !b) continue;
        if (ignore && (rule.first === ignore || rule.second === ignore)) continue;
        if (a.room !== b.room) continue;
        return this.towardMask(a, b);
      }
      return 0;
    }

    lookup(name) {
      if (name === 'player') return this.player;
      return this.ents[name] || null;
    }

    updateDragons() {
      // On difficulty B the sword rule is filtered out of the list entirely,
      // so dragons stop fearing it. That makes B the harder setting.
      const ignore = this.difficultySword === 'B' ? 'sword' : null;

      for (const d of this.beh.dragons) {
        const e = this.ents[d.name];
        if (!e || e.state === 1) continue;          // 1 = slain

        if (e.state === 2) {                        // has swallowed the player
          // Slaved to the dragon's mouth, but clamped: the offset alone puts
          // you under the floor of the field when the dragon is low in a room,
          // and then you're being carried around somewhere unrenderable.
          this.player.room = e.room;
          this.player.x = Math.max(0x03, Math.min(0x9E, e.x + 3));
          this.player.y = Math.max(0x0D, Math.min(0x69, e.y - 0x0A));
        }

        if (e.state >= 3) {                         // bite wind-up
          e.state = (e.state + 1) & 0xFF;
          if (e.state >= 0xFC) {
            e.state = 2;
            this.note(d.name + ' swallowed you');
            this.emit('swallow');
          }
          continue;
        }

        let mask = this.pairMask(d.name, d.rules, ignore);
        // Losing sight of the target does not stop a dragon -- it keeps going
        // in its last direction. This is how they follow you between rooms,
        // since the pair test requires both to be in the same room.
        if (mask === 0) mask = e.lastDir; else e.lastDir = mask;
        this.moveEntity(e, mask,
          this.stepCount(e, d.stepsPerFrame, this.tuning.dragonSpeedScale), false);

        if (e.state === 0 && this.touching(e)) {
          if (this.carrying === 'sword') {
            e.state = 1;
            this.note('you slew ' + d.name);
            this.emit('slay');
          } else {
            e.state = this.biteSeed();
            this.note(d.name + ' lunged');
            this.emit('lunge');
          }
        }
      }
    }

    biteSeed() {
      // The state counts up to 0xFC and then swallows, so the seed *is* the
      // delay: 0xFC minus however many frames you want the wind-up to last.
      if (this.tuning.biteFrames != null) {
        const f = this.difficultyBite === 'A'
          ? Math.round(this.tuning.biteFrames / 2)
          : this.tuning.biteFrames;
        return Math.max(4, 0xFC - f);
      }
      const t = this.beh.dragonBiteSeed['game' + Math.min(this.game, 3)];
      return hex(this.difficultyBite === 'A' ? t.difficultyA : t.difficultyB);
    }

    // Speed scaling needs sub-unit precision, so carry the fraction forward
    // rather than rounding it away every frame.
    stepCount(ent, base, scale) {
      ent._acc = (ent._acc || 0) + base * scale;
      const n = Math.floor(ent._acc);
      ent._acc -= n;
      return n;
    }

    // RECONSTRUCTED. The ROM's bat bookkeeping in $D0/$D1 didn't fully parse,
    // so this models what the bat visibly does: fly to the best available
    // target in its room, swap whatever it holds for it, then refuse to grab
    // again for a while so it actually carries the loot somewhere.
    updateBat() {
      const bat = this.ents['bat'];
      if (!bat) return;
      bat.state = (bat.state + 1) % 8;              // wing flap

      if (this.bat.hold > 0) this.bat.hold--;

      let mask = this.pairMask('bat', this.beh.bat.priority, null);
      if (mask === 0 || this.bat.hold > 0) {
        // Wander: re-roll a heading every so often so it drifts between rooms.
        if (this.bat.wander <= 0) {
          const bits = [0x80, 0x40, 0x10, 0x20];
          this.bat.dir = bits[Math.floor(Math.random() * 4)] |
                         (Math.random() < 0.5 ? bits[Math.floor(Math.random() * 4)] : 0);
          this.bat.wander = 30 + Math.floor(Math.random() * 60);
        }
        this.bat.wander--;
        mask = this.bat.dir || 0x80;
      }
      this.moveEntity(bat, mask,
        this.stepCount(bat, 3, this.tuning.batSpeedScale), false);

      // Drag whatever it holds along with it.
      if (this.bat.carrying) {
        const held = this.ents[this.bat.carrying];
        if (held) {
          held.room = bat.room; held.x = bat.x; held.y = bat.y - 8;
          this.clampToField(held);
        }
      }

      if (this.bat.hold > 0) return;
      for (const rule of this.beh.bat.priority) {
        const target = this.ents[rule.second];
        if (!target || target.room !== bat.room) continue;
        if (target.name === this.bat.carrying) continue;
        if (!this.overlaps(this.boxOf(bat), this.boxOf(target))) continue;

        const dropped = this.bat.carrying;
        if (dropped) {
          const d = this.ents[dropped];
          if (d) { d.room = bat.room; d.x = bat.x; d.y = bat.y; }
        }
        this.bat.carrying = target.name;
        if (this.carrying === target.name) {
          this.carrying = null;
          this.note('the bat stole your ' + target.name);
        } else {
          this.note('the bat took the ' + target.name);
        }
        this.emit('batSteal');
        this.bat.hold = 120;
        break;
      }
    }

    updateMagnet() {
      const m = this.ents['magnet'];
      if (!m) return;
      for (const rule of this.beh.magnet.attracts) {
        const o = this.ents[rule.first];
        if (!o || o.room !== m.room) continue;
        if (this.carrying === o.name) continue;
        // Attraction is a hard 8-unit yank per frame, not a gentle drift.
        if (o.y < m.y) o.y = Math.min(m.y, o.y + 8);
        else if (o.y > m.y) o.y = Math.max(m.y, o.y - 8);
        if (o.x < m.x) o.x = Math.min(m.x, o.x + 8);
        else if (o.x > m.x) o.x = Math.max(m.x, o.x - 8);
        break;                                       // one object at a time
      }
    }

    // ------------------------------------------------------------- carrying

    // Anything positioned by being attached to something else -- carried by the
    // player, hauled by the bat -- bypasses the edge logic entirely, so it has
    // to be clamped explicitly or it walks straight out of the field at a
    // room boundary.
    clampToField(o) {
      o.x = Math.max(0x03, Math.min(0x9E, o.x));
      o.y = Math.max(0x0D, Math.min(0x69, o.y));
    }

    updateCarried() {
      if (!this.carrying) return;
      const e = this.ents[this.carrying];
      if (!e) { this.carrying = null; return; }
      e.room = this.player.room;
      e.x = (this.player.x + this.carryOff.x) & 0xFF;
      e.y = (this.player.y + this.carryOff.y) & 0xFF;
      if (e.x >= 0xF0) e.x = 0x03;                 // undo byte wrap first
      if (e.y >= 0xF0) e.y = 0x0D;
      this.clampToField(e);
    }

    tryPickup() {
      if (this.carrying) return;
      for (const name in this.ents) {
        if (name === 'bat' || name.startsWith('dragon')) continue;
        if (name === this.bat.carrying) continue;
        // You drop a thing while standing on it, so without this the auto
        // pickup re-grabs it on the very next frame and the drop button looks
        // dead. The lock clears as soon as you step off it.
        if (name === this.justDropped) continue;
        const e = this.ents[name];
        if (!this.touching(e)) continue;
        this.carrying = name;
        // The offset is captured at the moment of contact and never changes.
        // That is why *how* you grab something decides how it dangles -- and
        // it's what lets you hold a sword out in front of you.
        this.carryOff = { x: e.x - this.player.x, y: e.y - this.player.y };
        this.note('picked up the ' + name);
        this.emit('pickup');
        return;
      }
    }

    drop() {
      if (!this.carrying) return;
      this.note('dropped the ' + this.carrying);
      this.emit('drop');
      this.justDropped = this.carrying;
      this.carrying = null;
    }

    // Release the drop lock once the player is clear of the item.
    updateDropLock() {
      if (!this.justDropped) return;
      const e = this.ents[this.justDropped];
      if (!e || !this.touching(e)) this.justDropped = null;
    }

    // --------------------------------------------------------------- gates

    // RECONSTRUCTED entry. The gate animation and the key pairing come from the
    // ROM; the trigger geometry is measured off the castle bitmap, because that
    // routine did not disassemble cleanly.
    //
    // All three castles share one graphic, so the gateway is the same gap in
    // every one: playfield row 4 has an opening at columns 18..21, which is
    // x 72..87, y 33..48. Row 3 above it is solid, so the gap is a dead end you
    // walk up into -- which is exactly what makes it a door.
    updateGates() {
      const GATE = { x0: 72, x1: 88, yEnter: 0x2C, yBars: 0x21, yReach: 0x1C };
      const cx = this.player.x + PLAYER_W / 2;
      const inGateway = cx >= GATE.x0 && cx < GATE.x1;

      for (const c of this.beh.castles) {
        const ext = hex(c.exteriorRoom);
        if (this.player.room !== ext || !inGateway) continue;

        // Holding the matching key against the gate drives the animation.
        // 0x1C is fully shut; the counter runs 1 -> 0x38 and wraps, opening as
        // it climbs past 0x1C.
        if (this.carrying === c.key && this.player.y >= GATE.yReach) {
          let st = this.gates[c.gate];
          st = (st + 1) % 0x38;
          if (st === 0) st = 1;
          this.gates[c.gate] = st;
          this.emit('gate');
        }

        if (this.gates[c.gate] === 0x1C) {
          // Bars down: they physically fill the gap.
          if (this.player.y > GATE.yBars) this.player.y = GATE.yBars;
        } else if (this.player.y >= GATE.yEnter) {
          this.player.room = hex(c.interiorRoom);
          this.player.x = 0x50; this.player.y = 0x18;
          this.note('entered the ' + c.castle + ' castle');
          this.emit('castle');
        }
      }
    }

    // Any room whose colour is 08 is dark: a solid box follows the player and
    // occludes the rest of the room. Not fog of war, not a light -- a rectangle.
    isDark(roomId) {
      const r = this.room(roomId);
      return !!r && r.color === '08';
    }

    // ---------------------------------------------------------------- frame

    step(input) {
      this.events = [];
      if (this.won) { this.winFrame++; return; }
      this.frame++;

      const eaten = Object.values(this.ents).some(
        e => e.name.startsWith('dragon') && e.state === 2);

      if (!eaten) {
        let mask = 0;
        if (input.right) mask |= 0x80;
        if (input.left) mask |= 0x40;
        if (input.up) mask |= 0x10;
        if (input.down) mask |= 0x20;
        if (mask) this.moveEntity(this.player, mask, this.tuning.playerSteps, true);
      }

      this.updateCarried();
      this.updateDragons();
      this.updateBat();
      this.updateMagnet();
      this.updateGates();
      this.updateCarried();

      this.updateDropLock();
      if (input.firePressed) { if (this.carrying) this.drop(); else this.tryPickup(); }
      else if (!this.carrying && !input.fire) this.tryPickup();

      const chalice = this.ents['chalice'];
      if (chalice && chalice.room === 0x12) {
        this.won = true;
        this.winFrame = 0;
        this.note('*** the chalice is home -- you win ***');
        this.emit('win');
      }
    }
  }

  Engine.FIELD = FIELD;
  Engine.PLAYER_W = PLAYER_W;
  Engine.PLAYER_H = PLAYER_H;
  Engine.rowOf = rowOf;
  Engine.colOf = colOf;
  ADV.Engine = Engine;

})(window.ADV = window.ADV || {});
