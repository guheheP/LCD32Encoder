const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');
const html=readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
const extract=id=>html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`))[1];
const presets=vm.runInNewContext(extract('lcd-portrait-presets')+'\nLCDPortraitPresets;');
const codec=vm.runInNewContext(extract('lcd-codec')+'\nLCDCodec;');
for(const name of Object.keys(presets.presets)) test(`${name}: animated portrait spans both panels and round-trips`,()=>{
  const frames=presets.build(name);
  assert.equal(frames.length,presets.presets[name].count);
  assert.ok(new Set(frames.map(f=>Array.from(f).join(''))).size>frames.length/2);
  for(const frame of frames){
    assert.equal(frame.length,2048);
    assert.ok(frame.every(v=>v===0||v===1));
    assert.ok(frame.some(v=>v===1));
  }
  for(const offset of [0,1024]) assert.ok(frames.some(f=>f.slice(offset,offset+1024).filter(Boolean).length>30));
  const encoded=codec.encodeFrames(frames,{width:32,height:64});
  const panels=encoded.split('|');
  assert.equal(panels.length,2);
  for(const panel of panels) assert.equal(panel.split('/').length,frames.length);
  codec.decodeFrames(encoded,{width:32,height:64}).forEach((f,i)=>assert.deepEqual(Array.from(f),Array.from(frames[i])));
});
test('unknown portrait preset is rejected',()=>assert.throws(()=>presets.build('missing')));

test('firework sparks spread and fully burn out before the next launch',()=>{
  const frames=presets.build('fireworks');
  const counts=frames.map(f=>f.slice(0,60*32).filter(Boolean).length);
  assert.ok(Math.max(...counts)>80);
  assert.equal(counts.at(-1),0);
  assert.ok(counts[0]>0);
});
test('human animations wrap without a discontinuous pose jump',()=>{
  for(const name of ['dance','rope','breakdance']) {
    const frames=presets.build(name);
    const difference=(a,b)=>a.reduce((sum,v,k)=>sum+(v!==b[k]),0);
    const largestStep=Math.max(...frames.slice(1).map((f,i)=>difference(f,frames[i])));
    assert.ok(difference(frames.at(-1),frames[0])<=largestStep);
  }
});
