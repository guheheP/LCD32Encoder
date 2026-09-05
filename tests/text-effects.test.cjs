const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const extract = id => html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`))[1];
const codec = vm.runInNewContext(extract('lcd-codec') + '\nLCDCodec;');
const effects = vm.runInNewContext(extract('lcd-text-effects') + '\nLCDTextEffects;');
const same = (a, b) => assert.deepEqual(Array.from(a), Array.from(b));
const empty = frame => frame.every(value => value === 0);
const page = { width: 5, height: 3, bitmap: Uint8Array.from([1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0]) };
page.reveals = [Uint8Array.from(page.bitmap, (_, i) => i === 0 ? 1 : 0), page.bitmap];

for (const size of [{ width: 32, height: 32 }, { width: 32, height: 64 }, { width: 64, height: 32 }, { width: 64, height: 64 }, { width: 96, height: 32 }, { width: 96, height: 64 }]) {
  test(`${size.width}×${size.height}: all text effects round-trip through the real Safe codec`, () => {
    for (const effect of ['static', 'morph', 'morph-letters', 'scroll-left', 'scroll-right', 'scroll-up', 'scroll-down', 'explode', 'assemble', 'typewriter', 'blink']) {
      const frames = effects.build([page], { ...size, effect, steps: 8, hold: 2 });
      assert.ok(frames.length > 0 && frames.length <= 240);
      frames.forEach(frame => {
        assert.equal(frame.length, size.width * size.height);
        assert.ok(frame.every(value => value === 0 || value === 1));
      });
      assert.ok(frames.some(frame => !empty(frame)), effect);
      const decoded = codec.decodeFrames(codec.encodeFrames(frames, size), size);
      decoded.forEach((frame, i) => same(frame, frames[i]));
    }
  });
}

test('static multiline-sized content is centered without distortion', () => {
  const frame = effects.build([page], { width: 64, height: 32, effect: 'static' })[0];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    assert.equal(frame[y * 64 + x], x >= 29 && x < 34 && y >= 14 && y < 17 ? page.bitmap[(y - 14) * 5 + x - 29] : 0);
  }
});

for (const [forward, backward, content] of [
  ['scroll-left', 'scroll-right', { width: 80, height: 1, bitmap: Uint8Array.from({ length: 80 }, (_, i) => i === 0 || i === 79 ? 1 : 0) }],
  ['scroll-up', 'scroll-down', { width: 1, height: 80, bitmap: Uint8Array.from({ length: 80 }, (_, i) => i === 0 || i === 79 ? 1 : 0) }]
]) test(`${forward}: long text enters, crosses the viewport and completely exits`, () => {
  const options = { width: 32, height: 32, scrollStep: 1 };
  const frames = effects.build([content], { ...options, effect: forward });
  const reverse = effects.build([content], { ...options, effect: backward });
  assert.equal(frames.length, 113);
  assert.ok(empty(frames[0]) && empty(frames.at(-1)));
  assert.equal(frames[1].reduce((a, b) => a + b, 0), 1);
  assert.ok(!empty(frames[80])); // The trailing character also enters the display.
  frames.forEach((frame, i) => same(frame, reverse[frames.length - 1 - i]));
});

test('explosion and assembly are reproducible inverse transitions with exact endpoints', () => {
  const options = { width: 64, height: 32, steps: 16, hold: 0 };
  const explode = effects.build([page], { ...options, effect: 'explode' });
  const assemble = effects.build([page], { ...options, effect: 'assemble' });
  assert.ok(!empty(explode[0]) && empty(explode.at(-1)));
  assert.ok(explode.slice(1, -1).some(frame => !empty(frame) && frame.some((v, i) => v !== explode[0][i])));
  explode.forEach((frame, i) => same(frame, assemble[assemble.length - 1 - i]));
  effects.build([page], { ...options, effect: 'explode' }).forEach((frame, i) => same(frame, explode[i]));
});

test('typewriter holds each partial text and finishes with the entire page', () => {
  const options = { width: 32, height: 64, effect: 'typewriter', typingDelay: 2, hold: 3 };
  const frames = effects.build([page], options);
  assert.equal(frames.length, 8);
  assert.ok(empty(frames[0]));
  assert.equal(frames[1].reduce((a, b) => a + b, 0), 1);
  same(frames[1], frames[2]);
  same(frames.at(-1), effects.centered(page, 32, 64));
});

test('morphing a character sequence reaches each full target and keeps independent frames', () => {
  const other = { ...page, bitmap: Uint8Array.from(page.bitmap, v => 1 - v) };
  const frames = effects.build([page, other], { width: 32, height: 32, effect: 'morph-letters', steps: 4, hold: 2 });
  assert.equal(frames.length, 13);
  same(frames[4], effects.centered(page, 32, 32));
  same(frames.at(-1), effects.centered(other, 32, 32));
  const before = frames[5][0];
  frames[4][0] = 1 - frames[4][0];
  assert.equal(frames[5][0], before);
});

test('oversized animations fail before replacing the editor with excessive frames', () => {
  const long = { width: 1000, height: 1, bitmap: new Uint8Array(1000).fill(1) };
  assert.throws(() => effects.build([long], { width: 32, height: 32, effect: 'scroll-left', scrollStep: 1 }), /最大240/);
  assert.throws(() => effects.build(new Array(64).fill(page), { width: 32, height: 32, effect: 'morph-letters' }), /最大240/);
});
