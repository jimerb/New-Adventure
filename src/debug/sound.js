// sound.js -- placeholder audio for the debug harness.
//
// NOT the sound design. These are bare WebAudio tones whose only job is to
// confirm that game events actually fire, and to make the harness playable
// without staring at the log. Real audio is a step 8 concern.
//
// The engine emits event names and knows nothing about any of this; see
// Engine.emit(). The original drove six sound slots off two zero-page bytes
// (type and duration) -- the event names map roughly onto those slots, so this
// is the right seam to replace later.

(function (ADV) {
  'use strict';

  // type: 'sq' square-ish, 'tri' soft, 'noise' for the bat
  const CUES = {
    pickup:   { type: 'sq',    freq: 660, to: 880, dur: 0.07, gain: 0.16 },
    drop:     { type: 'sq',    freq: 440, to: 260, dur: 0.09, gain: 0.16 },
    gate:     { type: 'tri',   freq: 180, to: 240, dur: 0.06, gain: 0.14 },
    castle:   { type: 'tri',   freq: 320, to: 480, dur: 0.18, gain: 0.16 },
    lunge:    { type: 'sq',    freq: 150, to: 90,  dur: 0.16, gain: 0.22 },
    swallow:  { type: 'sq',    freq: 110, to: 40,  dur: 0.55, gain: 0.28 },
    slay:     { type: 'sq',    freq: 900, to: 120, dur: 0.40, gain: 0.24 },
    batSteal: { type: 'noise', freq: 0,   to: 0,   dur: 0.16, gain: 0.13 },
    secret:   { type: 'tri',   freq: 523, to: 1046, dur: 0.5, gain: 0.20 }
  };

  // A short rising figure for the win. Deliberately not a tune -- just enough
  // to read as "you did it" while we decide what winning should sound like.
  const FANFARE = [392, 523, 659, 784, 1046];

  class Sound {
    constructor() {
      this.ctx = null;
      this.enabled = true;
    }

    // Browsers refuse to start audio until the user interacts, so the context
    // is created lazily on the first keypress rather than at load.
    wake() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    blip(cue, when) {
      const ctx = this.ctx;
      const t = (when || ctx.currentTime);
      const g = ctx.createGain();
      g.gain.setValueAtTime(cue.gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + cue.dur);
      g.connect(ctx.destination);

      if (cue.type === 'noise') {
        const n = Math.floor(ctx.sampleRate * cue.dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = ctx.createBufferSource();
        src.buffer = buf; src.connect(g); src.start(t);
        return;
      }
      const o = ctx.createOscillator();
      o.type = cue.type === 'tri' ? 'triangle' : 'square';
      o.frequency.setValueAtTime(cue.freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, cue.to), t + cue.dur);
      o.connect(g); o.start(t); o.stop(t + cue.dur + 0.02);
    }

    play(event) {
      if (!this.enabled) return;
      this.wake();
      if (!this.ctx) return;
      if (event === 'win') {
        const base = this.ctx.currentTime;
        FANFARE.forEach((f, i) => {
          this.blip({ type: 'tri', freq: f, to: f * 1.01, dur: 0.16, gain: 0.22 },
                    base + i * 0.13);
        });
        return;
      }
      const cue = CUES[event];
      if (cue) this.blip(cue);
    }

    consume(events) {
      for (const e of events) this.play(e);
    }
  }

  ADV.Sound = Sound;

})(window.ADV = window.ADV || {});
