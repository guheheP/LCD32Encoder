const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const test=require('node:test');
const assert=require('node:assert/strict');
const html=readFileSync(join(__dirname,'..','index.html'),'utf8');
const script=html.match(/<script id="lcd-gif">([\s\S]*?)<\/script>/)[1];
const gif=vm.runInNewContext(script+'\nLCDGif;');
const encode=(frames,options)=>{const e=gif.create(options);frames.forEach(f=>e.addFrame(f));return Buffer.from(e.finish());};
test('GIF validates invalid dimensions, palettes, frames and lifecycle',()=>{
  const options={width:32,height:64,palette:[[195,211,164],[41,59,40]]};
  assert.throws(()=>gif.create({...options,scale:3}));
  assert.throws(()=>gif.create({...options,palette:[[0,0,0]]}));
  const e=gif.create(options);
  assert.throws(()=>e.finish());
  assert.throws(()=>e.addFrame(new Uint8Array(1)));
  assert.throws(()=>e.addFrame(new Uint8Array(2048).fill(2)));
  e.addFrame(new Uint8Array(2048));
  const bytes=Buffer.from(e.finish());
  assert.equal(bytes.subarray(0,6).toString(),'GIF89a');
  assert.equal(bytes.at(-1),0x3b);
  assert.throws(()=>e.addFrame(new Uint8Array(2048)));
  assert.throws(()=>e.finish());
});
const python=spawnSync('python',['-c','import PIL'],{encoding:'utf8'});
test('independent Pillow decoder restores every pixel, frame, timing, palette and loop setting',{
  skip:python.status!==0 ? 'Optional independent check requires Python and Pillow' : false
},()=>{
  const fixtures=[];
  for(const colors of [2,32,256]) for(const scale of [1,4]) {
    const width=96,height=32;
    const palette=Array.from({length:colors},(_,i)=>colors===2 ? [[195,211,164],[41,59,40]][i] : [i,255-i,(i*73)%256]);
    let state=123456;
    const frames=[new Uint8Array(width*height),new Uint8Array(width*height).fill(colors-1),Uint8Array.from({length:width*height},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state>>>16)%colors;})];
    const loop=scale===4;
    fixtures.push({width,height,scale,delay:130,loop,palette,frames:frames.map(f=>Array.from(f)),data:encode(frames,{width,height,scale,palette,delay:130,loop}).toString('base64')});
  }
  // A long noisy frame forces the LZW dictionary to clear and rebuild.
  const palette=Array.from({length:32},(_,i)=>[Math.round(i*255/31),Math.round(i*255/31),Math.round(i*255/31)]);
  let state=789;
  const noisy=Uint8Array.from({length:256*64},()=>{state=(Math.imul(state,1103515245)+12345)>>>0;return (state>>>16)%32;});
  fixtures.push({width:256,height:64,scale:1,delay:90,loop:true,palette,frames:[Array.from(noisy)],data:encode([noisy],{width:256,height:64,palette,delay:90,loop:true}).toString('base64')});
  const decoder=`import sys,json,base64,io\nfrom PIL import Image\nfor case in json.load(sys.stdin):\n im=Image.open(io.BytesIO(base64.b64decode(case['data'])))\n assert im.size==(case['width']*case['scale'],case['height']*case['scale'])\n assert im.n_frames==len(case['frames'])\n assert im.info.get('loop')==(0 if case['loop'] else None)\n for n,frame in enumerate(case['frames']):\n  im.seek(n)\n  assert im.info['duration']==case['delay']\n  rgb=im.convert('RGB')\n  expected=bytearray()\n  for y in range(im.height):\n   for x in range(im.width):\n    expected.extend(case['palette'][frame[(y//case['scale'])*case['width']+x//case['scale']]])\n  assert rgb.tobytes()==bytes(expected), (case['scale'],len(case['palette']),n)\nprint('7 fixtures decoded with exact pixel matches')`;
  const result=spawnSync('python',['-c',decoder],{input:JSON.stringify(fixtures),encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr);
});
