// view3d.js -- STEP 3 SPIKE. Camera, scale and speed.
//
// This is not the game renderer. It is a measuring instrument, built to answer
// three questions that cannot be answered on paper:
//
//   1. How big is a room, in metres?
//   2. How fast does everything move, in metres per second?
//   3. Which camera makes a maze designed for a top-down view still *fair*
//      when you can no longer see over the walls?
//
// It runs on the same engine as the 2D view, reading state through the same
// interface, which is the point -- see DECISIONS.md on the Easter Egg Version.
//
// WHY A SOFTWARE RASTERISER. The world is axis-aligned boxes on a flat plane,
// which is the one case where painter's algorithm is genuinely correct and a
// few hundred lines beats pulling in a 3D library. It also keeps the whole
// project dependency-free and runnable from file://, and it makes the
// projection maths visible instead of hidden behind an engine's conventions.
// Whatever renders the real game will not be this.
//
// SPACES.
//   unit space  -- the engine's. 160 x 96, y increases UP the screen.
//   world space -- metres. X = east, Y = up, Z = north. Z maps from unit y,
//                  so "up the screen" is "away from a southern camera".
// The only conversion is `mu` metres per unit, applied identically to both
// axes so the engine's collision maths stays untouched.

(function (ADV) {
  'use strict';

  const P = ADV.Palette;
  const NEAR = 0.05;

  // Playfield rows are not evenly spaced -- the top and bottom bands are short.
  // This is the inverse of Engine.rowOf, and it has to agree with it exactly or
  // walls render offset from where they collide.
  function rowSpan(r) {
    return { z0: Math.max(8, 97 - 16 * r), z1: Math.min(104, 113 - 16 * r) };
  }

  // Real-world heights, in metres. These are a first guess to be argued with in
  // step 5, not a decision -- but SOMETHING has to be picked before scale can
  // be judged, and "a dragon is as tall as its sprite" is badly wrong: a sprite
  // 20 units tall would be a 5-metre dragon at working scale.
  const HEIGHT_M = {
    player: 1.7, 'dragon-yorgle': 3.2, 'dragon-grundle': 3.2,
    'dragon-rhindle': 3.4, bat: 0.9, chalice: 0.55, sword: 1.1,
    bridge: 0.25, magnet: 0.5, dot: 0.15,
    'key-gold': 0.35, 'key-white': 0.35, 'key-black': 0.35
  };

  const LIGHT = (function () {
    const v = [-0.40, 0.86, -0.32];
    const n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
  })();

  class View3D {
    constructor(eng, canvas) {
      this.eng = eng;
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');

      this.opt = {
        mPerCell: 1.00,   // metres across one playfield column (4 units)
        // DEPTH STRETCH. Playfield cells are 4 units wide but ~14 units deep,
        // and the original's TV pixels were not square either, so the grid you
        // remember is made of tall rectangles. Mapping units to metres
        // uniformly is faithful to the collision space but turns every maze
        // wall into a slab deeper than it is tall. This scales the north-south
        // axis independently so the trade can actually be seen. 1.0 is
        // unit-faithful; below 1.0 squares the cells up.
        zStretch: 1.00,
        wallH: 2.50,      // metres
        eyeH: 1.60,
        fov: 60,          // vertical, degrees
        cam: 'follow',    // overhead | tilt | follow | fp
        pitch: 50,        // look-down angle for tilt and follow
        dist: 16,         // follow distance, metres
        turnWithMotion: false,
        fog: true,
        showFoot: false   // draw true collision footprints on the floor
      };

      this.yaw = 0;         // smoothed heading, for fp and turn-with-motion
      this.faces = [];
      this.wallCache = { id: null, cell: null, wallH: null, boxes: null };
    }

    get mu() { return this.opt.mPerCell / 4; }
    get muZ() { return this.mu * this.opt.zStretch; }
    get roomW() { return 160 * this.mu; }
    get roomD() { return 96 * this.muZ; }

    // ------------------------------------------------------------ derived numbers
    //
    // The whole point of the spike. Everything the engine does is in units per
    // tick; these turn that into metres per second so it can be judged against
    // a human being. A brisk run is about 5 m/s and a sprint about 8.
    metrics(tickHz) {
      const mu = this.mu, t = this.eng.tuning;
      const pv = t.playerSteps * mu * tickHz;
      const dv = 2 * t.dragonSpeedScale * mu * tickHz;   // yorgle / grundle
      const rv = 3 * t.dragonSpeedScale * mu * tickHz;   // rhindle
      return {
        mu: mu,
        roomW: this.roomW, roomD: this.roomD,
        playerSpeed: pv,
        dragonSpeed: dv,
        rhindleSpeed: rv,
        crossX: 160 / (t.playerSteps * tickHz),          // seconds, wall to wall
        crossY: 96 / (t.playerSteps * tickHz),
        ratio: dv > 0 ? pv / dv : Infinity,
        ratioRhindle: rv > 0 ? pv / rv : Infinity
      };
    }

    // ------------------------------------------------------------------ camera
    //
    // Smallest pull-back that keeps every corner of the room on screen.
    //
    // A bounding sphere is the usual shortcut and it is badly wrong here: a
    // room is 40 m wide and 13 m deep, so its diagonal is nearly its width and
    // fitting a sphere of that radius pushes the camera far enough back that
    // the room fills a third of the frame. Binary-searching the real corners
    // costs forty cheap iterations and frames it exactly.
    frameDistance(yaw, pitch, target) {
      const H = this.cv.height, W = this.cv.width;
      const f = (H / 2) / Math.tan(this.opt.fov * Math.PI / 360);
      const F = fwd(yaw, pitch), R = right(yaw), U = up(yaw, pitch);
      const margin = 0.95;

      const pts = [];
      for (const y of [0, this.opt.wallH]) {
        pts.push([0, y, 0], [this.roomW, y, 0],
                 [0, y, this.roomD], [this.roomW, y, this.roomD]);
      }

      const fits = (d) => {
        const cx = target[0] - F[0] * d, cy = target[1] - F[1] * d,
              cz = target[2] - F[2] * d;
        for (const p of pts) {
          const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
          const z = dx * F[0] + dy * F[1] + dz * F[2];
          if (z < 0.5) return false;
          const x = dx * R[0] + dy * R[1] + dz * R[2];
          const y = dx * U[0] + dy * U[1] + dz * U[2];
          if (Math.abs(x * f / z) > W / 2 * margin) return false;
          if (Math.abs(y * f / z) > H / 2 * margin) return false;
        }
        return true;
      };

      let lo = 0.5, hi = 3000;
      if (!fits(hi)) return hi;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid; else lo = mid;
      }
      return hi;
    }

    fixedCam(pitch) {
      const tgt = [this.roomW / 2, 0, this.roomD / 2];
      const d = this.frameDistance(0, pitch, tgt);
      const F = fwd(0, pitch);
      return { x: tgt[0] - F[0] * d, y: tgt[1] - F[1] * d, z: tgt[2] - F[2] * d,
               yaw: 0, pitch: pitch };
    }

    camera(st) {
      const o = this.opt, mu = this.mu;
      const px = st.player.x * mu, pz = st.player.y * this.muZ;

      if (o.cam === 'overhead') return this.fixedCam(-Math.PI / 2 + 0.001);
      if (o.cam === 'tilt') return this.fixedCam(-o.pitch * Math.PI / 180);
      if (o.cam === 'fp') {
        return { x: px, y: o.eyeH, z: pz, yaw: this.yaw, pitch: -0.06 };
      }
      // follow
      const pitch = -o.pitch * Math.PI / 180;
      const yaw = o.turnWithMotion ? this.yaw : 0;
      const F = fwd(yaw, pitch);
      const tgt = { x: px, y: o.wallH * 0.45, z: pz };
      return { x: tgt.x - F[0] * o.dist, y: tgt.y - F[1] * o.dist,
               z: tgt.z - F[2] * o.dist, yaw: yaw, pitch: pitch };
    }

    // Heading follows the last direction actually moved, smoothed. Matters only
    // for first person and the optional rotating follow cam.
    updateHeading(dx, dz) {
      if (!dx && !dz) return;
      const want = Math.atan2(dx, dz);
      let d = want - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * 0.18;
    }

    // ------------------------------------------------------------------ walls
    //
    // Adjacent solid cells in a row merge into one box. Without this every cell
    // boundary is a seam the painter's sort can flicker on, and the face count
    // roughly quadruples for no visual gain.
    wallBoxes(roomId) {
      const c = this.wallCache;
      if (c.id === roomId) return c.boxes;    // runs are in unit space, so
                                              // scale changes don't invalidate
      const r = this.eng.room(roomId);
      const boxes = [];
      if (r) {
        for (let row = 0; row < 7; row++) {
          const span = rowSpan(row), line = r.walls[row];
          let c0 = -1;
          for (let col = 0; col <= 40; col++) {
            const solid = col < 40 && line[col] === '#';
            if (solid && c0 < 0) c0 = col;
            if (!solid && c0 >= 0) {
              boxes.push({ x0: c0 * 4, x1: col * 4, z0: span.z0, z1: span.z1 });
              c0 = -1;
            }
          }
        }
      }
      this.wallCache = { id: roomId, boxes: boxes };
      return boxes;
    }

    // ------------------------------------------------------------------ faces

    pushBox(X0, X1, Y0, Y1, Z0, Z1, rgb, kind) {
      const q = (pts, n) => this.faces.push({ p: pts, n: n, c: rgb, kind: kind });
      q([[X0, Y1, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X0, Y1, Z1]], [0, 1, 0]);
      q([[X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0], [X1, Y0, Z0]], [0, 0, -1]);
      q([[X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1], [X0, Y0, Z1]], [0, 0, 1]);
      q([[X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0], [X0, Y0, Z0]], [-1, 0, 0]);
      q([[X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1]], [1, 0, 0]);
    }

    buildFaces(st) {
      const mu = this.mu, muZ = this.muZ, o = this.opt, eng = this.eng;
      this.faces = [];

      const room = eng.room(st.player.room);
      const base = room ? P.tiaRGB(room.color) : [40, 40, 40];
      // The room colour is the *wall* colour in the original -- the floor was
      // just background. Pushing them apart hard, because at a shallow camera
      // angle a wall and the floor in front of it share almost the same screen
      // normal and a subtle difference reads as one flat surface.
      const wallRGB = base;
      const floorRGB = base.map(v => Math.round(v * 0.30 + 10));

      // Floor: one quad. Grid lines are drawn later as overlay strokes, which
      // is far cheaper than 280 filled cells and reads better for depth.
      this.faces.push({
        p: [[0, 0, 0], [this.roomW, 0, 0], [this.roomW, 0, this.roomD], [0, 0, this.roomD]],
        n: [0, 1, 0],
        c: floorRGB,
        kind: 'floor'
      });

      for (const b of this.wallBoxes(st.player.room)) {
        this.pushBox(b.x0 * mu, b.x1 * mu, 0, o.wallH, b.z0 * muZ, b.z1 * muZ,
                     wallRGB, 'wall');
      }

      // Entities. Footprint comes from the engine's own foot box so what you
      // see standing on the floor is what actually collides.
      for (const name in st.ents) {
        const e = st.ents[name];
        if (e.room !== st.player.room) continue;
        if (name === 'surround') continue;                 // darkness is step 5
        if (name === eng.bat.carrying && name !== 'bat') { /* still drawn */ }

        const meta = eng.objMeta[name];
        const h = eng.heightOf(e);
        const foot = Math.min(8, h);
        const w = (meta ? meta.width : 8) * mu;
        const d = foot * muZ;
        const X0 = e.x * mu, Z0 = (e.y - h) * muZ;

        let tall = HEIGHT_M[name] || 0.6;
        if (name.indexOf('portcullis') === 0) tall = (h / 16) * o.wallH;

        const slain = name.indexOf('dragon') === 0 && e.state === 1;
        const rgb = slain ? [74, 74, 74]
                          : P.readableRGB(meta ? meta.color : '0E');

        this.pushBox(X0, X0 + w, 0, slain ? Math.min(tall, 0.5) : tall,
                     Z0, Z0 + d, rgb, 'ent');
      }

      // The player last, so ties in the depth sort resolve in their favour.
      const p = st.player;
      const pw = 4 * mu, pd = 8 * muZ;
      const shrink = 0.55;                  // drawn narrower than it collides
      const cxp = p.x * mu + pw / 2, czp = (p.y - 8) * muZ + pd / 2;
      this.pushBox(cxp - pw * shrink / 2, cxp + pw * shrink / 2,
                   0, HEIGHT_M.player,
                   czp - pd * shrink / 2, czp + pd * shrink / 2,
                   [235, 235, 245], 'player');
    }

    // ------------------------------------------------------------------- draw

    draw(st, tickHz) {
      const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
      const cam = this.camera(st);
      const room = this.eng.room(st.player.room);

      const sky = room ? P.tiaRGB(room.color).map(v => Math.round(v * 0.16 + 8))
                       : [12, 12, 16];
      ctx.fillStyle = 'rgb(' + sky.join(',') + ')';
      ctx.fillRect(0, 0, W, H);

      this.buildFaces(st);

      const fovY = this.opt.fov * Math.PI / 180;
      const f = (H / 2) / Math.tan(fovY / 2);
      const R = right(cam.yaw), F = fwd(cam.yaw, cam.pitch), U = up(cam.yaw, cam.pitch);

      const toCam = (v) => {
        const dx = v[0] - cam.x, dy = v[1] - cam.y, dz = v[2] - cam.z;
        return { x: dx * R[0] + dy * R[1] + dz * R[2],
                 y: dx * U[0] + dy * U[1] + dz * U[2],
                 z: dx * F[0] + dy * F[1] + dz * F[2] };
      };

      const fogFar = Math.max(this.roomW, this.roomD) * 1.5;
      const draw = [];

      for (const face of this.faces) {
        // Backface cull against the face's own plane.
        const c0 = face.p[0];
        const nd = face.n[0] * (c0[0] - cam.x) + face.n[1] * (c0[1] - cam.y) +
                   face.n[2] * (c0[2] - cam.z);
        if (nd >= 0 && face.kind !== 'floor') continue;

        const cs = face.p.map(toCam);
        if (cs.every(v => v.z < NEAR)) continue;
        const clipped = clipNear(cs);
        if (clipped.length < 3) continue;

        let depth = 0, n = 0;
        for (const v of cs) { depth += Math.hypot(v.x, v.y, v.z); n++; }
        depth /= n;

        const lam = Math.max(0, face.n[0] * LIGHT[0] + face.n[1] * LIGHT[1] +
                                face.n[2] * LIGHT[2]);
        let k = 0.42 + 0.58 * lam;
        let rgb = face.c.map(v => Math.min(255, v * k));

        if (this.opt.fog) {
          const t = Math.min(1, depth / fogFar);
          rgb = rgb.map((v, i) => v * (1 - t) + sky[i] * t);
        }

        draw.push({
          depth: depth,
          fill: 'rgb(' + rgb.map(v => Math.round(v)).join(',') + ')',
          pts: clipped.map(v => [W / 2 + v.x * f / v.z, H / 2 - v.y * f / v.z]),
          kind: face.kind
        });
      }

      draw.sort((a, b) => b.depth - a.depth);
      for (const d of draw) {
        ctx.beginPath();
        ctx.moveTo(d.pts[0][0], d.pts[0][1]);
        for (let i = 1; i < d.pts.length; i++) ctx.lineTo(d.pts[i][0], d.pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = d.fill;
        ctx.fill();
        if (d.kind === 'wall' || d.kind === 'ent' || d.kind === 'player') {
          ctx.strokeStyle = 'rgba(0,0,0,0.28)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      this.drawGrid(toCam, f, W, H);
      if (this.opt.showFoot) this.drawFootprints(st, toCam, f, W, H);
      this.drawOverlay(st, tickHz);
    }

    // Projected floor grid. Cheap depth cue, and it makes the 40x7 cell shape
    // visible -- which matters, because those cells are nothing like square.
    drawGrid(toCam, f, W, H) {
      const ctx = this.ctx, mu = this.mu;
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth = 1;
      const seg = (a, b) => {
        let ca = toCam(a), cb = toCam(b);
        if (ca.z < NEAR && cb.z < NEAR) return;
        if (ca.z < NEAR || cb.z < NEAR) {
          const t = (NEAR - ca.z) / (cb.z - ca.z);
          const mid = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: NEAR };
          if (ca.z < NEAR) ca = mid; else cb = mid;
        }
        ctx.beginPath();
        ctx.moveTo(W / 2 + ca.x * f / ca.z, H / 2 - ca.y * f / ca.z);
        ctx.lineTo(W / 2 + cb.x * f / cb.z, H / 2 - cb.y * f / cb.z);
        ctx.stroke();
      };
      const muZ = this.muZ;
      for (let c = 0; c <= 40; c += 2) {
        seg([c * 4 * mu, 0.01, 0], [c * 4 * mu, 0.01, this.roomD]);
      }
      for (let r = 0; r <= 7; r++) {
        const z = (r === 7 ? 8 : rowSpan(r).z1) * muZ;
        seg([0, 0.01, z], [this.roomW, 0.01, z]);
      }
    }

    // The true collision boxes, flat on the floor. The player is drawn narrower
    // than this on purpose -- see the note in buildFaces.
    drawFootprints(st, toCam, f, W, H) {
      const ctx = this.ctx, mu = this.mu, muZ = this.muZ, eng = this.eng;
      const quad = (x0, z0, x1, z1, col) => {
        const pts = [[x0, 0.02, z0], [x1, 0.02, z0], [x1, 0.02, z1], [x0, 0.02, z1]]
          .map(toCam);
        if (pts.some(v => v.z < NEAR)) return;
        ctx.beginPath();
        pts.forEach((v, i) => {
          const sx = W / 2 + v.x * f / v.z, sy = H / 2 - v.y * f / v.z;
          i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
        });
        ctx.closePath();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      };
      for (const name in st.ents) {
        const e = st.ents[name];
        if (e.room !== st.player.room || name === 'surround') continue;
        const meta = eng.objMeta[name];
        const h = eng.heightOf(e), foot = Math.min(8, h);
        quad(e.x * mu, (e.y - h) * muZ,
             (e.x + (meta ? meta.width : 8)) * mu, (e.y - h + foot) * muZ,
             'rgba(255,90,90,0.75)');
      }
      const p = st.player;
      quad(p.x * mu, (p.y - 8) * muZ, (p.x + 4) * mu, p.y * muZ,
           'rgba(120,220,255,0.9)');
    }

    drawOverlay(st, tickHz) {
      const ctx = this.ctx, m = this.metrics(tickHz), o = this.opt;
      const room = this.eng.room(st.player.room);
      ctx.font = '12px monospace';
      ctx.textBaseline = 'top';

      const lines = [
        'camera  ' + o.cam + (o.cam === 'follow' || o.cam === 'tilt'
                     ? '  pitch ' + o.pitch + '°' : ''),
        'room    ' + (room ? room.name : '?') + '   ' +
                     m.roomW.toFixed(1) + ' x ' + m.roomD.toFixed(1) + ' m',
        'cell    ' + o.mPerCell.toFixed(2) + ' wide x ' +
                     (16 * this.muZ).toFixed(2) + ' deep m',
        'you     ' + m.playerSpeed.toFixed(1) + ' m/s   ' +
                     m.crossX.toFixed(1) + ' s to cross',
        'dragons ' + m.dragonSpeed.toFixed(1) + ' m/s   you are ' +
                     m.ratio.toFixed(1) + 'x faster',
        'rhindle ' + m.rhindleSpeed.toFixed(1) + ' m/s   you are ' +
                     m.ratioRhindle.toFixed(1) + 'x faster'
      ];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(8, 8, 340, lines.length * 15 + 10);
      ctx.fillStyle = '#9fe89f';
      lines.forEach((s, i) => ctx.fillText(s, 14, 14 + i * 15));

      // A human reference bar, so "9 m/s" means something.
      const warn = m.playerSpeed > 12 ? '#ff8a5c'
                 : m.playerSpeed < 3.5 ? '#ffd479' : '#9fe89f';
      ctx.fillStyle = warn;
      ctx.fillText(m.playerSpeed > 12 ? 'faster than a car in town'
                 : m.playerSpeed < 3.5 ? 'slower than a jog'
                 : 'human running speed', 14, 14 + lines.length * 15 - 1);
    }
  }

  // ------------------------------------------------------------------ maths

  function fwd(yaw, pitch) {
    return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch)];
  }
  function right(yaw) { return [Math.cos(yaw), 0, -Math.sin(yaw)]; }
  function up(yaw, pitch) {
    return [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch),
            -Math.cos(yaw) * Math.sin(pitch)];
  }

  // Sutherland-Hodgman against the single near plane. Without this, anything
  // straddling the camera plane projects to garbage -- which is most of the
  // world in first person.
  function clipNear(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a.z) / (b.z - a.z);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR });
      }
    }
    return out;
  }

  ADV.View3D = View3D;

})(window.ADV = window.ADV || {});
