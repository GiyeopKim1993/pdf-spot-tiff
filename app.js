import {openPDF,raster,maskData} from './render.js';
import {analyze,filteredPDF} from './pdf-engine.js';
import {encodeTIFF} from './tiff.js';
const $=id=>document.getElementById(id);
let bytes,analysis,fileName,generation=0,busy=false,urls=[];
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function clearResults(){urls.forEach(URL.revokeObjectURL);urls=[];$('results').replaceChildren();}
function setBusy(value){busy=value;$('file').disabled=value;$('dpi').disabled=value;$('pages').disabled=value;$('convert').disabled=value||!analysis;}
async function load(file){
  if(!file||busy)return;
  const token=++generation;analysis=null;$('convert').disabled=true;clearResults();$('channels').replaceChildren();$('count').textContent='0개';
  $('pages').replaceChildren(new Option('모든 페이지','all'));
  $('file-name').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`;
  status('별색과 PDF 레이어를 분석하고 있습니다…');
  try{
    const data=new Uint8Array(await file.arrayBuffer()),result=await analyze(data);
    if(token!==generation)return;
    bytes=data;analysis=result;fileName=file.name.replace(/\.pdf$/i,'');
    $('count').textContent=`${result.channels.length}개`;
    if(!result.channels.length)$('channels').textContent='별색/White/Spot 레이어가 없습니다. 일반 RGB TIFF로 저장합니다.';
    for(const channel of result.channels){
      const row=document.createElement('div');row.className='channel';
      const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=/white/i.test(channel.name)?'#fff':'#ff00ff';
      const title=document.createElement('strong');title.textContent=channel.name;
      const kind=document.createElement('small');kind.textContent={'ink':'PDF 별색','layer':'PDF 레이어','ink+layer':'별색 + 동명 레이어'}[channel.kind];
      row.append(swatch,title,kind);$('channels').append(row);
    }
    for(let i=1;i<=result.pageCount;i++)$('pages').add(new Option(`${i} 페이지`,String(i)));
    $('convert').disabled=false;status(`${result.pageCount}페이지 분석 완료. 변환할 준비가 되었습니다.`);
  }catch(error){if(token===generation)status(error.message,true);}
}
$('file').addEventListener('change',event=>load(event.target.files[0]));
for(const name of ['dragover','dragleave','drop'])$('drop').addEventListener(name,event=>{
  event.preventDefault();$('drop').classList.toggle('over',name==='dragover');
  if(name==='drop')load(event.dataTransfer.files[0]);
});
$('convert').addEventListener('click',async()=>{
  if(!analysis||busy)return;setBusy(true);clearResults();
  const dpi=Number($('dpi').value),selected=$('pages').value;
  const pages=selected==='all'?Array.from({length:analysis.pageCount},(_,i)=>i+1):[Number(selected)];
  const documents=[];
  try{
    status('기본 이미지에서 별색과 대상 레이어를 분리하고 있습니다…');
    const base=await openPDF(await filteredPDF(bytes,analysis,'process'));documents.push(base);
    const variants=[];
    for(const channel of analysis.channels){
      status(`${channel.name} 채널을 준비하고 있습니다…`);
      const variant={channel};
      if(channel.kind.includes('ink')){variant.ink=await openPDF(await filteredPDF(bytes,analysis,'ink',channel));documents.push(variant.ink);}
      if(channel.refs){variant.layer=await openPDF(await filteredPDF(bytes,analysis,'layer',channel));documents.push(variant.layer);}
      variants.push(variant);
    }
    for(const index of pages){
      status(`${index} / ${analysis.pageCount} 페이지를 렌더링하고 있습니다…`);
      const image=await raster(base,index,dpi),pixels=image.width*image.height;
      if(pixels*(3+analysis.channels.length)>256*1024*1024)throw new Error('출력 채널 데이터가 256MB를 초과합니다. DPI를 낮춰 주세요.');
      const rgb=new Uint8Array(pixels*3);
      for(let i=0;i<pixels;i++)rgb.set(image.data.subarray(i*4,i*4+3),i*3);
      const channels=[];
      for(const variant of variants){
        status(`${index}페이지 · ${variant.channel.name} 채널 추출 중…`);
        let data;
        if(variant.ink)data=maskData(await raster(variant.ink,index,dpi),false);
        if(variant.layer){
          const layer=maskData(await raster(variant.layer,index,dpi,true),true);
          if(data)for(let i=0;i<layer.length;i++)data[i]=Math.min(data[i],layer[i]);
          else data=layer;
        }
        channels.push({name:variant.channel.name,data});
      }
      status(`${index}페이지 TIFF 파일을 생성하고 있습니다…`);
      const tiff=encodeTIFF({width:image.width,height:image.height,rgb,channels,dpi});
      const url=URL.createObjectURL(new Blob([tiff],{type:'image/tiff'}));urls.push(url);
      const row=document.createElement('article');row.className='result';
      const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),link=document.createElement('a');
      title.textContent=`${index}페이지`;detail.textContent=`${image.width} × ${image.height} px · ${dpi} DPI · RGB + 별색 ${channels.length}개`;
      link.className='download';link.href=url;link.download=`${fileName}-${String(index).padStart(4,'0')}.tif`;link.textContent=`TIFF 다운로드 · ${(tiff.length/1024/1024).toFixed(1)} MB`;
      const preview=document.createElement('canvas'),scale=Math.min(240/image.width,320/image.height,1);
      preview.width=Math.round(image.width*scale);preview.height=Math.round(image.height*scale);preview.getContext('2d').drawImage(image.canvas,0,0,preview.width,preview.height);
      image.canvas.width=image.canvas.height=0;
      info.append(title,detail,link);row.append(preview,info);$('results').append(row);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    status(`${pages.length}개 TIFF 생성 완료. 아래에서 다운로드하세요.`);
  }catch(error){console.error(error);status(`변환 실패: ${error.message}`,true);}
  finally{await Promise.allSettled(documents.map(doc=>doc.destroy()));setBusy(false);}
});
status('PDF를 선택해 주세요. 모든 변환은 이 브라우저 안에서 실행됩니다.');
