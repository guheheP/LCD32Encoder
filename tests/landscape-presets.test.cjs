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
    assert.equal(navigation.presets[name].delay, 50);
  }
  assert.equal(new Set(Object.values(navigation.presets).map(preset => Array.from(preset.order).join(''))).size, 6);
});

for (const name of Object.keys(orders)) {
  test(`${name}: push-order animation uses three panels and round-trips at 1bit and 5bit`, () => {
    assertEncoding(assertAnimation(navigation, name), name);
  });
}

test('all six push orders hold distinct initial rank displays and finish with an empty display', () => {
  const animations = Object.keys(orders).map(name => navigation.build(name));
  assert.equal(new Set(animations.map(frames => signature(frames[0]))).size, 6);
  for (const frames of animations) {
    for (let index = 0; index < 12; index++) {
      assert.equal(signature(frames[index]), signature(frames[0]), 'the overview holds all three readable ranks');
    }
    for (let index = 72; index < frames.length; index++) {
      assert.ok(frames[index].every(value => value === 0), 'all badges have disappeared during the final pause');
    }
  }
});

test('navigation shows centered rank digits inside circular outlines with empty corners', () => {
  const digits = [
    ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ];
  for (const [name, order] of Object.entries(orders)) {
    const frames = navigation.build(name);
    for (let panel = 0; panel < 3; panel++) {
      const rank = order.indexOf(panel);
      const badge = panelPixels(frames[0], panel);
      for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        assert.equal(badge[(6 + y * 3 + dy) * 32 + 8 + x * 3 + dx], Number(digits[rank][y][x]),
          `${name}: physical panel ${panel} initially shows the complete rank ${rank + 1}`);
      }
      for (const [left, top] of [[0, 0], [27, 0], [0, 27], [27, 27]]) {
        for (let y = top; y < top + 5; y++) for (let x = left; x < left + 5; x++) {
          assert.equal(badge[y * 32 + x], 0, `${name}: circular panel ${panel} has no square corner`);
        }
      }
      for (const [left, top, width, height] of [[12, 0, 8, 5], [12, 27, 8, 5], [0, 12, 5, 8], [27, 12, 5, 8]]) {
        let ink = 0;
        for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) ink += badge[y * 32 + x];
        assert.ok(ink > 0, `${name}: circular panel ${panel} retains its four curved sides`);
      }
    }
  }
});

test('all six orders burst one badge at a time without affecting other panels', () => {
  for (const [name, order] of Object.entries(orders)) {
    const frames = navigation.build(name);
    const initial = [0, 1, 2].map(panel => signature(panelPixels(frames[0], panel)));
    for (let step = 0; step < 3; step++) {
      const start = 12 + step * 20;
      const active = order[step];
      const activeFrames = frames.slice(start, start + 16).map(frame => panelPixels(frame, active));
      assert.ok(new Set(activeFrames.map(signature)).size >= 6,
        `${name}: step ${step + 1} visibly animates the badge on physical panel ${active}`);
      assert.ok(new Set(activeFrames.slice(0, 4).map(signature)).size > 1,
        `${name}: active badge prepares for its burst`);
      assert.ok(activeFrames.slice(7, 13).every(frame => frame.some(Boolean)),
        `${name}: the badge remains visible as moving fragments before disappearing`);
      for (let index = start; index < start + 20; index++) {
        for (let panel = 0; panel < 3; panel++) {
          const rank = order.indexOf(panel);
          const pixels = panelPixels(frames[index], panel);
          if (rank > step) {
            assert.equal(signature(pixels), initial[panel],
              `${name}: frame ${index} leaves future panel ${panel} intact, including during a neighboring burst`);
          } else if (rank < step || index >= start + 16) {
            assert.ok(pixels.every(value => value === 0),
              `${name}: frame ${index} leaves completed panel ${panel} empty`);
          }
        }
      }
    }
  }
});

test('navigation badges squash, rebound, then scatter outward and fade away', () => {
  const measure = pixels => {
    let count = 0, central = 0, radiusTotal = 0;
    let minX = 32, maxX = -1, minY = 32, maxY = -1;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      if (!pixels[y * 32 + x]) continue;
      const radius = Math.hypot(x - 15.5, y - 15.5);
      count++;
      radiusTotal += radius;
      if (radius < 5) central++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return {
      count, central, averageRadius: count ? radiusTotal / count : 0,
      width: count ? maxX - minX + 1 : 0, height: count ? maxY - minY + 1 : 0,
    };
  };
  for (const [name, order] of Object.entries(orders)) {
    const frames = navigation.build(name);
    for (let step = 0; step < 3; step++) {
      const start = 12 + step * 20;
      const at = phase => measure(panelPixels(frames[start + phase], order[step]));
      const initial = measure(panelPixels(frames[0], order[step]));
      assert.ok(at(3).height < initial.height,
        `${name}: rank ${step + 1} squashes vertically before the impact`);
      assert.ok(at(4).height > at(3).height && at(4).width < at(3).width,
        `${name}: rank ${step + 1} rebounds into a taller, narrower shape`);
      assert.ok(at(12).averageRadius > at(8).averageRadius + 1,
        `${name}: rank ${step + 1} spreads fragments outward after the impact`);
      assert.ok(at(4).central > 0, `${name}: rank ${step + 1} starts with a visible center`);
      assert.equal(at(12).central, 0, `${name}: rank ${step + 1} empties its center as fragments scatter`);
      assert.ok(at(12).count > 0 && at(12).count < at(8).count,
        `${name}: rank ${step + 1} fades gradually while outer fragments remain visible`);
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
