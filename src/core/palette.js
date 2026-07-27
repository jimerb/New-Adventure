// palette.js -- TIA colour decoding, shared by every renderer.
//
// Lifted out of view2d.js the moment a second renderer appeared. Colour is a
// property of the *data* (rooms and objects carry TIA bytes), so decoding it
// belongs next to the data, not inside one view. The readability floor is the
// exception and is documented below.

(function (ADV) {
  'use strict';

  // Approximate NTSC TIA palette: 16 hues x 8 lumas. Good enough to tell
  // regions apart; not colour-accurate and not trying to be.
  const HUES = [
    [110, 110, 110], [124, 108, 0], [144, 88, 0], [152, 62, 40],
    [148, 46, 88], [120, 46, 132], [80, 54, 148], [40, 66, 148],
    [16, 82, 132], [16, 100, 104], [16, 112, 72], [24, 112, 40],
    [52, 108, 24], [80, 96, 24], [116, 84, 24], [136, 72, 24]
  ];

  function tiaRGB(hexStr) {
    const v = parseInt(hexStr, 16);
    const hue = (v >> 4) & 0x0F;
    const lum = (v >> 1) & 0x07;
    const base = HUES[hue];
    const k = 0.28 + (lum / 7) * 0.85;
    const f = c => Math.max(0, Math.min(255, Math.round(c * k + lum * 12)));
    return [f(base[0]), f(base[1]), f(base[2])];
  }

  function tia(hexStr) {
    const c = tiaRGB(hexStr);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  // READABILITY FLOOR, applied to objects only -- never to walls, and never to
  // the source data.
  //
  // The black key is colour 00 on a colour 08 floor, so in the black maze it is
  // very nearly invisible. That is authentic and it is also just bad. Lifting
  // it at the presentation layer keeps data/ honest while making the harness
  // playable. Whether the real game keeps the original's cruelty here is an
  // art-direction call for step 5.
  const MIN_LUM = 62;
  function readableRGB(hexStr) {
    const c = tiaRGB(hexStr);
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (lum >= MIN_LUM) return c;
    const lift = MIN_LUM - lum;
    return [Math.min(255, Math.round(c[0] + lift)),
            Math.min(255, Math.round(c[1] + lift)),
            Math.min(255, Math.round(c[2] + lift))];
  }

  function readable(hexStr) {
    const c = readableRGB(hexStr);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  ADV.Palette = { tiaRGB, tia, readable, readableRGB };

})(window.ADV = window.ADV || {});
