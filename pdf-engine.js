/* PDF rewriting stays in JavaScript. pdf-lib handles objects/stream filters;
 * PDF.js performs rasterization. No executable, service, or WASM is required. */
const N = s => PDFLib.PDFName.of(s);
const processNames = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);
const resolve = (doc, obj) => obj && doc.context.lookup(obj);
const get = (doc, dict, key) => dict?.get ? resolve(doc, dict.get(N(key))) : undefined;
const array = obj => obj instanceof PDFLib.PDFArray ? obj.asArray() : [];
const name = obj => obj?.decodeText?.() ?? '';
const refKey = obj => obj?.toString?.() ?? '';
// TextDecoder's Windows-1252 mapping is unsuitable for arbitrary PDF bytes.
const bytesToString = bytes => Array.from(bytes, x => String.fromCharCode(x)).join('');
const stringToBytes = str => Uint8Array.from(str, ch => ch.charCodeAt(0));

export function instructions(source) {
  // Lex composite PDF objects atomically, including escaped/nested strings.
  // Inline image data cannot be safely searched for EI: reject rather than guess.
  let i = 0, args = [], result = [];
  function skip() {
    while (i < source.length) {
      if (/\s|\0/.test(source[i])) { i++; continue; }
      if (source[i] === '%') { while (i < source.length && !/[\r\n]/.test(source[i])) i++; continue; }
      break;
    }
  }
  function token() {
    skip(); const start = i;
    if (source[i] === '(') {
      let depth = 1; i++;
      while (i < source.length && depth) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '(') depth++;
        if (source[i] === ')') depth--;
        i++;
      }
      if (depth) throw new Error('닫히지 않은 PDF 문자열입니다.');
    } else if (source[i] === '[' || source.slice(i, i+2) === '<<') {
      const close = source[i] === '[' ? ']' : '>>';
      i += close.length;
      while (true) {
        skip();
        if (source.slice(i, i+close.length) === close) { i += close.length; break; }
        if (i >= source.length) throw new Error('손상된 PDF 배열/사전입니다.');
        token();
      }
    } else if (source[i] === '<') {
      i = source.indexOf('>', i + 1);
      if (i < 0) throw new Error('손상된 PDF hex 문자열입니다.');
      i++;
    } else {
      if (source[i] === '/') i++;
      while (i < source.length && !/[\s\0()<>\[\]{}\/%]/.test(source[i])) i++;
      if (i === start) throw new Error('알 수 없는 PDF 토큰입니다: ' + source[i]);
    }
    return source.slice(start, i);
  }
  while (true) {
    skip(); if (i >= source.length) break;
    const t = token();
    if (/^[a-zA-Z*'"]+$/.test(t) && !['true', 'false', 'null'].includes(t)) {
      if (t === 'BI') throw new Error('인라인 이미지 PDF는 아직 지원하지 않습니다. 일반 Image XObject로 저장해 주세요.');
      result.push({args, op:t}); args=[];
    } else args.push(t);
  }
  if (args.length) throw new Error('PDF 콘텐츠 끝에 연산자가 누락되었습니다.');
  return result;
}

function spaceInfo(doc, obj) {
  obj = resolve(doc, obj);
  if (!(obj instanceof PDFLib.PDFArray)) return {names:[]};
  const kind = name(resolve(doc, obj.get(0)));
  if (kind === 'Separation') {
    return {kind, obj, names:[name(resolve(doc, obj.get(1)))]};
  }
  if (kind === 'DeviceN' || kind === 'NChannel') {
    return {kind, obj, names:array(resolve(doc, obj.get(1))).map(x=>name(resolve(doc,x)))};
  }
  return {kind, obj, names:[]};
}

function relevant(info) { return info.names.filter(n=>n !== 'None' && n !== 'All' && !processNames.has(n)); }

function walkResources(doc, resources, visit, seen = new Set()) {
  if (!resources || seen.has(resources)) return;
  seen.add(resources);
  const spaces = get(doc, resources, 'ColorSpace');
  for (const [,obj] of spaces?.entries?.() ?? []) visit(spaceInfo(doc,obj));
  const xobjects = get(doc, resources, 'XObject');
  for (const [,ref] of xobjects?.entries?.() ?? []) {
    const obj = resolve(doc,ref);
    visit(spaceInfo(doc, obj.dict?.get(N('ColorSpace'))));
    walkResources(doc, get(doc, obj.dict, 'Resources'), visit, seen);
  }
  const shading = get(doc, resources, 'Shading');
  for (const [,ref] of shading?.entries?.() ?? []) {
    const obj=resolve(doc,ref); visit(spaceInfo(doc, (obj.dict ?? obj).get(N('ColorSpace'))));
  }
  // Patterns require interpreting a nested paint context and tint transforms.
  if (get(doc,resources,'Pattern')?.size()) throw new Error('패턴 컬러 PDF는 아직 지원하지 않습니다. 패턴을 일반 도형으로 확장해 주세요.');
}

export async function analyze(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const inks = new Set(), layers = new Map();
  const oc = get(doc,doc.catalog,'OCProperties');
  for (const ref of array(get(doc,oc,'OCGs'))) {
    const group=resolve(doc,ref), title=name(get(doc,group,'Name'));
    if (/white|spot/i.test(title)) {
      if (!layers.has(title)) layers.set(title,[]);
      layers.get(title).push(refKey(ref));
    }
  }
  for (const page of doc.getPages()) {
    if (array(get(doc,page.node,'Annots')).length) throw new Error('주석/양식이 있는 PDF는 먼저 평면화해 주세요.');
    walkResources(doc,page.node.Resources(), info=> {
      if (relevant(info).length && info.names.some(n=>processNames.has(n))) throw new Error('CMYK와 별색이 혼합된 DeviceN은 아직 지원하지 않습니다. 별도 Separation으로 저장해 주세요.');
      relevant(info).forEach(n=>inks.add(n));
    });
  }
  const channels = [...inks].map(n=>({name:n, kind:'ink'}));
  for (const [title, refs] of layers) {
    const same = channels.find(c=>c.name===title);
    if (same) { same.refs=refs; same.kind='ink+layer'; }
    else channels.push({name:title, kind:'layer', refs});
  }
  if (channels.length > 56) throw new Error('최대 56개 별색 채널까지 지원합니다.');
  return {pageCount:doc.getPageCount(), channels};
}

function cloneDict(doc, dict) { return doc.context.obj(Object.fromEntries(dict.entries().map(([k,v])=>[k.decodeText(),v]))); }

function graySpace(doc, info, target) {
  const i=info.names.indexOf(target);
  const all=info.names[0]==='All';
  if (i < 0 && !all) return info.obj;
  const n=info.names.length, index=all ? 0 : i;
  const code=`{ ${n-1-index} index ${'exch pop '.repeat(n)} 1 exch sub }`;
  const fn=doc.context.register(doc.context.stream(stringToBytes(code), {
    FunctionType:4, Domain:Array(n).fill([0,1]).flat(), Range:[0,1]
  }));
  const objects=info.obj.asArray().slice(0,4);
  objects[2]=N('DeviceGray'); objects[3]=fn;
  return doc.context.obj(objects);
}

export async function filteredPDF(bytes, analysis, mode, target) {
  const doc=await PDFLib.PDFDocument.load(bytes);
  const layerRefs=new Set(analysis.channels.flatMap(c=>c.refs ?? []));
  const selected=new Set(target?.refs ?? []);
  const oc=get(doc,doc.catalog,'OCProperties'), defaults=get(doc,oc,'D');
  const off=new Set(array(get(doc,defaults,'OFF')).map(refKey));
  const on=new Set(array(get(doc,defaults,'ON')).map(refKey));
  const defaultOn=name(get(doc,defaults,'BaseState')) !== 'OFF';
  function layerState(ref, inherited) {
    const obj=resolve(doc,ref);
    if (!obj) throw new Error('PDF 레이어 참조를 찾을 수 없습니다.');
    if (name(get(doc,obj,'Type')) !== 'OCG') throw new Error('OCMD 조건부 레이어는 아직 지원하지 않습니다.');
    const key=refKey(ref);
    if (mode==='layer') return inherited || selected.has(key);
    return inherited && !layerRefs.has(key) && (on.has(key) || (defaultOn && !off.has(key)));
  }
  function decode(stream) {
    if (!(stream instanceof PDFLib.PDFRawStream)) throw new Error('지원하지 않는 PDF 스트림 형식입니다.');
    return bytesToString(PDFLib.decodePDFRawStream(stream).decode());
  }
  function keepColor(info, state) {
    if (!state.visible) return false;
    if (mode==='layer') return true;
    if (mode==='ink') return info.names.includes(target.name) || info.names.includes('All');
    return relevant(info).length===0 && !info.names.includes('All');
  }
  function rewrite(source, originalResources, inherited, depth=0) {
    if(depth>48) throw new Error('PDF Form 중첩이 너무 깊거나 순환 참조입니다.');
    const resources=cloneDict(doc, originalResources);
    const spaces=get(doc,resources,'ColorSpace');
    const originals=new Map((spaces?.entries?.() ?? []).map(([k,v])=>[k.decodeText(),spaceInfo(doc,v)]));
    if(mode==='ink' && spaces) {
      const copy=cloneDict(doc,spaces);
      for(const [k,v] of spaces.entries()) copy.set(k,graySpace(doc,spaceInfo(doc,v),target.name));
      resources.set(N('ColorSpace'),copy);
    }
    const xobjects=cloneDict(doc,get(doc,resources,'XObject') ?? doc.context.obj({}));
    resources.set(N('XObject'),xobjects);
    const shadingResources=cloneDict(doc,get(doc,resources,'Shading') ?? doc.context.obj({}));
    resources.set(N('Shading'),shadingResources);
    let state={...inherited}, marked=[], graphics=[], output=[], counter=0;
    const emit=(op,args=[])=>output.push(`${args.join(' ')} ${op}`);
    const infoFor=t=>originals.get(PDFLib.PDFName.of(t.slice(1)).decodeText()) ?? {names:[]};
    for(const {op,args} of instructions(source)) {
      if(op==='BDC' || op==='BMC') {
        marked.push(state.visible);
        if(op==='BDC' && args[0]==='/OC') {
          if(!args[1]?.startsWith('/') || args.length!==2) throw new Error('인라인 OCG 사전은 아직 지원하지 않습니다.');
          const props=get(doc,resources,'Properties');
          state.visible=layerState(props?.get(PDFLib.PDFName.of(args[1].slice(1))),state.visible);
        }
        continue;
      }
      if(op==='EMC') {
        if(!marked.length) throw new Error('PDF 레이어 범위가 손상되었습니다.');
        state.visible=marked.pop(); continue;
      }
      if(op==='q') graphics.push({...state});
      if(op==='Q') {
        if(!graphics.length) throw new Error('PDF 그래픽 상태가 손상되었습니다.');
        // Optional-content nesting is independent of the graphics-state stack.
        const visible=state.visible; state=graphics.pop(); state.visible=visible;
      }
      if(op==='cs') state.fill=infoFor(args[0]);
      if(op==='CS') state.stroke=infoFor(args[0]);
      if(['g','rg','k'].includes(op)) state.fill={names:[]};
      if(['G','RG','K'].includes(op)) state.stroke={names:[]};
      if(op==='Tr') state.text=Number(args[0]);
      const fill=keepColor(state.fill,state), stroke=keepColor(state.stroke,state);
      if(['S','s','f','F','f*','B','B*','b','b*'].includes(op)) {
        const useFill=['f','F','f*','B','B*','b','b*'].includes(op) && fill;
        const useStroke=['S','s','B','B*','b','b*'].includes(op) && stroke;
        if(!useFill && !useStroke) {emit('n');continue;}
        if(useFill && useStroke) emit(op);
        else if(useFill) emit(op.includes('*')?'f*':'f');
        else emit(['b','b*','s'].includes(op)?'s':'S');
        continue;
      }
      if(['Tj','TJ',"'",'"'].includes(op)) {
        const old=state.text, clip=old>=4, base=old%4;
        const f=[0,2].includes(base)&&fill, s=[1,2].includes(base)&&stroke;
        const next=(f?(s?2:0):(s?1:3))+(clip?4:0);
        emit('Tr',[String(next)]); emit(op,args); emit('Tr',[String(old)]); continue;
      }
      if(op==='sh') {
        const key=PDFLib.PDFName.of(args[0].slice(1));
        const shading=resolve(doc,shadingResources.get(key)), dict=shading?.dict ?? shading;
        let cs=dict?.get(N('ColorSpace'));
        if(resolve(doc,cs) instanceof PDFLib.PDFName) cs=originals.get(name(resolve(doc,cs)))?.obj ?? cs;
        const info=spaceInfo(doc,cs);
        if(!keepColor(info,state)) continue;
        if(mode==='ink') {
          const copy=cloneDict(doc,dict);copy.set(N('ColorSpace'),graySpace(doc,info,target.name));
          const clone=shading instanceof PDFLib.PDFRawStream ? PDFLib.PDFRawStream.of(copy,shading.contents) : copy;
          const newName=N(`SpotShading${depth}_${counter++}`);
          shadingResources.set(newName,doc.context.register(clone));emit('sh',[newName.toString()]);continue;
        }
      }
      if(op==='Do') {
        const key=PDFLib.PDFName.of(args[0].slice(1));
        const obj=resolve(doc,xobjects.get(key));
        if(!(obj instanceof PDFLib.PDFRawStream)) throw new Error('Image/Form을 읽을 수 없습니다.');
        let child={...state};
        const objectOC=obj.dict.get(N('OC'));
        if(objectOC) child.visible=layerState(objectOC,child.visible);
        const subtype=name(get(doc,obj.dict,'Subtype'));
        if(subtype==='Form') {
          const childResources=get(doc,obj.dict,'Resources') ?? originalResources;
          const converted=rewrite(decode(obj),childResources,child,depth+1);
          const dict=cloneDict(doc,obj.dict);
          for(const k of ['Filter','DecodeParms','Length','OC']) dict.delete(N(k));
          dict.set(N('Resources'),converted.resources);
          const form=doc.context.stream(stringToBytes(converted.source),dict);
          const newName=N(`SpotForm${depth}_${counter++}`);
          xobjects.set(newName,doc.context.register(form)); emit('Do',[newName.toString()]); continue;
        }
        if(subtype!=='Image') throw new Error('지원하지 않는 XObject 형식입니다.');
        let cs=obj.dict.get(N('ColorSpace'));
        if(resolve(doc,cs) instanceof PDFLib.PDFName) cs=originals.get(name(resolve(doc,cs)))?.obj ?? cs;
        const info=spaceInfo(doc,cs);
        const stencil=get(doc,obj.dict,'ImageMask')===PDFLib.PDFBool.True;
        if(!(stencil ? keepColor(child.fill,child) : keepColor(info,child))) continue;
        const dict=cloneDict(doc,obj.dict); dict.delete(N('OC'));
        if(mode==='ink' && !stencil) dict.set(N('ColorSpace'),graySpace(doc,info,target.name));
        const image=PDFLib.PDFRawStream.of(dict,obj.contents);
        const newName=N(`SpotImage${depth}_${counter++}`);
        xobjects.set(newName,doc.context.register(image)); emit('Do',[newName.toString()]);continue;
      }
      emit(op,args);
    }
    if(marked.length || graphics.length) throw new Error('PDF 그래픽/레이어 범위가 닫히지 않았습니다.');
    return {source:output.join('\n'),resources};
  }
  for(const page of doc.getPages()) {
    const contents=page.node.Contents();
    const streams=contents instanceof PDFLib.PDFArray ? contents.asArray().map(x=>resolve(doc,x)) : contents?[contents]:[];
    const data=streams.map(decode).join('\n');
    const result=rewrite(data,page.node.Resources(),{visible:mode!=='layer',fill:{names:[]},stroke:{names:[]},text:0});
    page.node.set(N('Resources'),result.resources);
    page.node.set(N('Contents'),doc.context.register(doc.context.stream(stringToBytes(result.source))));
  }
  doc.catalog.delete(N('OCProperties'));
  return doc.save({useObjectStreams:false});
}
