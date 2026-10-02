// Classic TIFF, 8-bit RGB + extra samples. Photoshop resources identify the
// extra samples as spot inks (kind=2), rather than transparency/alpha masks.
const encoder = new TextEncoder();
function concat(parts) {
  const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let i=0;for(const part of parts){out.set(part,i);i+=part.length;}return out;
}
function be16(n){return Uint8Array.of(n>>>8,n&255);}
function be32(n){return Uint8Array.of(n>>>24,(n>>>16)&255,(n>>>8)&255,n&255);}
function resource(id, data) {
  return concat([encoder.encode('8BIM'),be16(id),new Uint8Array(2),be32(data.length),data,
    data.length%2?new Uint8Array(1):new Uint8Array(0)]);
}
export function photoshopResources(channels) {
  const legacy=[],unicode=[],display=[],modern=[be32(1)],ids=[];
  channels.forEach((c,i)=>{
    // Legacy Pascal fallback is ASCII; 1045 provides lossless UTF-16 names.
    const ascii=encoder.encode(c.name.replace(/[^\x20-\x7e]/g,'?')).slice(0,255);
    legacy.push(Uint8Array.of(ascii.length),ascii);
    unicode.push(be32(c.name.length));
    for(let j=0;j<c.name.length;j++)unicode.push(be16(c.name.charCodeAt(j)));
    const color=c.color ?? (/white/i.test(c.name)?[255,255,255]:[255,0,255]);
    const record=concat([be16(0),...color.map(x=>be16(x*257)),be16(0),be16(c.solidity ?? 100),Uint8Array.of(2)]);
    display.push(record,Uint8Array.of(0));modern.push(record);
    ids.push(be32(i+1));
  });
  if(!channels.length)return new Uint8Array(0);
  return concat([resource(1006,concat(legacy)),resource(1045,concat(unicode)),
    resource(1007,concat(display)),resource(1077,concat(modern)),resource(1053,concat(ids))]);
}

export function encodeTIFF({width,height,rgb,channels=[],dpi=300}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('Invalid dimensions');
  const pixels=width*height,samples=3+channels.length;
  if(rgb.length!==pixels*3 || channels.some(c=>c.data.length!==pixels))throw new Error('Channel size mismatch');
  const imageLength=pixels*samples;
  if(imageLength>512*1024*1024)throw new Error('TIFF가 512MB를 초과합니다. DPI를 낮춰 주세요.');
  const entries=[];
  const short=(tag,values)=>{const data=new Uint8Array(values.length*2),v=new DataView(data.buffer);values.forEach((x,i)=>v.setUint16(i*2,x,true));entries.push({tag,type:3,count:values.length,data});};
  // Explicit little endian encoding also supports big endian host machines.
  const long=(tag,value)=>{const data=new Uint8Array(4);new DataView(data.buffer).setUint32(0,value,true);entries.push({tag,type:4,count:1,data});};
  const rational=(tag,value)=>{const data=new Uint8Array(8),v=new DataView(data.buffer);v.setUint32(0,value,true);v.setUint32(4,1,true);entries.push({tag,type:5,count:1,data});};
  long(256,width);long(257,height);short(258,Array(samples).fill(8));short(259,[1]);short(262,[2]);
  long(273,0);short(277,[samples]);long(278,height);long(279,imageLength);
  rational(282,dpi);rational(283,dpi);short(284,[1]);short(296,[2]);
  const software=encoder.encode('PDF Spot TIFF - browser JavaScript\0');
  entries.push({tag:305,type:2,count:software.length,data:software});
  if(channels.length){
    short(338,Array(channels.length).fill(0));
    const resources=photoshopResources(channels);
    entries.push({tag:34377,type:1,count:resources.length,data:resources});
  }
  entries.sort((a,b)=>a.tag-b.tag);
  let cursor=8+2+entries.length*12+4;
  for(const entry of entries){if(entry.data.length>4){entry.offset=cursor;cursor+=entry.data.length+(entry.data.length%2);}}
  const imageOffset=cursor;
  new DataView(entries.find(e=>e.tag===273).data.buffer).setUint32(0,imageOffset,true);
  const buffer=new ArrayBuffer(imageOffset+imageLength),view=new DataView(buffer),bytes=new Uint8Array(buffer);
  bytes.set([73,73,42,0]);view.setUint32(4,8,true);view.setUint16(8,entries.length,true);
  entries.forEach((entry,i)=>{
    const offset=10+i*12;
    view.setUint16(offset,entry.tag,true);view.setUint16(offset+2,entry.type,true);view.setUint32(offset+4,entry.count,true);
    if(entry.offset){view.setUint32(offset+8,entry.offset,true);bytes.set(entry.data,entry.offset);}
    else bytes.set(entry.data,offset+8);
  });
  for(let p=0;p<pixels;p++){
    const dest=imageOffset+p*samples;bytes[dest]=rgb[p*3];bytes[dest+1]=rgb[p*3+1];bytes[dest+2]=rgb[p*3+2];
    channels.forEach((c,i)=>bytes[dest+3+i]=c.data[p]);
  }
  return bytes;
}
