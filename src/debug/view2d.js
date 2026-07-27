// view2d.js -- throwaway top-down renderer for validating the engine.
//
// This is a test harness, not the game. Its whole job is to make engine state
// legible so we can answer "is the extracted data correct?" before any 3D work
// starts. It also doubles as the room editor view for authoring Level 4.
//
// Objects are drawn as labelled boxes at their true unit dimensions rather
// than as sprites -- the original artwork stays out of this repo, and a box
// with a letter on it is honestly easier to debug against.

(function (ADV) {
  'use strict';

  // Colour decoding is shared with the 3D renderer -- see src/core/palette.js.
  const tia = ADV.Palette.tia;
  const readable = ADV.Palette.readable;

  const LABEL = {
    'dot': '.', 'sword': 'S', 'chalice': 'C', 'bridge': 'B', 'magnet': 'M',
    'key-gold': 'k', 'key-white': 'k', 'key-black': 'k', 'bat': 'V',
    'dragon-rhindle': 'R', 'dragon-yorgle': 'Y', 'dragon-grundle': 'G'
  };

  // ---------------------------------------------------------------- shapes
  //
  // Original artwork, drawn as vector primitives in a normalised 0..1 box and
  // stretched to each object's true unit dimensions. These are NOT the ROM's
  // sprites -- see ANALYSIS.md section 8 -- they're throwaway stand-ins whose
  // only job is to make pose readable at a glance. A dragon's state machine is
  // invisible when it's a rectangle.
  //
  // Note the aspect ratios are severe on purpose: a dragon is 8 units wide and
  // 20 tall, so it reads as narrow and towering. That's faithful, and it's
  // useful to see now, before we commit to 3D proportions.
  //
  // Primitives: ['e',cx,cy,rx,ry] ellipse | ['r',x,y,w,h] rect | ['p',[[x,y]..]] polygon

  const DRAGON_BODY = [
    ['e', 0.50, 0.66, 0.40, 0.26],                              // body
    ['r', 0.36, 0.26, 0.26, 0.30],                              // neck
    ['p', [[0.84, 0.60], [1.00, 0.92], [0.74, 0.80]]],          // tail
    ['r', 0.22, 0.86, 0.14, 0.14],                              // foreleg
    ['r', 0.62, 0.86, 0.14, 0.14]                               // hind leg
  ];

  const SHAPES = {
    'dragon-upright': DRAGON_BODY.concat([
      ['e', 0.46, 0.16, 0.28, 0.13],                            // head
      ['p', [[0.06, 0.17], [0.44, 0.07], [0.44, 0.25]]],        // snout
      ['p', [[0.60, 0.01], [0.76, 0.14], [0.54, 0.11]]]         // crest
    ]),
    'dragon-jaws': DRAGON_BODY.concat([
      ['e', 0.50, 0.17, 0.26, 0.12],                            // head
      ['p', [[0.02, 0.02], [0.48, 0.12], [0.44, 0.17]]],        // upper jaw
      ['p', [[0.02, 0.32], [0.48, 0.20], [0.44, 0.15]]],        // lower jaw
      ['p', [[0.62, 0.02], [0.78, 0.15], [0.56, 0.12]]]         // crest
    ]),
    'bat-down': [
      ['e', 0.50, 0.55, 0.16, 0.35],                            // body
      ['p', [[0.34, 0.30], [0.00, 0.10], [0.06, 0.62], [0.34, 0.66]]],
      ['p', [[0.66, 0.30], [1.00, 0.10], [0.94, 0.62], [0.66, 0.66]]],
      ['p', [[0.40, 0.02], [0.50, 0.18], [0.60, 0.02]]]         // ears
    ],
    'bat-up': [
      ['e', 0.50, 0.62, 0.16, 0.30],
      ['p', [[0.34, 0.55], [0.02, 0.86], [0.10, 0.34], [0.36, 0.32]]],
      ['p', [[0.66, 0.55], [0.98, 0.86], [0.90, 0.34], [0.64, 0.32]]],
      ['p', [[0.40, 0.20], [0.50, 0.36], [0.60, 0.20]]]
    ],
    'chalice': [
      ['p', [[0.08, 0.00], [0.92, 0.00], [0.74, 0.42], [0.26, 0.42]]],  // bowl
      ['r', 0.42, 0.42, 0.16, 0.36],                                     // stem
      ['p', [[0.14, 1.00], [0.86, 1.00], [0.72, 0.78], [0.28, 0.78]]]    // foot
    ],
    'sword': [
      ['p', [[0.00, 0.50], [0.34, 0.16], [0.34, 0.84]]],        // point
      ['r', 0.34, 0.36, 0.44, 0.28],                            // blade
      ['r', 0.78, 0.04, 0.09, 0.92],                            // crossguard
      ['r', 0.90, 0.34, 0.10, 0.32]                             // grip
    ],
    'magnet': [
      ['p', [[0.00, 1.00], [0.00, 0.42], [0.20, 0.06], [0.80, 0.06],
             [1.00, 0.42], [1.00, 1.00], [0.70, 1.00], [0.70, 0.46],
             [0.60, 0.30], [0.40, 0.30], [0.30, 0.46], [0.30, 1.00]]]
    ],
    'key': [
      ['e', 0.16, 0.50, 0.16, 0.42],                            // bow
      ['r', 0.30, 0.36, 0.62, 0.28],                            // shaft
      ['r', 0.70, 0.64, 0.10, 0.30],                            // tooth
      ['r', 0.88, 0.64, 0.10, 0.30]
    ],
    'bridge': [
      ['r', 0.00, 0.00, 0.26, 1.00],                            // left post
      ['r', 0.74, 0.00, 0.26, 1.00],                            // right post
      ['r', 0.26, 0.06, 0.48, 0.06],                            // rails
      ['r', 0.26, 0.88, 0.48, 0.06]
    ],
    'dot': [['r', 0.0, 0.0, 1.0, 1.0]]
  };

  function shapeFor(name, state) {
    if (name.startsWith('dragon')) {
      return state >= 3 ? SHAPES['dragon-jaws'] : SHAPES['dragon-upright'];
    }
    if (name === 'bat') return (state < 4) ? SHAPES['bat-down'] : SHAPES['bat-up'];
    if (name.startsWith('key')) return SHAPES['key'];
    return SHAPES[name] || null;
  }

  class View2D {
    constructor(engine, canvas, hud) {
      this.eng = engine;
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.hud = hud;
      this.scale = 6;
      this.showGrid = false;
      this.showBoxes = false;
      this.showDark = true;
      this.cv.width = ADV.Engine.FIELD.width * this.scale;
      this.cv.height = ADV.Engine.FIELD.height * this.scale;
    }

    // Unit space has y increasing upward; canvas has it increasing downward.
    sx(x) { return x * this.scale; }
    sy(y) { return (ADV.Engine.FIELD.top - y) * this.scale; }

    draw() {
      const e = this.eng, F = ADV.Engine.FIELD, ctx = this.ctx;
      const room = e.room(e.player.room);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      if (!room) return;

      // Walls. Row bands are uneven (see engine rowOf) so each is drawn from
      // its real top and bottom y rather than at a uniform height.
      const wallCol = tia(room.color);
      for (let r = 0; r < 7; r++) {
        const yTop = (r === 0) ? F.top : (0x60 - (r - 1) * 16);
        const yBot = (r === 6) ? F.bottom : (yTop - (r === 0 ? 7 : 15));
        for (let c = 0; c < 40; c++) {
          if (room.walls[r][c] !== '#') continue;
          ctx.fillStyle = wallCol;
          ctx.fillRect(this.sx(c * 4), this.sy(yTop),
                       4 * this.scale, (yTop - yBot + 1) * this.scale);
        }
      }

      if (this.showGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        for (let c = 0; c <= 40; c++) {
          ctx.beginPath();
          ctx.moveTo(this.sx(c * 4), 0);
          ctx.lineTo(this.sx(c * 4), this.cv.height);
          ctx.stroke();
        }
      }

      for (const name in e.ents) {
        const o = e.ents[name];
        if (o.room !== e.player.room) continue;
        this.drawEnt(o);
      }
      this.drawGate(room);
      this.drawPlayer();

      // The surround: a solid box that hides the room, drawn as four black
      // rects around a window on the player. This is the real mechanic.
      if (this.showDark && e.isDark(e.player.room)) {
        const px = this.sx(e.player.x) + this.scale * 2;
        const py = this.sy(e.player.y) + this.scale * 4;
        const w = 34 * this.scale, h = 26 * this.scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.cv.width, py - h);
        ctx.fillRect(0, py + h, this.cv.width, this.cv.height);
        ctx.fillRect(0, py - h, px - w, 2 * h);
        ctx.fillRect(px + w, py - h, this.cv.width, 2 * h);
      }

      if (e.won) this.drawWin();
      this.drawHud();
    }

    // Placeholder win state: the room cycles through hues, the way the original
    // flashes when the chalice comes home. Not the real celebration -- just
    // proof the win actually fires and something happens.
    drawWin() {
      const ctx = this.ctx, f = this.eng.winFrame;
      const hue = (f * 6) % 360;
      ctx.globalAlpha = 0.30 + 0.16 * Math.sin(f / 5);
      ctx.fillStyle = 'hsl(' + hue + ',85%,55%)';
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
      ctx.globalAlpha = 1;

      const msg = 'THE CHALICE IS HOME';
      ctx.font = 'bold ' + (this.scale * 5) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.strokeText(msg, this.cv.width / 2, this.cv.height / 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(msg, this.cv.width / 2, this.cv.height / 2);
      ctx.font = 'bold ' + (this.scale * 2.2) + 'px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText('press R to play again',
                   this.cv.width / 2, this.cv.height / 2 + this.scale * 6);
      ctx.textAlign = 'left';
    }

    // Draw a normalised shape stretched into a pixel rect.
    paintShape(shape, px, py, pw, ph) {
      const ctx = this.ctx;
      const X = u => px + u * pw, Y = v => py + v * ph;
      for (const part of shape) {
        ctx.beginPath();
        if (part[0] === 'e') {
          ctx.ellipse(X(part[1]), Y(part[2]),
                      Math.max(1, part[3] * pw), Math.max(1, part[4] * ph),
                      0, 0, Math.PI * 2);
        } else if (part[0] === 'r') {
          ctx.rect(X(part[1]), Y(part[2]), part[3] * pw, part[4] * ph);
        } else {
          const pts = part[1];
          ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
          for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
          ctx.closePath();
        }
        ctx.fill();
      }
    }

    drawEnt(o) {
      const ctx = this.ctx, e = this.eng;
      const meta = e.objMeta[o.name];
      const b = e.boxOf(o);
      const px = this.sx(b.x), py = this.sy(b.y);
      const pw = b.w * this.scale, ph = b.h * this.scale;
      const slain = o.name.startsWith('dragon') && o.state === 1;

      ctx.fillStyle = slain ? '#4a4a4a' : (meta ? readable(meta.color) : '#fff');

      const shape = shapeFor(o.name, o.state);
      if (!shape) {
        ctx.fillRect(px, py, pw, ph);
      } else if (slain) {
        // A slain dragon lies on its back. Rotating the live silhouette reads
        // instantly and costs nothing.
        ctx.save();
        ctx.translate(px + pw / 2, py + ph / 2);
        ctx.rotate(Math.PI / 2);
        this.paintShape(shape, -ph / 2, -pw / 2, ph, pw);
        ctx.restore();
      } else {
        this.paintShape(shape, px, py, pw, ph);
      }

      if (this.showBoxes) {
        // The true collision box, so art and physics can be compared. Note it
        // is NOT the sprite box -- creatures collide on their feet only.
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.strokeRect(px, py, pw, ph);
        const f = e.footBox(o, false);
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.strokeRect(this.sx(f.x), this.sy(f.y), f.w * this.scale, f.h * this.scale);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + (this.scale * 2.5) + 'px monospace';
        ctx.fillText(LABEL[o.name] || '?', px, py - 2);
      }

      if (e.bat.carrying === o.name) {
        ctx.strokeStyle = '#ff0';
        ctx.strokeRect(px - 2, py - 2, pw + 4, ph + 4);
      }
    }

    drawGate(room) {
      const e = this.eng;
      for (const c of e.beh.castles) {
        if (parseInt(c.exteriorRoom, 16) !== e.player.room) continue;
        const st = e.gates[c.gate];
        const meta = e.objMeta[c.gate];
        const h = (function () {
          for (const f of meta.frames) if (st <= parseInt(f.maxState, 16)) return f.height;
          return 0;
        })();
        // A barred lattice, so you can see it slide rather than just change
        // height. Bars extend downward from the top of the gateway.
        const px = this.sx(0x4D), py = this.sy(0x31);
        const pw = 8 * this.scale, ph = h * this.scale;
        const ctx = this.ctx;
        ctx.fillStyle = st === 0x1C ? '#e8e8e8' : '#9a9a9a';
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(px + i * (pw / 4), py, Math.max(1, pw / 8), ph);
        }
        for (let yy = 0; yy < h; yy += 4) {
          ctx.fillRect(px, py + yy * this.scale, pw, Math.max(1, this.scale));
        }
      }
    }

    drawPlayer() {
      const e = this.eng, ctx = this.ctx;
      ctx.fillStyle = '#fff';
      ctx.fillRect(this.sx(e.player.x), this.sy(e.player.y),
                   ADV.Engine.PLAYER_W * this.scale, ADV.Engine.PLAYER_H * this.scale);
    }

    drawHud() {
      const e = this.eng;
      const room = e.room(e.player.room);
      const gates = Object.keys(e.gates)
        .map(k => k.replace('portcullis-', '')[0].toUpperCase() +
                  (e.gates[k] === 0x1C ? '✕' : '✓')).join(' ');
      const lines = [
        'game ' + e.game + '   frame ' + e.frame +
          '   bite ' + e.difficultyBite + '   sword-fear ' + e.difficultySword,
        'room ' + room.id + ' ' + room.name + '   colour ' + room.color +
          (e.isDark(e.player.room) ? '   [DARK]' : '') +
          (room.mirrored ? '' : '   [REPEATED]'),
        'pacing ' + e.pacing.toUpperCase() +
          '   dragon x' + e.tuning.dragonSpeedScale.toFixed(2) +
          '   bite ' + (e.tuning.biteFrames == null
              ? 'ROM' : e.tuning.biteFrames + 'f') +
          ' (' + ((e.tuning.biteFrames == null ? 12 : e.tuning.biteFrames) / 60)
              .toFixed(2) + 's)',
        'pos ' + e.player.x + ',' + e.player.y +
          '   carrying: ' + (e.carrying || '-') +
          '   bat holds: ' + (e.bat.carrying || '-'),
        'gates ' + gates + (e.won ? '     *** YOU WIN ***' : '')
      ];
      this.hud.textContent = lines.join('\n') + '\n\n' + e.log.slice(-6).join('\n');
    }
  }

  ADV.View2D = View2D;

})(window.ADV = window.ADV || {});
