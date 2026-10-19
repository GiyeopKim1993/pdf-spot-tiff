import {instructions} from './pdf-engine.js';
const multiply=(a,b)=>[
  a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]
];
// PDFs have physical page dimensions, not a document-wide raster DPI.
// Use the highest effective image density on each page to avoid downsampling.
export async function originalResolutions(bytes){
  const {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream}=PDFLib;
  const document=await PDFDocument.load(bytes),ctx=document.context,n=PDFName.of;
  const lookup=(dict,key)=>dict?.get(n(key))?ctx.lookup(dict.get(n(key))):undefined;
  const number=(dict,key)=>lookup(dict,key)?.asNumber?.();
  const decode=stream=>Array.from(decodePDFRawStream(stream).decode(),x=>String.fromCharCode(x)).join('');
  return document.getPages().map(page=>{
    let highest=0,images=0;
    const unit=number(page.node,'UserUnit')??1;
    function scan(source,resources,initial,depth=0){
      if(depth>48)throw new Error('원본 DPI 분석 중 PDF Form 중첩 한도를 초과했습니다.');
      let matrix=initial;const stack=[];
      for(const {op,args} of instructions(source)){
        if(op==='q')stack.push(matrix.slice());
        else if(op==='Q'){if(!stack.length)throw new Error('PDF 그래픽 상태가 손상되었습니다.');matrix=stack.pop();}
        else if(op==='cm')matrix=multiply(matrix,args.map(Number));
        else if(op==='Do'){
          const objects=lookup(resources,'XObject'),ref=objects?.get(n(args[0].slice(1)));
          if(!ref)continue;
          const object=ctx.lookup(ref),dict=object.dict;
          const kind=lookup(dict,'Subtype')?.decodeText?.();
          if(kind==='Image'){
            const w=number(dict,'Width'),h=number(dict,'Height');
            const x=Math.hypot(matrix[0],matrix[1])*unit,y=Math.hypot(matrix[2],matrix[3])*unit;
            if(w>0&&h>0&&x>1e-10&&y>1e-10){highest=Math.max(highest,72*w/x,72*h/y);images++;}
          }else if(kind==='Form'&&object instanceof PDFRawStream){
            const transform=lookup(dict,'Matrix');
            const local=transform instanceof PDFArray?transform.asArray().map(x=>ctx.lookup(x).asNumber()):[1,0,0,1,0,0];
            scan(decode(object),lookup(dict,'Resources')??resources,multiply(matrix,local),depth+1);
          }
        }
      }
      if(stack.length)throw new Error('PDF 그래픽 상태가 닫히지 않았습니다.');
    }
    const content=page.node.Contents();
    const streams=content instanceof PDFArray?content.asArray().map(x=>ctx.lookup(x)):content?[content]:[];
    scan(streams.map(decode).join('\n'),page.node.Resources(),[1,0,0,1,0,0]);
    return {dpi:highest>0?Math.round(highest*1000)/1000:300,fallback:images===0};
  });
}
