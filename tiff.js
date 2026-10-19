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

function prepareTIFF({width,height,rgb,channels=[],dpi=300,colorMode='rgb',compression=1,stripByteCounts,rowsPerStrip=height,predictor=false}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('Invalid dimensions');
  const pixels=width*height,samples=(colorMode==='cmyk'?4:3)+channels.length;
  if(rgb.length!==pixels*3 || channels.some(c=>c.data.length!==pixels))throw new Error('Channel size mismatch');
  const imageLength=pixels*samples;
  const entries=[];
  const short=(tag,values)=>{const data=new Uint8Array(values.length*2),v=new DataView(data.buffer);values.forEach((x,i)=>v.setUint16(i*2,x,true));entries.push({tag,type:3,count:values.length,data});};
  // Explicit little endian encoding also supports big endian host machines.
  const long=(tag,value)=>{const values=Array.isArray(value)?value:[value],data=new Uint8Array(values.length*4),v=new DataView(data.buffer);values.forEach((x,i)=>v.setUint32(i*4,x,true));entries.push({tag,type:4,count:values.length,data});};
  const rational=(tag,value)=>{const data=new Uint8Array(8),v=new DataView(data.buffer);v.setUint32(0,Math.round(value*1000),true);v.setUint32(4,1000,true);entries.push({tag,type:5,count:1,data});};
  const counts=stripByteCounts??[imageLength];
  long(256,width);long(257,height);short(258,Array(samples).fill(8));short(259,[compression]);short(262,[colorMode==='cmyk'?5:2]);
  long(273,Array(counts.length).fill(0));short(277,[samples]);long(278,rowsPerStrip);long(279,counts);
  if(colorMode==='cmyk')short(332,[1]);
  if(predictor)short(317,[2]);
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
  const storedLength=counts.reduce((n,x)=>n+x,0);
  if(!Number.isSafeInteger(imageLength)||imageOffset+storedLength>0xffffffff)throw new Error('압축 후 TIFF 파일이 Classic TIFF 형식 한도인 4GB를 초과합니다.');
  const offsets=new DataView(entries.find(e=>e.tag===273).data.buffer);let stripOffset=imageOffset;
  counts.forEach((length,i)=>{offsets.setUint32(i*4,stripOffset,true);stripOffset+=length;});
  const buffer=new ArrayBuffer(imageOffset),view=new DataView(buffer),bytes=new Uint8Array(buffer);
  bytes.set([73,73,42,0]);view.setUint32(4,8,true);view.setUint16(8,entries.length,true);
  entries.forEach((entry,i)=>{
    const offset=10+i*12;
    view.setUint16(offset,entry.tag,true);view.setUint16(offset+2,entry.type,true);view.setUint32(offset+4,entry.count,true);
    if(entry.offset){view.setUint32(offset+8,entry.offset,true);bytes.set(entry.data,entry.offset);}
    else bytes.set(entry.data,offset+8);
  });
  return {header:bytes,pixels,samples,imageLength};
}
export function rgbToCMYK(r,g,b){
  const k=255-Math.max(r,g,b);
  if(k===255)return [0,0,0,255];
  const scale=255/(255-k);
  return [Math.round((255-r-k)*scale),Math.round((255-g-k)*scale),Math.round((255-b-k)*scale),k];
}
function writePixels(bytes,start,end,rgb,channels,samples,offset=0,colorMode='rgb'){
  const base=colorMode==='cmyk'?4:3;
  for(let p=start;p<end;p++){
    const dest=offset+(p-start)*samples;
    if(colorMode==='cmyk'){
      const r=rgb[p*3],g=rgb[p*3+1],b=rgb[p*3+2],k=255-Math.max(r,g,b),scale=k===255?0:255/(255-k);
      bytes[dest]=Math.round((255-r-k)*scale);bytes[dest+1]=Math.round((255-g-k)*scale);bytes[dest+2]=Math.round((255-b-k)*scale);bytes[dest+3]=k;
    }else{bytes[dest]=rgb[p*3];bytes[dest+1]=rgb[p*3+1];bytes[dest+2]=rgb[p*3+2];}
    for(let i=0;i<channels.length;i++)bytes[dest+base+i]=channels[i].data[p];
  }
}
export function encodeTIFF(options){
  const {header,pixels,samples,imageLength}=prepareTIFF(options);
  const bytes=new Uint8Array(header.length+imageLength);bytes.set(header);
  writePixels(bytes,0,pixels,options.rgb,options.channels??[],samples,header.length,options.colorMode);
  return bytes;
}
export async function encodeTIFFBlob(options){
  if(options.zip){
    if(typeof CompressionStream==='undefined')throw new Error('이 브라우저는 ZIP 압축을 지원하지 않습니다. 최신 브라우저를 사용해 주세요.');
    const {width,height,rgb,channels=[],colorMode='rgb'}=options,samples=(colorMode==='cmyk'?4:3)+channels.length;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||rgb.length!==width*height*3||channels.some(c=>c.data.length!==width*height))throw new Error('Channel size mismatch');
    const rowsPerStrip=Math.max(1,Math.floor(4*1024*1024/(width*samples))),parts=[],counts=[];
    for(let y=0;y<height;y+=rowsPerStrip){
      const rows=Math.min(rowsPerStrip,height-y),chunk=new Uint8Array(width*rows*samples);
      writePixels(chunk,y*width,(y+rows)*width,rgb,channels,samples,0,colorMode);
      // TIFF horizontal predictor, reverse traversal keeps the left sample intact.
      for(let row=0;row<rows;row++)for(let i=width*samples-1;i>=samples;i--){
        const p=row*width*samples+i;chunk[p]=(chunk[p]-chunk[p-samples]+256)&255;
      }
      const compressed=await new Response(new Blob([chunk]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
      parts.push(new Blob([compressed]));counts.push(compressed.byteLength);
      if(counts.reduce((n,x)=>n+x,0)>0xffffffff-65536)throw new Error('압축 후 TIFF 파일이 4GB 형식 한도를 초과합니다.');
      options.onProgress?.(Math.min(height,y+rows),height);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const {header}=prepareTIFF({...options,compression:8,stripByteCounts:counts,rowsPerStrip,predictor:true});
    return new Blob([header,...parts],{type:'image/tiff'});
  }
  const {header,pixels,samples}=prepareTIFF(options),parts=[new Blob([header])];
  const chunkPixels=Math.max(1,Math.floor(4*1024*1024/samples));
  for(let start=0;start<pixels;start+=chunkPixels){
    const end=Math.min(pixels,start+chunkPixels),chunk=new Uint8Array((end-start)*samples);
    writePixels(chunk,start,end,options.rgb,options.channels??[],samples,0,options.colorMode);
    parts.push(new Blob([chunk]));
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  return new Blob(parts,{type:'image/tiff'});
}
