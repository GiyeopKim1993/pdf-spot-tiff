// TIFF 6.0 LZW: MSB-first codes, early code-width changes, strip-local tables.
export function tiffLZW(data){
  const out=new Uint8Array(data.length*2+1024);let pos=0,buffer=0,used=0,bits=9,next=258;
  let table=new Map();
  function emit(code){
    buffer=(buffer<<bits)|code;used+=bits;
    while(used>=8){used-=8;out[pos++]=(buffer>>>used)&255;}
    buffer&=(1<<used)-1;
  }
  function advance(){
    if(next===4094){emit(256);table=new Map();next=258;bits=9;}
    else if(next>(1<<bits)-1)bits++;
  }
  emit(256);
  if(data.length){
    let prefix=data[0];
    for(let i=1;i<data.length;i++){
      const byte=data[i],key=prefix*256+byte,known=table.get(key);
      if(known!==undefined){prefix=known;continue;}
      emit(prefix);table.set(key,next++);prefix=byte;advance();
    }
    emit(prefix);next++;advance();
  }
  emit(257);if(used)out[pos++]=(buffer<<(8-used))&255;
  return out.slice(0,pos);
}
