const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const embedded = id => html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`))[1];
const codec = vm.runInNewContext(embedded('lcd-codec') + '\nLCDCodec;');
const colors = vm.runInNewContext(embedded('lcd-colors') + '\nLCDColors;');
const effects = vm.runInNewContext(embedded('lcd-text-effects') + '\nLCDTextEffects;');
const same = (a, b) => assert.deepEqual(Array.from(a), Array.from(b));

test('5bit golden vectors pack three pixels low-first, with no row padding', () => {
  const bitmap = new Uint8Array(1024);
  assert.equal(codec.safePixelsToString(bitmap, 5), '\u3000'.repeat(342));
  assert.equal(codec.safePixelsToString(bitmap.fill(31), 5), '\uafff'.repeat(341) + '\u301f');
  bitmap.fill(0);
  [[0, 1], [1, 2], [2, 4], [3, 8], [31, 16], [32, 17], [1022, 30], [1023, 31]].forEach(([i, value]) => { bitmap[i] = value; });
  const units = new Array(342).fill(0x3000);
  units[0] += 1 + 2 * 32 + 4 * 1024;
  units[1] += 8;
  units[10] += 16 * 32 + 17 * 1024;
  units[340] += 30 * 1024;
  units[341] += 31;
  const expected = String.fromCharCode(...units);
  assert.equal(codec.safePixelsToString(bitmap, 5), expected);
  same(codec.safeStringToPixels(expected), bitmap);
});

for (const [width, height] of [[32,32], [32,64], [64,32], [64,64], [96,32], [96,64], [256,64]]) {
  test(`${width}×${height} 5bit blank, filled, all-level patterns and multiple frames round-trip`, () => {
    const size = { width, height }, count = width * height / 1024;
    const frames = [new Uint8Array(width * height), new Uint8Array(width * height).fill(31),
      Uint8Array.from({ length: width * height }, (_, i) => (i % width * 7 + Math.floor(i / width) * 13) % 32)];
    const encoded = codec.encodeFrames(frames, size, 5);
    assert.equal(encoded.length, (343 * count - 1) * 3 + 2);
    assert.equal(encoded.split('|').length, count);
    for (const panel of encoded.split('|')) {
      assert.equal(panel.split('/').length, 3);
      for (const frame of panel.split('/')) assert.equal(frame.length, 342);
    }
    const format = codec.detectFormat(encoded);
    assert.equal(format.bits, 5);
    assert.equal(format.chunkCount, 342);
    assert.equal(format.panelCount, count);
    const decoded = codec.decodeFrames(encoded, size);
    frames.forEach((frame, i) => same(decoded[i], frame));
  });
}

test('5bit panel corners and boundaries use independent final groups in row-major panel order', () => {
  const size = { width: 96, height: 64 }, bitmap = new Uint8Array(6144);
  for (let p = 0; p < 6; p++) {
    const left = (p % 3) * 32, top = Math.floor(p / 3) * 32;
    bitmap[top * 96 + left] = p + 1;
    bitmap[(top + 31) * 96 + left + 31] = 31 - p;
  }
  const panels = codec.encodeFrames([bitmap], size, 5).split('|');
  panels.forEach((panel, p) => {
    assert.equal(panel.charCodeAt(0) - 0x3000, p + 1);
    assert.equal(panel.charCodeAt(341) - 0x3000, 31 - p);
  });
});

test('5bit rejects out-of-range pixels before typed-array conversion, mixed depths and corrupt panels', () => {
  const panel = '\u3000'.repeat(342), mono = '\u3000'.repeat(69);
  for (const value of [-1, 32, 256, 1.5, NaN]) {
    const bitmap = new Array(1024).fill(0); bitmap[1] = value;
    assert.throws(() => codec.encodeFrames([bitmap], 32, 5), /0〜31/);
  }
  for (const bits of [0, 2, 4, 8, 15]) assert.throws(() => codec.encodeFrames([new Uint8Array(1024)], 32, bits));
  for (const value of [panel + '|' + mono, mono + '/' + panel, panel + '/', panel + '|', panel.slice(1), panel.repeat(4)]) assert.throws(() => codec.detectFormat(value));
  for (let p = 0; p < 4; p++) {
    for (const broken of [panel.slice(0, -1) + '\u3020', '\ub000' + panel.slice(1), 'A' + panel.slice(1)]) {
      const panels = new Array(4).fill(panel); panels[p] = broken;
      assert.throws(() => codec.decodeFrames(panels.join('|'), 64), /未使用10bit|Safe範囲/);
    }
  }
  assert.throws(() => codec.decodeFrames(panel, 32, 1));
  assert.throws(() => codec.decodeFrames(mono, 32, 5));
  assert.equal(codec.detectFormat(mono.repeat(4)).bits, 1);
  assert.equal(codec.detectFormat(mono.repeat(4)).size.width, 64);
});

test('32 gray levels and all RGB221 colors retain their values through image quantization', () => {
  for (const mode of ['gray32', 'rgb32']) {
    const palette = Array.from({ length: 32 }, (_, value) => Array.from(colors.rgb(value, mode)));
    assert.equal(new Set(palette.map(rgb => rgb.join(','))).size, 32);
    palette.forEach((rgb, value) => assert.equal(colors.fromRGBA(...rgb, 255, mode), value));
    same(palette[0], [0, 0, 0]); same(palette[31], [255, 255, 255]);
    assert.equal(colors.fromRGBA(255, 255, 255, 0, mode), 0);
  }
  same(colors.rgb(24, 'rgb32'), [255, 0, 0]);
  same(colors.rgb(6, 'rgb32'), [0, 255, 0]);
  same(colors.rgb(1, 'rgb32'), [0, 0, 255]);
  assert.equal(colors.fromRGBA(255, 255, 255, 128, 'gray32'), 16);
  assert.equal(colors.fromRGBA(255, 0, 0, 255, 'gray32'), 7);
  assert.equal(colors.toMono(15, 'gray32'), 0);
  assert.equal(colors.toMono(16, 'gray32'), 1);
  assert.equal(colors.toMono(24, 'rgb32'), 0); // Red: index must not be mistaken for brightness.
  assert.equal(colors.toMono(6, 'rgb32'), 1);
});

test('5bit values survive resizing and every text animation, including scattering particles', () => {
  const bitmap = Uint8Array.from({ length: 1024 }, (_, i) => i % 32);
  const extended = codec.resizeBitmap(bitmap, 32, { width: 96, height: 32 });
  same(codec.resizeBitmap(extended, { width: 96, height: 32 }, 32), bitmap);
  const page = { width: 32, height: 32, bitmap, reveals: [bitmap] };
  for (const effect of ['static', 'scroll-left', 'scroll-right', 'scroll-up', 'scroll-down', 'typewriter', 'blink', 'explode', 'assemble', 'morph', 'morph-letters']) {
    const frames = effects.build([page], { width: 96, height: 32, effect, steps: 8, hold: 1, scrollStep: 8 });
    assert.ok(frames.some(frame => frame.includes(31)), effect);
    const decoded = codec.decodeFrames(codec.encodeFrames(frames, { width: 96, height: 32 }, 5), { width: 96, height: 32 });
    frames.forEach((frame, i) => same(decoded[i], frame));
  }
  const particles = effects.build([{ ...page, bitmap: bitmap.fill(19) }], { width: 32, height: 32, effect: 'explode', steps: 8, hold: 0 });
  assert.ok(particles[4].includes(19));
  for (const frame of particles) assert.ok(frame.every(value => value === 0 || value === 19));
});
