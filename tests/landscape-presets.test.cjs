const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const load = (id, globalName) => {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`));
  assert.ok(match, `The standalone HTML contains ${id}`);
  return vm.runInNewContext(match[1] + `\n${globalName};`);
};
const landscape = load('lcd-landscape-presets', 'LCDLandscapePresets');
const navigation = load('lcd-push-order-presets', 'LCDPushOrderPresets');
const codec = load('lcd-codec', 'LCDCodec');
const names = ['train', 'skyline', 'dolphins', 'comet', 'panoramaFireworks', 'hyperspace', 'laser', 'equalizer', 'chevrons', 'finishFlag'];
const orders = {
  lcr: [0, 1, 2], lrc: [0, 2, 1], clr: [1, 0, 2],
  crl: [1, 2, 0], rlc: [2, 0, 1], rcl: [2, 1, 0],
};
const size = { width: 96, height: 32 };
const signature = frame => Buffer.from(frame).toString('base64');
const panelPixels = (frame, panel) => Uint8Array.from({ length: 1024 }, (_, index) =>
  frame[Math.floor(index / 32) * 96 + panel * 32 + index % 32]);

function assertAnimation(module, name) {
  const metadata = module.presets[name];
  assert.equal(typeof metadata.label, 'string');
  assert.ok(metadata.label.trim().length > 0);
  assert.ok(Number.isInteger(metadata.count) && metadata.count > 1);
  assert.ok(Number.isInteger(metadata.delay) && metadata.delay >= 50 && metadata.delay <= 5000);
  const frames = module.build(name);
  assert.equal(frames.length, metadata.count);
  for (const frame of frames) {
    assert.equal(Object.prototype.toString.call(frame), '[object Uint8Array]');
    assert.equal(frame.length, 3072);
    assert.ok(frame.every(value => value === 0 || value === 1), `${name} stays monochrome`);
  }
  assert.ok(new Set(frames.map(signature)).size >= 4, `${name} contains visibly changing frames`);
  assert.deepEqual(Array.from(module.build(name), signature), Array.from(frames, signature), `${name} is deterministic`);
  for (let panel = 0; panel < 3; panel++) {
    assert.ok(frames.some(frame => panelPixels(frame, panel).some(Boolean)), `${name} uses panel ${panel}`);
  }
  return frames;
}

function assertEncoding(frames, name) {
  for (const bits of [1, 5]) {
    const values = frames.map(frame => Uint8Array.from(frame, value => value * (bits === 5 ? 19 : 1)));
    const encoded = codec.encodeFrames(values, size, bits);
    const panels = encoded.split('|').map(panel => panel.split('/'));
    assert.equal(panels.length, 3, `${name}: ${bits}bit output has three panels`);
    for (let panel = 0; panel < 3; panel++) {
      assert.equal(panels[panel].length, frames.length);
      for (const frameText of panels[panel]) assert.equal(frameText.length, bits === 1 ? 69 : 342);
      // Check spatial panel order independently of decoding the complete animation.
      for (const index of [0, Math.floor(frames.length / 2), frames.length - 1]) {
        assert.equal(panels[panel][index], codec.encodeFrames([panelPixels(values[index], panel)], 32, bits));
      }
    }
    const detected = codec.detectFormat(encoded);
    assert.equal(detected.order, 'panel-major');
    assert.equal(detected.panelCount, 3);
    assert.equal(detected.frameCount, frames.length);
    assert.equal(detected.bits, bits);
    const restored = codec.decodeFrames(encoded, size, bits);
    assert.equal(restored.length, frames.length);
    restored.forEach((frame, index) => assert.equal(signature(frame), signature(values[index])));
  }
}

test('landscape catalog contains all ten dedicated 96×32 effects', () => {
  assert.deepEqual(Object.keys(landscape.presets).sort(), [...names].sort());
});

for (const name of names) {
  test(`${name}: deterministic 96×32 animation uses all panels and round-trips at 1bit and 5bit`, () => {
    assertEncoding(assertAnimation(landscape, name), name);
  });
  test(`${name}: reversing direction mirrors every pixel without changing frame timing`, () => {
    const left = landscape.build(name, { direction: 'left' });
    const right = landscape.build(name, { direction: 'right' });
    assert.equal(right.length, left.length);
    for (let frame = 0; frame < left.length; frame++) {
      assert.equal(right[frame].length, 3072);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 96; x++) {
        assert.equal(right[frame][y * 96 + x], left[frame][y * 96 + 95 - x], `${name}, frame ${frame}, (${x}, ${y})`);
      }
    }
  });
}

test('push-order catalog covers all six temporal permutations of the three physical panels', () => {
  assert.deepEqual(Object.keys(navigation.presets).sort(), Object.keys(orders).sort());
  for (const [name, order] of Object.entries(orders)) {
    assert.deepEqual(Array.from(navigation.presets[name].order), order);
    assert.equal(navigation.presets[name].count, 84);
    assert.equal(navigation.presets[name].delay, 80);
  }
  assert.equal(new Set(Object.values(navigation.presets).map(preset => Array.from(preset.order).join(''))).size, 6);
});

for (const name of Object.keys(orders)) {
  test(`${name}: push-order animation uses three panels and round-trips at 1bit and 5bit`, () => {
    assertEncoding(assertAnimation(navigation, name), name);
  });
}

test('all six push orders have distinct initial rank displays and share the completed state', () => {
  const animations = Object.keys(orders).map(name => navigation.build(name));
  assert.equal(new Set(animations.map(frames => signature(frames[0]))).size, 6);
  assert.equal(new Set(animations.map(frames => signature(frames.at(-1)))).size, 1);
  for (const frames of animations) {
    assert.notEqual(signature(frames[0]), signature(frames[12]), 'the first instruction changes the initial display');
    assert.notEqual(signature(frames[12]), signature(frames[32]), 'the second instruction advances the display');
    assert.notEqual(signature(frames[32]), signature(frames[52]), 'the third instruction advances the display');
    assert.notEqual(signature(frames[52]), signature(frames[72]), 'completion changes the last active instruction');
  }
});

test('navigation ranks and active panels follow temporal order for all six permutations', () => {
  const digits = [
    ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ];
  for (const [name, order] of Object.entries(orders)) {
    const frames = navigation.build(name);
    for (let panel = 0; panel < 3; panel++) {
      const rank = order.indexOf(panel);
      for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
        assert.equal(frames[0][(7 + y * 3) * 96 + panel * 32 + 9 + x * 3], Number(digits[rank][y][x]),
          `${name}: physical panel ${panel} initially shows rank ${rank + 1}`);
      }
    }
    for (let step = 0; step < 3; step++) {
      const start = 12 + step * 20;
      for (let panel = 0; panel < 3; panel++) {
        assert.equal(frames[start][5 * 96 + panel * 32 + 5], Number(panel === order[step]),
          `${name}: step ${step + 1} highlights physical panel ${order[step]}`);
      }
      // Confirmation shows the same check as the final state and persists into later steps.
      const confirmedPanel = order[step];
      for (const index of [start + 16, ...[32, 52, 72].filter(index => index > start + 16)]) {
        for (let y = 4; y < 29; y++) for (let x = 4; x < 28; x++) {
          const offset = y * 96 + confirmedPanel * 32 + x;
          assert.equal(frames[index][offset], frames[83][offset], `${name}: completed panel ${confirmedPanel} keeps its check`);
        }
      }
    }
  }
});

test('unknown landscape and push-order presets are rejected', () => {
  assert.throws(() => landscape.build('missing'));
  assert.throws(() => navigation.build('missing'));
});

test('all landscape and push-order buttons appear exactly once inside preset categories', () => {
  const stack = [];
  const found = { 'data-landscape': [], 'data-push-order': [] };
  for (const token of html.matchAll(/<\/?details\b[^>]*>|<button\b[^>]*>/gi)) {
    const tag = token[0];
    if (/^<\/details/i.test(tag)) {
      stack.pop();
    } else if (/^<details/i.test(tag)) {
      const className = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      stack.push(className.split(/\s+/).includes('preset-category'));
    } else {
      for (const attribute of Object.keys(found)) {
        const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'));
        if (match) {
          assert.ok(stack.some(Boolean), `${attribute}="${match[1]}" belongs to a preset category`);
          found[attribute].push(match[1]);
        }
      }
    }
  }
  assert.deepEqual(found['data-landscape'].sort(), [...names].sort());
  assert.deepEqual(found['data-push-order'].sort(), Object.keys(orders).sort());
});
