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
  if(width*height>32_000_000)throw new Error('페이지가 3,200만 픽셀을 초과합니다. DPI를 낮춰 주세요.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  await page.render({canvasContext:context,viewport,background:alpha?'rgba(0,0,0,0)':'rgb(255,255,255)'}).promise;
  const data=context.getImageData(0,0,width,height).data;page.cleanup();
  return {canvas,width,height,data};
}
export function maskData(image,alpha){
  const out=new Uint8Array(image.width*image.height);
  for(let i=0;i<out.length;i++)out[i]=alpha?255-image.data[i*4+3]:image.data[i*4];
  image.canvas.width=image.canvas.height=0;return out;
}
