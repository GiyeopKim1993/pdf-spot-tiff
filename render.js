import * as pdfjs from './pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',import.meta.url).href;
let fontAssets;
async function asset(path) {
  fontAssets ??= fetch(new URL('./font-data.json',import.meta.url)).then(response=>{if(!response.ok)throw new Error('Font assets unavailable');return response.json();});
  const encoded=(await fontAssets)[path];
  if(!encoded)throw new Error('Missing font/CMap: '+path);
  return Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
}
class LocalCMapFactory {
  async fetch({name}) {return {cMapData:await asset('cmaps/'+name+'.bcmap'),compressionType:1};}
}
class LocalFontFactory {
  async fetch({filename}) {return asset('standard_fonts/'+filename);}
}
export async function openPDF(data){return pdfjs.getDocument({data:data.slice(),useWasm:false,isEvalSupported:false,
  useWorkerFetch:false,CMapReaderFactory:LocalCMapFactory,StandardFontDataFactory:LocalFontFactory}).promise;}
export async function raster(doc,index,dpi,alpha=false){
  const page=await doc.getPage(index),viewport=page.getViewport({scale:dpi/72});
  const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  await page.render({canvasContext:context,viewport,background:alpha?'rgba(0,0,0,0)':'rgb(255,255,255)'}).promise;
  const data=context.getImageData(0,0,width,height).data;page.cleanup();
  return {canvas,width,height,data};
}
// Render bounded tiles rather than creating a page-sized browser canvas.
// The output buffer stores only RGB or one mask sample per pixel.
export async function rasterPixels(doc,index,dpi,mode='rgb'){
  const page=await doc.getPage(index),viewport=page.getViewport({scale:dpi/72});
  const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height),samples=mode==='rgb'?3:1;
  if(!Number.isSafeInteger(width*height*samples)||width<1||height<1)throw new Error('유효하지 않은 출력 크기입니다.');
  const data=new Uint8Array(width*height*samples);
  const preview=document.createElement('canvas'),scale=Math.min(240/width,320/height,1);
  preview.width=Math.max(1,Math.round(width*scale));preview.height=Math.max(1,Math.round(height*scale));
  const previewContext=preview.getContext('2d');
  const tile=document.createElement('canvas');
  try{
    for(let y=0;y<height;y+=1024)for(let x=0;x<width;x+=2048){
      tile.width=Math.min(2048,width-x);tile.height=Math.min(1024,height-y);
      const context=tile.getContext('2d',{willReadFrequently:true});
      await page.render({canvasContext:context,viewport,transform:[1,0,0,1,-x,-y],
        background:mode==='alpha'?'rgba(0,0,0,0)':'rgb(255,255,255)'}).promise;
      const rgba=context.getImageData(0,0,tile.width,tile.height).data;
      for(let row=0;row<tile.height;row++)for(let col=0;col<tile.width;col++){
        const src=(row*tile.width+col)*4,dest=((y+row)*width+x+col)*samples;
        if(mode==='rgb'){data[dest]=rgba[src];data[dest+1]=rgba[src+1];data[dest+2]=rgba[src+2];}
        else data[dest]=mode==='alpha'?255-rgba[src+3]:rgba[src];
      }
      if(mode==='rgb')previewContext.drawImage(tile,x*scale,y*scale,tile.width*scale,tile.height*scale);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {width,height,data,canvas:preview};
  }finally{tile.width=tile.height=0;page.cleanup();}
}
export function maskData(image,alpha){
  const out=new Uint8Array(image.width*image.height);
  for(let i=0;i<out.length;i++)out[i]=alpha?255-image.data[i*4+3]:image.data[i*4];
  image.canvas.width=image.canvas.height=0;return out;
}
