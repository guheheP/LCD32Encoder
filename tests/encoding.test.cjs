const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

// Test the exact codec embedded in the standalone HTML; no build or dependencies.
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script id="lcd-codec">([\s\S]*?)<\/script>/)[1];
const codec = vm.runInNewContext(source + '\nLCDCodec;');
const blank = (size) => new Uint8Array(size * size);
const sameBitmap = (actual, expected) => assert.deepEqual(Array.from(actual), Array.from(expected));

test('32×32 Safe golden values stay compatible, including all-blank output', () => {
  assert.equal(codec.encodeFrames([blank(32)], 32), '\u3000'.repeat(69));
  const filled = blank(32).fill(1);
  assert.equal(codec.encodeFrames([filled], 32), '\uafff'.repeat(68) + '\u300f');
  const points = blank(32);
  [0, 14, 15, 31, 32, 1023].forEach((index) => { points[index] = 1; });
  const expected = new Array(69).fill(0x3000);
  expected[0] = 0x7001; // Bits 0 and 14.
  expected[1] = 0x3001; // Bit 15.
  expected[2] = 0x3006; // Bits 31 and 32: no row padding.
  expected[68] = 0x3008; // Bit 1023.
  assert.equal(codec.encodeFrames([points], 32), String.fromCharCode(...expected));
});

for (const size of [32, 64]) {
  for (const pattern of ['blank', 'filled', 'asymmetric']) {
    test(`${size}×${size} ${pattern} round trip`, () => {
      const bitmap = Uint8Array.from({ length: size * size }, (_, index) => {
        if (pattern === 'blank') return 0;
        if (pattern === 'filled') return 1;
        const x = index % size, y = Math.floor(index / size);
        return (x * 7 + y * 13 + x * y) % 17 < 5 ? 1 : 0;
      });
      const output = codec.encodeFrames([bitmap], size);
      assert.equal(output.length, size === 32 ? 69 : 279);
      assert.equal(output.includes('/'), false);
      assert.deepEqual(output.split('|').map((panel) => panel.length), size === 32 ? [69] : [69, 69, 69, 69]);
      sameBitmap(codec.decodeFrames(output, size)[0], bitmap);
    });
  }
}

test('64×64 boundary pixels land in TL, TR, BL, BR blocks without rotation', () => {
  const bitmap = blank(64);
  [[31, 31], [32, 31], [31, 32], [32, 32]].forEach(([x, y]) => { bitmap[y * 64 + x] = 1; });
  const expected = new Array(279).fill(0x3000);
  [69, 139, 209].forEach((index) => { expected[index] = 0x7c; }); // | between panels.
  expected[68] = 0x3008;       // TL: local (31,31), index 1023.
  expected[70 + 66] = 0x3004; // TR: local (0,31), index 992.
  expected[140 + 2] = 0x3002; // BL: local (31,0), index 31.
  expected[210] = 0x3001;     // BR: local (0,0), index 0.
  const output = codec.encodeFrames([bitmap], 64);
  assert.equal(output, String.fromCharCode(...expected));
  sameBitmap(codec.decodeFrames(output, 64)[0], bitmap);
});

test('all four outer corners retain their coordinates and panel offsets', () => {
  const bitmap = blank(64);
  [[0, 0], [63, 0], [0, 63], [63, 63]].forEach(([x, y]) => { bitmap[y * 64 + x] = 1; });
  const tiles = codec.splitPanels(bitmap, 64);
  [0, 31, 992, 1023].forEach((index, panel) => {
    assert.equal(tiles[panel][index], 1);
    assert.equal(Array.from(tiles[panel]).reduce((sum, value) => sum + value, 0), 1);
  });
  sameBitmap(codec.joinPanels(tiles, 64), bitmap);
});

for (const size of [32, 64]) {
  test(`${size}×${size} animations use / only between complete frames`, () => {
    const point = blank(size);
    point[point.length - 1] = 1;
    const frames = [blank(size), blank(size).fill(1), point];
    const output = codec.encodeFrames(frames, size);
    const units = size === 32 ? 69 : 279;
    assert.equal(output.length, 3 * units + 2);
    assert.deepEqual(output.split('/').map((frame) => frame.length), [units, units, units]);
    const decoded = codec.decodeFrames(output, size);
    assert.equal(decoded.length, 3);
    decoded.forEach((frame, index) => sameBitmap(frame, frames[index]));
  });
}

test('every panel independently enforces Safe range and padding', () => {
  for (let panel = 0; panel < 4; panel += 1) {
    for (const codeUnit of [0, 0x2fff, 0xb000, 0xd800]) {
      const panels = new Array(4).fill('\u3000'.repeat(69));
      panels[panel] = String.fromCharCode(codeUnit) + '\u3000'.repeat(68);
      for (const separator of ['|', '']) {
        assert.throws(() => codec.decodeFrames(panels.join(separator), 64), /Safe範囲/);
      }
    }
    const panels = new Array(4).fill('\u3000'.repeat(69));
    panels[panel] = '\u3000'.repeat(68) + '\u3010';
    for (const separator of ['|', '']) {
      assert.throws(() => codec.decodeFrames(panels.join(separator), 64), /未使用11bit/);
    }
  }
});

test('invalid frame lengths, mixed resolutions, and empty segments are rejected', () => {
  const frame32 = '\u3000'.repeat(69), frame64 = new Array(4).fill(frame32).join('|');
  for (const value of ['', frame32, frame64.slice(1), frame64 + '\u3000', '/' + frame64, frame64 + '/', frame64 + '//' + frame64, frame64 + '/' + frame32]) {
    assert.throws(() => codec.decodeFrames(value, 64));
  }
  assert.throws(() => codec.decodeFrames(frame64, 32));
  assert.throws(() => codec.encodeFrames([blank(64)], 32));
  assert.throws(() => codec.encodeFrames([], 64));
  assert.throws(() => codec.decodeFrames(frame32, 48));
});

test('panel separators require exactly four nonempty 69-unit panels', () => {
  const panel = '\u3000'.repeat(69);
  const frame = new Array(4).fill(panel).join('|');
  for (const value of [
    '|' + frame, frame + '|', frame.replace('|', '||'), frame.replace('|', ''),
    new Array(3).fill(panel).join('|'), new Array(5).fill(panel).join('|'),
    [panel, '', panel, panel].join('|'),
    [panel.slice(1), panel + '\u3000', panel, panel].join('|')
  ]) assert.throws(() => codec.decodeFrames(value, 64));
  assert.throws(() => codec.decodeFrames(panel + '|', 32));
});

test('legacy 276-unit frames still decode and re-encode with panel separators', () => {
  const pattern = Uint8Array.from({ length: 4096 }, (_, index) => index % 13 < 4 ? 1 : 0);
  const frames = [blank(64), blank(64).fill(1), pattern];
  const legacy = frames.map((frame) => Array.from(codec.splitPanels(frame, 64), (panel) => codec.safePixelsToString(panel)).join('')).join('/');
  assert.equal(legacy.length, 276 * 3 + 2);
  const decoded = codec.decodeFrames(legacy, 64);
  decoded.forEach((frame, index) => sameBitmap(frame, frames[index]));
  const updated = codec.encodeFrames(decoded, 64);
  assert.equal(updated.length, 279 * 3 + 2);
  assert.equal(updated.replaceAll('|', ''), legacy);
  for (const value of [legacy.slice(1), legacy + '\u3000']) {
    assert.throws(() => codec.decodeFrames(value, 64));
  }
});

test('canvas expansion preserves the top-left pixels and shrinking crops by coordinates', () => {
  const bitmap = Uint8Array.from({ length: 1024 }, (_, index) => index % 11 === 0 ? 1 : 0);
  const expanded = codec.resizeBitmap(bitmap, 32, 64);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) assert.equal(expanded[y * 64 + x], x < 32 && y < 32 ? bitmap[y * 32 + x] : 0);
  }
  expanded[63 * 64 + 63] = 1;
  sameBitmap(codec.resizeBitmap(expanded, 64, 32), bitmap);
});

test('sample enlargement produces exact 2×2 dots', () => {
  const bitmap = blank(32);
  bitmap[10 * 32 + 3] = 1;
  const scaled = codec.scaleBitmap(bitmap, 32, 64);
  assert.equal(Array.from(scaled).reduce((sum, value) => sum + value, 0), 4);
  [[6, 20], [7, 20], [6, 21], [7, 21]].forEach(([x, y]) => assert.equal(scaled[y * 64 + x], 1));
});

for (const size of [{ width: 32, height: 64 }, { width: 64, height: 32 }]) {
  for (const pattern of ['blank', 'filled', 'asymmetric']) {
    test(`${size.width}×${size.height} ${pattern} round trip and animation`, () => {
      const bitmap = Uint8Array.from({ length: size.width * size.height }, (_, index) => {
        if (pattern === 'blank') return 0;
        if (pattern === 'filled') return 1;
        const x = index % size.width, y = Math.floor(index / size.width);
        return (x * 7 + y * 13 + x * y) % 17 < 5 ? 1 : 0;
      });
      const frames = [bitmap, Uint8Array.from(bitmap, value => 1 - value)];
      const output = codec.encodeFrames(frames, size);
      assert.equal(output.length, 139 * 2 + 1);
      assert.deepEqual(output.split('/').map(f => f.split('|').map(p => p.length)), [[69, 69], [69, 69]]);
      codec.decodeFrames(output, size).forEach((frame, i) => sameBitmap(frame, frames[i]));
    });
  }

  test(`${size.width}×${size.height} panel order, corners and boundaries`, () => {
    const bitmap = new Uint8Array(size.width * size.height);
    // First panel bottom-right, second panel top-left, then outer corners.
    const secondX = size.width === 64 ? 32 : 0;
    const secondY = size.height === 64 ? 32 : 0;
    [[31, 31], [secondX, secondY], [0, 0], [size.width - 1, size.height - 1]].forEach(([x, y]) => { bitmap[y * size.width + x] = 1; });
    const expected = '\u3001' + '\u3000'.repeat(67) + '\u3008';
    assert.equal(codec.encodeFrames([bitmap], size), expected + '|' + expected);
    const decoded = codec.decodeFrames(expected + '|' + expected, size)[0];
    sameBitmap(decoded, bitmap);
  });
}

test('format detection identifies panel counts and offers every supported arrangement', () => {
  for (const size of [32, 64]) {
    const format = codec.detectFormat(codec.encodeFrames([blank(size), blank(size).fill(1)], size));
    assert.equal(format.panelCount, size === 32 ? 1 : 4);
    assert.equal(format.frameCount, 2);
    if (size === 32) {
      assert.equal(format.size.width, size);
      assert.equal(format.size.height, size);
    } else {
      assert.equal(format.size, null);
      assert.deepEqual(Array.from(format.layouts, layout => `${layout.width}x${layout.height}`), ['32x128', '64x64', '128x32']);
    }
  }
  const format = codec.detectFormat('\u3000'.repeat(69) + '|' + '\u3000'.repeat(69));
  assert.equal(format.panelCount, 2);
  assert.equal(format.size, null);
  assert.equal(codec.detectFormat('\u3000'.repeat(276)).size.width, 64);
  const panel = '\u3000'.repeat(69), pair = panel + '|' + panel;
  for (const value of ['', pair + '/', pair + '/' + panel, panel + '||' + panel, pair.slice(1), panel.repeat(2)]) {
    assert.throws(() => codec.detectFormat(value));
  }
});

for (const [width, height] of [[96, 32], [32, 96], [96, 64], [64, 96], [128, 32], [128, 128], [256, 64], [64, 256]]) {
  test(`${width}×${height} custom layout: blank, filled, patterned animation round trip`, () => {
    const size = { width, height }, count = width * height / 1024;
    const frames = [new Uint8Array(width * height), new Uint8Array(width * height).fill(1), Uint8Array.from({ length: width * height }, (_, index) => ((index % width) * 7 + Math.floor(index / width) * 11) % 19 < 7 ? 1 : 0)];
    const output = codec.encodeFrames(frames, size);
    assert.equal(output.length, (70 * count - 1) * 3 + 2);
    assert.ok(output.split('/').every(frame => frame.split('|').length === count && frame.split('|').every(panel => panel.length === 69)));
    codec.decodeFrames(output, size).forEach((frame, i) => sameBitmap(frame, frames[i]));
    const detected = codec.detectFormat(output);
    assert.equal(detected.panelCount, count);
    assert.ok(detected.layouts.some(layout => layout.width === width && layout.height === height));
  });
}

test('3×2 panels are serialized left to right, then top to bottom, with local padding', () => {
  const bitmap = new Uint8Array(96 * 64), expected = [];
  for (let panel = 0; panel < 6; panel++) {
    const left = (panel % 3) * 32, top = Math.floor(panel / 3) * 32;
    bitmap[top * 96 + left + panel] = 1;
    bitmap[(top + 31) * 96 + left + 31] = 1;
    expected.push(String.fromCharCode(0x3000 + (1 << panel)) + '\u3000'.repeat(67) + '\u3008');
  }
  assert.equal(codec.encodeFrames([bitmap], { width: 96, height: 64 }), expected.join('|'));
  sameBitmap(codec.decodeFrames(expected.join('|'), { width: 96, height: 64 })[0], bitmap);
});

test('layout limits, factorization, and legacy four-panel recognition are consistent', () => {
  for (let columns = 1; columns <= 8; columns++) for (let rows = 1; rows <= 8; rows++) {
    const size = { width: columns * 32, height: rows * 32 };
    if (columns * rows <= 16) {
      assert.equal(codec.panelCount(size), columns * rows);
      assert.ok(codec.layoutsForPanelCount(columns * rows).some(layout => layout.width === size.width && layout.height === size.height));
    } else assert.throws(() => codec.dimensions(size));
  }
  for (const size of [{ width: 0, height: 32 }, { width: 48, height: 32 }, { width: 288, height: 32 }, { width: 256, height: 256 }]) assert.throws(() => codec.dimensions(size));
  for (const count of [0, 11, 13, 17]) assert.equal(codec.layoutsForPanelCount(count).length, 0);
  const panel = '\u3000'.repeat(69);
  assert.deepEqual(Array.from(codec.detectFormat([panel, panel, panel].join('|')).layouts, size => `${size.width}x${size.height}`), ['32x96', '96x32']);
  assert.equal(codec.detectFormat(new Array(9).fill(panel).join('|')).size.width, 96);
  assert.equal(codec.detectFormat(panel.repeat(4)).size.width, 64);
  for (const value of [new Array(17).fill(panel).join('|'), new Array(11).fill(panel).join('|'), panel.repeat(3)]) assert.throws(() => codec.detectFormat(value));
});

test('all rectangular resize paths preserve the overlap using original coordinates', () => {
  const sizes = [32, 64, { width: 32, height: 64 }, { width: 64, height: 32 }];
  for (const fromSize of sizes) for (const toSize of sizes) {
    const from = codec.dimensions(fromSize), to = codec.dimensions(toSize);
    const source = Uint8Array.from({ length: from.width * from.height }, (_, index) => index % 11 < 3 ? 1 : 0);
    const result = codec.resizeBitmap(source, fromSize, toSize);
    assert.equal(result.length, to.width * to.height);
    for (let y = 0; y < to.height; y += 1) for (let x = 0; x < to.width; x += 1) {
      assert.equal(result[y * to.width + x], x < from.width && y < from.height ? source[y * from.width + x] : 0);
    }
  }
});
