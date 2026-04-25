import { useState, useRef, useCallback, useEffect, useMemo } from 'react'

// ════════════════════════════════════════════
// §1  Storage & Utilities
// ════════════════════════════════════════════

const ST={baseUrl:'board:baseUrl',apiKey:'board:apiKey',model:'board:model',maskModel:'board:maskModel',settingsOpen:'board:settingsOpen'}
function ld(k,fb=''){try{return localStorage.getItem(k)??fb}catch{return fb}}
function sv(k,v){try{localStorage.setItem(k,v)}catch{}}
function normBase(url){url=(url||'https://api.openai.com/v1').trim().replace(/\/+$/,'');if(url.endsWith('/responses'))url=url.slice(0,-'/responses'.length);if(url.endsWith('/images/edits'))url=url.slice(0,-'/images/edits'.length);return url}
function fileToDataUrl(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(f)})}
function dataUrlToBlob(d){const[h,b64]=d.split(',');const mime=h.match(/:(.*?);/)[1];const bin=atob(b64);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type:mime})}
function dataUrlToBlobUrl(dataUrl){return URL.createObjectURL(dataUrlToBlob(dataUrl))}
async function blobUrlToDataUrl(blobUrl){const r=await fetch(blobUrl);const b=await r.blob();return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=()=>rej(fr.error);fr.readAsDataURL(b)})}
async function blobUrlToBlob(blobUrl){const r=await fetch(blobUrl);return r.blob()}
function guessMime(f){return f==='jpeg'?'image/jpeg':f==='webp'?'image/webp':'image/png'}

// [H1 fix] Safely revoke a blob URL (no-op for data URLs / null)
function revokeUrl(url){if(url&&typeof url==='string'&&url.startsWith('blob:'))try{URL.revokeObjectURL(url)}catch{}}

// ════════════════════════════════════════════
// §2  IndexedDB — History (max 100)
// ════════════════════════════════════════════

const DB_NAME='board-db',DB_VER=1,DB_STORE='history',MAX_HISTORY=100

function openDB(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(DB_NAME,DB_VER)
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(DB_STORE))req.result.createObjectStore(DB_STORE,{keyPath:'id'})}
    req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error)
  })
}

// [L3 fix] Don't mutate IDB result objects — create new objects
async function historyLoad(){
  try{
    const db=await openDB()
    const all=await new Promise(r=>{const req=db.transaction(DB_STORE,'readonly').objectStore(DB_STORE).getAll();req.onsuccess=()=>r(req.result)})
    return all.sort((a,b)=>b.ts-a.ts).map(h=>{
      let displayUrl
      if(h.blob) displayUrl=URL.createObjectURL(h.blob)
      else if(h.src) displayUrl=h.src
      return{...h,displayUrl}
    })
  }catch{return[]}
}

async function historySave(entry){
  try{
    const db=await openDB();const tx=db.transaction(DB_STORE,'readwrite');const s=tx.objectStore(DB_STORE)
    s.put(entry)
    const all=await new Promise(r=>{const req=s.getAll();req.onsuccess=()=>r(req.result)})
    if(all.length>MAX_HISTORY){all.sort((a,b)=>a.ts-b.ts);for(let i=0;i<all.length-MAX_HISTORY;i++)s.delete(all[i].id)}
    await new Promise(r=>{tx.oncomplete=r})
    return true
  }catch(e){console.warn('historySave:',e);return false}
}

async function historyDelete(id){
  try{const db=await openDB();const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).delete(id);await new Promise(r=>{tx.oncomplete=r})}catch{}
}

async function historyClear(){
  try{const db=await openDB();const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).clear();await new Promise(r=>{tx.oncomplete=r})}catch{}
}

// ════════════════════════════════════════════
// §3  Resolution — Tier × Ratio compute
// ════════════════════════════════════════════

const TIERS = [
  { id: '4K', longEdge: 3840 },
  { id: '2K', longEdge: 2560 },
  { id: '1.5K', longEdge: 1920 },
  { id: '1K', longEdge: 1024 },
  { id: 'custom', longEdge: 0 },
]

const RATIOS = [
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:2', w: 3, h: 2 },
  { id: '16:10', w: 16, h: 10 },
  { id: '16:9', w: 16, h: 9 },
  { id: '2:1', w: 2, h: 1 },
  { id: '21:9', w: 21, h: 9 },
  { id: '3:1', w: 3, h: 1 },
]

function computeRes(longEdge, rw, rh, landscape = true) {
  if (rw === rh) {
    let s = Math.min(longEdge, Math.floor(Math.sqrt(8294400) / 16) * 16)
    return { w: s, h: s }
  }
  const longR = Math.max(rw, rh), shortR = Math.min(rw, rh)
  let long = longEdge
  // [R3-L2] Use Math.round for short edge to maximize resolution
  let short = Math.round(long * shortR / longR / 16) * 16
  if (long * short > 8294400) {
    const scale = Math.sqrt(8294400 / (long * short))
    long = Math.floor(long * scale / 16) * 16
    short = Math.round(short * scale / 16) * 16
    // Ensure we don't exceed after rounding up
    if (long * short > 8294400) short = Math.floor(short / 16 - 1) * 16
  }
  if (long > 3840) long = 3840
  if (short < 256) return null
  if (long * short < 655360) return null
  if (long / short > 3) return null
  return landscape ? { w: long, h: short } : { w: short, h: long }
}

// [R3-L1] Handle broken images gracefully
function onImgError(e){e.target.style.opacity='0.3';e.target.alt='[图片不可用]'}

function validateSize(w,h){const e=[];if(w%16)e.push(`宽 ${w} 非16倍数`);if(h%16)e.push(`高 ${h} 非16倍数`);const l=Math.max(w,h),s=Math.min(w,h);if(l>3840)e.push(`长边 > 3840`);if(l/s>3)e.push(`比例 > 3:1`);const t=w*h;if(t<655360)e.push('像素不足');if(t>8294400)e.push('像素超限');return{valid:!e.length,errors:e,experimental:t>2560*1440}}
function parseSizeStr(s){if(!s||s==='auto')return null;const m=s.match(/^(\d+)x(\d+)$/);return m?{w:+m[1],h:+m[2]}:null}

// ════════════════════════════════════════════
// §4  APIs (Responses + Images Edit)
// ════════════════════════════════════════════

async function buildInput(prompt,refs){
  if(!refs.length)return prompt
  const c=[{type:'input_text',text:prompt}]
  for(const r of refs){
    let dataUrl
    if(r.file) dataUrl = await fileToDataUrl(r.file)
    else if(r.blobUrl) dataUrl = await blobUrlToDataUrl(r.blobUrl)
    else if(r.dataUrl) dataUrl = r.dataUrl
    else continue
    c.push({type:'input_image',image_url:dataUrl})
  }
  return[{role:'user',content:c}]
}
function buildTool(p){const t={type:'image_generation'};if(p.size&&p.size!=='auto')t.size=p.size;if(p.quality)t.quality=p.quality;if(p.action&&p.action!=='auto')t.action=p.action;if(p.format)t.format=p.format;if(p.compression!==''&&p.compression!=null&&(p.format==='jpeg'||p.format==='webp'))t.compression=Number(p.compression);if(p.streaming)t.partial_images=3;return t}
function extractImage(json){
  for(const it of(json.output||[])){
    if(it?.type==='image_generation_call'){
      const r=it.result
      const b64=typeof r==='string'?r:Array.isArray(r)?r.find(v=>typeof v==='string'):r?.b64_json||r?.data||null
      if(b64)return{b64,summary:{id:json.id,revised_prompt:it.revised_prompt,usage:json.usage}}
    }
  }
  for(const it of(json.output||[])){
    if(it?.type==='message'&&Array.isArray(it.content)){
      for(const c of it.content)if(c?.type==='image'&&c.source?.data)return{b64:c.source.data,summary:{id:json.id,usage:json.usage}}
    }
  }
  if(json.data?.[0]?.b64_json)return{b64:json.data[0].b64_json,summary:{revised_prompt:json.data[0].revised_prompt,usage:json.usage}}
  const outputCount=(json.output||[]).length
  const types=(json.output||[]).map(o=>`${o?.type}(${o?.status||'?'})`).join(',')
  const status=json.status||'unknown'
  const err=json.error?JSON.stringify(json.error):''
  const incomplete=json.incomplete_details?JSON.stringify(json.incomplete_details):''
  throw new Error(`……没有找到图像数据。status=${status}, outputs=${outputCount}[${types}]${err?' error='+err:''}${incomplete?' incomplete='+incomplete:''}`)
}

async function*parseSSE(reader){const dec=new TextDecoder();let buf='';while(true){const{value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop()||'';for(const l of lines)if(l.startsWith('data: ')){const d=l.slice(6).trim();if(d==='[DONE]')return;try{yield JSON.parse(d)}catch{}}}}

// [L4 fix] Only deep-clone events that have useful debug data; for others just log type+seq
function logEvent(ev){
  const base={type:ev.type,sequence_number:ev.sequence_number}
  if(ev.type==='response.image_generation_call.partial_image'){
    return{...base,size:ev.size,quality:ev.quality,output_format:ev.output_format,partial_image_index:ev.partial_image_index,b64_len:ev.partial_image_b64?.length||0}
  }
  if(ev.type==='response.completed'||ev.type==='response.done'){
    const resp=ev.response||{}
    return{...base,id:resp.id,status:resp.status,outputTypes:(resp.output||[]).map(o=>({type:o?.type,status:o?.status,hasResult:!!o?.result}))}
  }
  if(ev.type==='response.created'){return{...base,id:ev.response?.id,model:ev.response?.model}}
  return base
}

async function callResponses({base,key,model,prompt,refs,params,streaming,onPartial,onStatus,onDebug}){
  const tool=buildTool({...params,streaming});const input=await buildInput(prompt,refs);const payload={model:model||'gpt-5.4',input,tools:[tool]}
  if(params.toolChoice)payload.tool_choice={type:'image_generation'};if(streaming)payload.stream=true
  onDebug?.({type:'request',payload:{...payload,input:'[omitted]'}})
  let hostname;try{hostname=new URL(base).hostname}catch{hostname=base}
  onStatus?.('loading',`……向 ${hostname} 发送……`)
  const resp=await fetch(`${base}/responses`,{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})
  if(!resp.ok){let msg=`HTTP ${resp.status}`;try{const e=await resp.json();msg=e.error?.message||e.error||msg;onDebug?.({type:'error_response',body:e})}catch{};throw new Error(msg)}
  const mime=guessMime(params.format)
  if(streaming){
    onStatus?.('loading','……生成中……')
    let f=null, lastPartialB64=null, lastPartialMeta=null, partialCount=0
    const sseEvents=[]
    try {
      for await(const ev of parseSSE(resp.body.getReader())){
        sseEvents.push(logEvent(ev))
        if(ev.type==='response.image_generation_call.partial_image'&&ev.partial_image_b64){
          partialCount++
          lastPartialB64=ev.partial_image_b64
          lastPartialMeta={size:ev.size,quality:ev.quality}
          onPartial?.(`data:${mime};base64,${ev.partial_image_b64}`)
        }
        if(ev.type==='response.completed') f=ev.response
        if(ev.type==='response.done'&&ev.response) f=f||ev.response
      }
    } catch(streamErr) {
      onDebug?.({type:'sse_stream_error',error:streamErr.message,eventsBeforeError:sseEvents.length,lastPartialSize:lastPartialB64?lastPartialB64.length:0,partialCount})
    }
    onDebug?.({type:'sse_events',count:sseEvents.length,partialImages:partialCount,events:sseEvents})
    const reqSize = params.size && params.size !== 'auto' ? params.size : null
    const partialFullRes = lastPartialMeta?.size && reqSize && lastPartialMeta.size === reqSize
    if(f){
      try{
        const{b64,summary}=extractImage(f)
        return{src:`data:${mime};base64,${b64}`,summary}
      }catch(e){
        const safeOutput = (f.output||[]).map(o=>{const c={...o};if(typeof c.result==='string'&&c.result.length>200)c.result=`[truncated ${c.result.length} chars]`;return c})
        onDebug?.({type:'extractImage_failed',error:e.message,rawOutput:safeOutput})
        if(lastPartialB64) return{src:`data:${mime};base64,${lastPartialB64}`,summary:{note:'fallback to last partial',id:f.id,partialIndex:partialCount-1},fallback:true,fullRes:partialFullRes}
        throw e
      }
    }
    if(lastPartialB64){
      onDebug?.({type:'no_completed_fallback',partialCount})
      return{src:`data:${mime};base64,${lastPartialB64}`,summary:{note:'stream interrupted',partialIndex:partialCount-1},fallback:true,fullRes:partialFullRes}
    }
    onDebug?.({type:'stream_failed'})
    throw new Error('……stream——没有completed事件，也没有partial image。')
  }else{
    onStatus?.('loading','……等待结果……');const data=await resp.json()
    const safeData={...data,output:(data.output||[]).map(o=>{const c={...o};if(typeof c.result==='string'&&c.result.length>200)c.result=`[truncated ${c.result.length} chars]`;return c})}
    onDebug?.({type:'non_stream_response',id:data.id,status:data.status,error:data.error,incomplete_details:data.incomplete_details,outputCount:(data.output||[]).length,outputTypes:(data.output||[]).map(o=>({type:o?.type,status:o?.status,hasResult:!!o?.result})),fullResponse:safeData})
    const{b64,summary}=extractImage(data);return{src:`data:${mime};base64,${b64}`,summary}
  }
}

// [M6 fix] Added onDebug to callImagesEdit
async function callImagesEdit({base,key,model,prompt,imageDataUrl,maskDataUrl,params,onStatus,onDebug}){
  onStatus?.('loading','……发送编辑请求……');const form=new FormData()
  form.append('model',model||'gpt-image-2');form.append('prompt',prompt)
  const imgBlob=imageDataUrl.startsWith('blob:')?await blobUrlToBlob(imageDataUrl):dataUrlToBlob(imageDataUrl)
  form.append('image',imgBlob,'image.png')
  if(maskDataUrl){const mBlob=maskDataUrl.startsWith('blob:')?await blobUrlToBlob(maskDataUrl):dataUrlToBlob(maskDataUrl);form.append('mask',mBlob,'mask.png')}
  if(params.size&&params.size!=='auto')form.append('size',params.size);if(params.quality)form.append('quality',params.quality)
  onDebug?.({type:'edit_request',model:model||'gpt-image-2',size:params.size,quality:params.quality,hasMask:!!maskDataUrl})
  const resp=await fetch(`${base}/images/edits`,{method:'POST',headers:{'Authorization':`Bearer ${key}`},body:form})
  if(!resp.ok){let msg=`HTTP ${resp.status}`;try{const e=await resp.json();msg=e.error?.message||e.error||msg;onDebug?.({type:'edit_error',body:e})}catch{};throw new Error(msg)}
  const data=await resp.json()
  onDebug?.({type:'edit_response',hasData:!!data.data?.[0]?.b64_json})
  const b64=data.data?.[0]?.b64_json;if(!b64)throw new Error('……没有图像数据。')
  return{src:`data:image/png;base64,${b64}`,summary:{revised_prompt:data.data[0].revised_prompt,usage:data.usage}}
}

async function runConcurrent(tasks,limit){const exec=new Set();for(const task of tasks){const p=task().finally(()=>exec.delete(p));exec.add(p);if(exec.size>=limit)await Promise.race(exec)};await Promise.all(exec)}

// ════════════════════════════════════════════
// §5  Task Factory
// ════════════════════════════════════════════

// [M1/M2 fix] Each task has its own debugLog and statusText
function createTask(inherit=null){return{id:crypto.randomUUID(),prompt:'',references:[],
  size:inherit?.size??'3840x2160',quality:inherit?.quality??'high',action:inherit?.action??'auto',
  format:inherit?.format??'',compression:inherit?.compression??'',
  toolChoice:inherit?.toolChoice??true,streaming:inherit?.streaming??false,
  result:null,partialSrc:null,type:'generate',editSource:null,editMask:null,retry:null,
  debugLog:[],statusText:'',statusType:'idle'}}

function taskLabel(t,idx){if(t.type==='edit')return`✎ 编辑`;const p=(t.prompt||'').trim();if(p)return p.slice(0,18)+(p.length>18?'…':'');return`任务 ${idx+1}`}

// ════════════════════════════════════════════
// §6  Export / Import
// ════════════════════════════════════════════

async function exportSession(tasks){
  const exportTasks=[]
  for(const t of tasks){
    let resultSrc=null
    if(t.result?.src){resultSrc=t.result.src.startsWith('blob:')?await blobUrlToDataUrl(t.result.src):t.result.src}
    const refs=[]
    for(const r of t.references){
      let du=r.blobUrl&&r.file?await fileToDataUrl(r.file):r.blobUrl?await blobUrlToDataUrl(r.blobUrl):r.dataUrl||null
      if(du)refs.push({dataUrl:du,id:r.id})
    }
    exportTasks.push({prompt:t.prompt,type:t.type,size:t.size,quality:t.quality,action:t.action,format:t.format,compression:t.compression,toolChoice:t.toolChoice,streaming:t.streaming,resultSrc,editSource:t.editSource||null,references:refs})
  }
  const data={version:2,exported:new Date().toISOString(),tasks:exportTasks}
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'})
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`board-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href)
}

async function importSession(file){
  const data=JSON.parse(await file.text())
  return(data.tasks||[]).map(t=>{
    const task=createTask()
    task.prompt=t.prompt||'';task.type=t.type||'generate'
    task.size=t.size||'3840x2160';task.quality=t.quality||'high'
    task.action=t.action||'auto';task.format=t.format||'';task.compression=t.compression||''
    task.toolChoice=t.toolChoice??true;task.streaming=t.streaming??false
    if(t.resultSrc){const blobUrl=dataUrlToBlobUrl(t.resultSrc);task.result={status:'done',src:blobUrl,summary:null,error:null}}
    if(t.editSource)task.editSource=t.editSource
    if(t.references?.length)task.references=t.references.map(r=>{const blobUrl=r.dataUrl?dataUrlToBlobUrl(r.dataUrl):null;return{blobUrl,id:r.id||crypto.randomUUID()}})
    return task
  })
}

// ════════════════════════════════════════════
// §7  MaskCanvas
// ════════════════════════════════════════════

function MaskCanvas({imageUrl,onMaskExport}){
  const canvasRef=useRef(null);const[drawing,setDrawing]=useState(false);const[brushSize,setBrushSize]=useState(30);const[imgDims,setImgDims]=useState(null)
  const onMaskExportRef=useRef(onMaskExport) // [M.H fix] stable ref for effect
  useEffect(()=>{onMaskExportRef.current=onMaskExport})
  useEffect(()=>{if(!imageUrl)return;const img=new Image();img.onload=()=>{setImgDims({w:img.naturalWidth,h:img.naturalHeight});const ctx=canvasRef.current?.getContext('2d');if(ctx)ctx.clearRect(0,0,img.naturalWidth,img.naturalHeight)};img.src=imageUrl},[imageUrl])
  const getPos=useCallback(e=>{const c=canvasRef.current;if(!c)return null;const r=c.getBoundingClientRect();const t=e.touches?.[0]||e;return{x:(t.clientX-r.left)*c.width/r.width,y:(t.clientY-r.top)*c.height/r.height}},[])
  const startDraw=useCallback(e=>{e.preventDefault();setDrawing(true);const p=getPos(e);if(!p)return;const ctx=canvasRef.current?.getContext('2d');if(!ctx)return;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=brushSize*(canvasRef.current.width/canvasRef.current.getBoundingClientRect().width);ctx.strokeStyle='rgba(212,133,154,0.55)';ctx.stroke()},[getPos,brushSize])
  const moveDraw=useCallback(e=>{if(!drawing)return;e.preventDefault();const p=getPos(e);if(!p)return;const ctx=canvasRef.current?.getContext('2d');if(!ctx)return;ctx.lineTo(p.x,p.y);ctx.stroke()},[drawing,getPos])
  const endDraw=useCallback(()=>setDrawing(false),[])
  const clearMask=useCallback(()=>{const ctx=canvasRef.current?.getContext('2d');if(ctx&&imgDims)ctx.clearRect(0,0,imgDims.w,imgDims.h);onMaskExportRef.current?.(null)},[imgDims])
  useEffect(()=>{
    if(drawing||!imgDims)return;const c=canvasRef.current;if(!c)return
    const ctx=c.getContext('2d');const dd=ctx.getImageData(0,0,imgDims.w,imgDims.h)
    let has=false;for(let i=3;i<dd.data.length;i+=4)if(dd.data[i]>10){has=true;break}
    if(!has){onMaskExportRef.current?.(null);return}
    const mc=document.createElement('canvas');mc.width=imgDims.w;mc.height=imgDims.h
    const mx=mc.getContext('2d');mx.fillStyle='#fff';mx.fillRect(0,0,imgDims.w,imgDims.h)
    const md=mx.getImageData(0,0,imgDims.w,imgDims.h)
    for(let i=0;i<dd.data.length;i+=4)if(dd.data[i+3]>10)md.data[i+3]=0
    mx.putImageData(md,0,0);onMaskExportRef.current?.(mc.toDataURL('image/png'))
  },[drawing,imgDims])
  if(!imageUrl||!imgDims)return null;const dw=Math.min(imgDims.w,520),dh=(imgDims.h/imgDims.w)*dw
  return(<div className="mask-editor"><div className="mask-toolbar"><label><span>笔刷</span><input type="range" min="5" max="80" value={brushSize} onChange={e=>setBrushSize(+e.target.value)}/><span className="mono">{brushSize}px</span></label><button className="btn-secondary btn-sm" onClick={clearMask}>清除</button></div><div className="mask-canvas-wrap" style={{width:dw,height:dh}}><img src={imageUrl} alt="" style={{width:'100%',height:'100%',objectFit:'contain'}} draggable={false}/><canvas ref={canvasRef} width={imgDims.w} height={imgDims.h} style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',cursor:'crosshair'}} onMouseDown={startDraw} onMouseMove={moveDraw} onMouseUp={endDraw} onMouseLeave={endDraw} onTouchStart={startDraw} onTouchMove={moveDraw} onTouchEnd={endDraw}/></div><p className="mask-hint">……粉色区域——会被编辑替换。</p></div>)
}

// ════════════════════════════════════════════
// §8  SizeSelector — Tier × Ratio × Orientation
// ════════════════════════════════════════════

function SizeSelector({value, onChange}) {
  const parsed = parseSizeStr(value)
  const [tier, setTier] = useState('4K')
  const [ratio, setRatio] = useState('16:9')
  const [landscape, setLandscape] = useState(true)
  const [cw, setCw] = useState(parsed?.w ?? 3840)
  const [ch, setCh] = useState(parsed?.h ?? 2160)

  const applyPreset = useCallback((t, r, land) => {
    const tierObj = TIERS.find(x => x.id === t)
    const ratioObj = RATIOS.find(x => x.id === r)
    if (!tierObj || !ratioObj) return
    const res = computeRes(tierObj.longEdge, ratioObj.w, ratioObj.h, ratioObj.w === ratioObj.h ? true : land)
    if (res) onChange(`${res.w}x${res.h}`)
  }, [onChange])

  const prevValueRef = useRef(value)
  useEffect(() => {
    if (value === prevValueRef.current) return
    prevValueRef.current = value
    if (value === 'auto') return
    const p = parseSizeStr(value)
    if (!p) return
    setCw(p.w); setCh(p.h)
    for (const t of TIERS) {
      if (t.id === 'custom') continue
      for (const r of RATIOS) {
        for (const land of (r.w === r.h ? [true] : [true, false])) {
          const res = computeRes(t.longEdge, r.w, r.h, land)
          if (res && res.w === p.w && res.h === p.h) {
            setTier(t.id); setRatio(r.id); setLandscape(land)
            return
          }
        }
      }
    }
    setTier('custom')
  }, [value])

  const computedRes = useMemo(() => {
    if (tier === 'custom' || value === 'auto') return null
    const t = TIERS.find(x => x.id === tier)
    const r = RATIOS.find(x => x.id === ratio)
    if (!t || !r) return null
    return computeRes(t.longEdge, r.w, r.h, r.w === r.h ? true : landscape)
  }, [tier, ratio, landscape, value])

  const handleTierChange = (newTier) => { setTier(newTier); if (newTier === 'custom') { onChange(`${cw}x${ch}`); return }; applyPreset(newTier, ratio, landscape) }
  const handleRatioChange = (newRatio) => { setRatio(newRatio); if (tier !== 'custom') applyPreset(tier, newRatio, landscape) }
  const handleOrientToggle = () => { const l = !landscape; setLandscape(l); if (tier !== 'custom') applyPreset(tier, ratio, l) }
  const handleAutoToggle = () => { if (value === 'auto') { applyPreset(tier, ratio, landscape); return }; onChange('auto') }

  const v = useMemo(() => {
    if (value === 'auto') return { valid: true, errors: [], experimental: false }
    const p = parseSizeStr(value)
    return p ? validateSize(p.w, p.h) : { valid: true, errors: [], experimental: false }
  }, [value])

  const isAuto = value === 'auto'
  const ratioObj = RATIOS.find(r => r.id === ratio)
  const isSquare = ratioObj?.w === ratioObj?.h

  return (
    <div className="size-selector">
      <div className="size-row">
        <label className="size-label">Size{v.experimental && <span className="exp-tag">experimental</span>}</label>
        <button className={`size-auto-btn ${isAuto ? 'active' : ''}`} onClick={handleAutoToggle}>auto</button>
      </div>
      {!isAuto && <>
        <div className="size-controls">
          <select value={tier} onChange={e => handleTierChange(e.target.value)} className="size-tier">
            {TIERS.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          {tier !== 'custom' && <>
            <span className="mono size-x">×</span>
            <select value={ratio} onChange={e => handleRatioChange(e.target.value)} className="size-ratio">
              {RATIOS.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
            {!isSquare && <button className="size-orient" onClick={handleOrientToggle}>{landscape ? '横' : '竖'}</button>}
          </>}
        </div>
        {tier === 'custom' ? (
          <div className="custom-size">
            <input type="number" min="256" max="3840" step="16" value={cw} onChange={e => { setCw(+e.target.value); onChange(`${+e.target.value}x${ch}`) }} placeholder="宽" />
            <span className="mono size-x">×</span>
            <input type="number" min="256" max="3840" step="16" value={ch} onChange={e => { setCh(+e.target.value); onChange(`${cw}x${+e.target.value}`) }} placeholder="高" />
            {parsed && <span className="size-pixels">{(parsed.w * parsed.h / 1000000).toFixed(1)}MP</span>}
          </div>
        ) : computedRes && (
          <div className="size-result">
            <span className="mono">{computedRes.w} × {computedRes.h}</span>
            <span className="size-pixels">{(computedRes.w * computedRes.h / 1000000).toFixed(1)}MP</span>
          </div>
        )}
        {!v.valid && <div className="size-errors">{v.errors.map((e, i) => <span key={i}>{e}</span>)}</div>}
      </>}
    </div>
  )
}

// ════════════════════════════════════════════
// §9  ParamsPanel
// ════════════════════════════════════════════

function ParamsPanel({p,set}){
  const handleSizeChange = (newSize) => {
    const parsed = parseSizeStr(newSize)
    const patch = { ...p, size: newSize }
    if (parsed && parsed.w * parsed.h > 2560 * 1440) patch.streaming = false
    set(patch)
  }
  return(<>
    <SizeSelector value={p.size} onChange={handleSizeChange}/>
    <div className="params-grid">
      <div className="field"><label>Quality</label><select value={p.quality} onChange={e=>set({...p,quality:e.target.value})}><option value="auto">auto</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></div>
      <div className="field"><label>Action</label><select value={p.action} onChange={e=>set({...p,action:e.target.value})}><option value="auto">auto</option><option value="generate">generate</option><option value="edit">edit</option></select></div>
    </div>
    <div className="params-grid">
      <div className="field"><label>Format</label><select value={p.format} onChange={e=>set({...p,format:e.target.value})}><option value="">default</option><option value="png">png</option><option value="jpeg">jpeg</option><option value="webp">webp</option></select></div>
      <div className="field"><label>Compression</label><input type="number" min="0" max="100" value={p.compression} onChange={e=>set({...p,compression:e.target.value})} placeholder="0–100"/></div>
    </div>
    <label className="checkbox-field"><input type="checkbox" checked={p.toolChoice} onChange={e=>set({...p,toolChoice:e.target.checked})}/><span>强制使用 image_generation 工具</span></label>
    <label className="checkbox-field"><input type="checkbox" checked={p.streaming} onChange={e=>set({...p,streaming:e.target.checked})}/><span>流式传输{p.size&&parseSizeStr(p.size)&&parseSizeStr(p.size).w*parseSizeStr(p.size).h>2560*1440?' (大分辨率建议关闭)':''}</span></label>
  </>)
}

// ════════════════════════════════════════════
// §10  Lightbox — zoom / pan / 1:1
// ════════════════════════════════════════════

function Lightbox({ src, onClose }) {
  const [scale, setScale] = useState('fit')
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragStart, setDragStart] = useState(null)
  const [imgNatural, setImgNatural] = useState(null)
  const containerRef = useRef(null)

  useEffect(() => { setScale('fit'); setPos({ x: 0, y: 0 }) }, [src])

  const actualScale = useMemo(() => {
    if (scale !== 'fit' || !imgNatural || !containerRef.current) return typeof scale === 'number' ? scale : 1
    const rect = containerRef.current.getBoundingClientRect()
    return Math.min(rect.width / imgNatural.w, rect.height / imgNatural.h, 1)
  }, [scale, imgNatural])

  const zoomTo = useCallback((s) => { setScale(Math.max(0.1, Math.min(10, s))) }, [])
  const handleWheel = useCallback((e) => { e.preventDefault(); const s = typeof scale === 'number' ? scale : actualScale; zoomTo(s * (e.deltaY < 0 ? 1.15 : 0.87)) }, [scale, actualScale, zoomTo])
  const handlePointerDown = useCallback((e) => { if (e.button !== 0) return; setDragging(true); setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y }); e.currentTarget.setPointerCapture(e.pointerId) }, [pos])
  const handlePointerMove = useCallback((e) => { if (!dragging || !dragStart) return; setPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }) }, [dragging, dragStart])
  const handlePointerUp = useCallback(() => { setDragging(false) }, [])

  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') zoomTo((typeof scale === 'number' ? scale : actualScale) * 1.2)
      if (e.key === '-') zoomTo((typeof scale === 'number' ? scale : actualScale) * 0.83)
      if (e.key === '0') { setScale('fit'); setPos({ x: 0, y: 0 }) }
      if (e.key === '1') { setScale(1); setPos({ x: 0, y: 0 }) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, scale, actualScale, zoomTo])

  const displayPercent = Math.round(actualScale * 100)

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-toolbar" onClick={e => e.stopPropagation()}>
        <button onClick={() => { setScale('fit'); setPos({ x: 0, y: 0 }) }} className={scale === 'fit' ? 'active' : ''}>适应</button>
        <button onClick={() => { setScale(1); setPos({ x: 0, y: 0 }) }} className={scale === 1 ? 'active' : ''}>1:1</button>
        <button onClick={() => zoomTo((typeof scale === 'number' ? scale : actualScale) * 0.75)}>−</button>
        <span className="mono">{displayPercent}%</span>
        <button onClick={() => zoomTo((typeof scale === 'number' ? scale : actualScale) * 1.33)}>+</button>
        <button onClick={onClose} className="lightbox-close">✕</button>
      </div>
      <div className="lightbox-canvas" ref={containerRef} onClick={e => e.stopPropagation()}
        onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>
        <img src={src} alt="" draggable={false}
          onLoad={e => setImgNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${actualScale})`, cursor: dragging ? 'grabbing' : 'grab' }} />
      </div>
      {imgNatural && <div className="lightbox-info"><span className="mono">{imgNatural.w} × {imgNatural.h}</span></div>}
    </div>
  )
}

// ════════════════════════════════════════════
// §11  Main App
// ════════════════════════════════════════════

const DEFAULT_PARAMS={size:'3840x2160',quality:'high',action:'auto',format:'',compression:'',toolChoice:true,streaming:false}
function loadDefaultParams(){try{const s=localStorage.getItem('board:defaultParams');return s?{...DEFAULT_PARAMS,...JSON.parse(s)}:DEFAULT_PARAMS}catch{return DEFAULT_PARAMS}}
function saveDefaultParams(p){try{localStorage.setItem('board:defaultParams',JSON.stringify(p))}catch{}}

export default function App(){
  const[baseUrl,setBaseUrl]=useState(()=>ld(ST.baseUrl,''));const[apiKey,setApiKey]=useState(()=>ld(ST.apiKey,''))
  const[model,setModel]=useState(()=>ld(ST.model,'gpt-5.4'));const[maskModel,setMaskModel]=useState(()=>ld(ST.maskModel,'gpt-image-2'))
  const[settingsOpen,setSettingsOpen]=useState(()=>ld(ST.settingsOpen,'true')==='true')
  useEffect(()=>{sv(ST.baseUrl,baseUrl)},[baseUrl]);useEffect(()=>{sv(ST.apiKey,apiKey)},[apiKey])
  useEffect(()=>{sv(ST.model,model)},[model]);useEffect(()=>{sv(ST.maskModel,maskModel)},[maskModel])
  useEffect(()=>{sv(ST.settingsOpen,settingsOpen?'true':'false')},[settingsOpen])

  const[defaultParams,setDefaultParams]=useState(loadDefaultParams)
  const updateDefaults=useCallback(p=>{setDefaultParams(p);saveDefaultParams(p)},[])

  const[concurrency,setConcurrency]=useState(3)
  const[tasks,setTasks]=useState(()=>[createTask(loadDefaultParams())])
  const[activeIdx,setActiveIdx]=useState(0)
  useEffect(()=>{if(activeIdx>=tasks.length)setActiveIdx(Math.max(0,tasks.length-1))},[tasks.length,activeIdx])
  const[generatingIds,setGeneratingIds]=useState(new Set())
  const inflightRef=useRef(new Set())

  const[history,setHistory]=useState([])
  const[historyOpen,setHistoryOpen]=useState(false)
  // [H1 fix] Revoke old history blob URLs before reloading
  const historyUrlsRef=useRef([])
  const reloadHistory=useCallback(()=>{
    historyUrlsRef.current.forEach(revokeUrl)
    historyLoad().then(items=>{
      historyUrlsRef.current=items.map(h=>h.displayUrl).filter(u=>u?.startsWith('blob:'))
      setHistory(items)
    })
  },[])
  useEffect(()=>{reloadHistory()},[]) // eslint-disable-line

  const[toasts,setToasts]=useState([])
  const showToast=useCallback((text,taskId=null)=>{
    const id=crypto.randomUUID();setToasts(prev=>[...prev,{id,text,taskId}])
    setTimeout(()=>setToasts(prev=>prev.filter(t=>t.id!==id)),4000)
  },[])

  // Browser notification
  useEffect(()=>{if('Notification' in window&&Notification.permission==='default')Notification.requestPermission()},[])
  useEffect(()=>{const n=generatingIds.size;document.title=n>0?`[${n} 生成中] B.O.A.R.D.`:'B.O.A.R.D.'},[generatingIds.size])
  const notify=useCallback((title,body)=>{try{if(document.hidden&&'Notification' in window&&Notification.permission==='granted')new Notification(title,{body})}catch{}},[])

  // [M5 fix] beforeunload protection
  useEffect(()=>{
    const handler=e=>{if(generatingIds.size>0){e.preventDefault();e.returnValue=''}}
    window.addEventListener('beforeunload',handler)
    return()=>window.removeEventListener('beforeunload',handler)
  },[generatingIds.size])

  // [L2 fix] Export loading state
  const[exporting,setExporting]=useState(false)

  const task=tasks[activeIdx]||tasks[0]||createTask()
  // [M3 fix] Removed direct mutation — createTask guarantees references=[]
  const updateTask=useCallback((idx,patch)=>{setTasks(prev=>{const n=[...prev];n[idx]={...n[idx],...patch};return n})},[])
  const updateTaskById=useCallback((id,patch)=>{setTasks(prev=>prev.map(t=>t.id===id?{...t,...patch}:t))},[])

  const addTask=useCallback(()=>{const t=createTask(defaultParams);setTasks(prev=>{const n=[...prev,t];setActiveIdx(n.length-1);return n})},[defaultParams])
  // [H1 fix] Revoke blob URLs when removing task
  const removeTask=useCallback((idx)=>{
    if(tasks.length<=1)return
    const t=tasks[idx]
    if(t){revokeUrl(t.result?.src);revokeUrl(t.partialSrc);t.references?.forEach(r=>revokeUrl(r.blobUrl))}
    setTasks(prev=>prev.filter((_,i)=>i!==idx));setActiveIdx(prev=>prev>=idx?Math.max(0,prev-1):prev)
  },[tasks])

  // File handling — stabilized via ref to avoid paste listener churn
  const activeTaskRef=useRef({idx:activeIdx,refs:task.references})
  useEffect(()=>{activeTaskRef.current={idx:activeIdx,refs:task.references}})
  const addFiles=useCallback(async(files)=>{
    const{idx,refs}=activeTaskRef.current
    const nr=[];for(const f of files){if(!f.type.startsWith('image/'))continue;nr.push({file:f,blobUrl:URL.createObjectURL(f),id:crypto.randomUUID()})}
    updateTask(idx,{references:[...refs,...nr]})
  },[updateTask]) // stable deps
  const fileInputRef=useRef(null);const importInputRef=useRef(null)
  const[dragOver,setDragOver]=useState(false)

  // [M4 fix] Paste handler — skip when user is typing in a text field
  useEffect(()=>{
    const handler=async(e)=>{
      const tag=document.activeElement?.tagName
      if(tag==='TEXTAREA'||tag==='INPUT')return // don't intercept text paste
      const items=e.clipboardData?.items;if(!items)return
      const imgItems=Array.from(items).filter(i=>i.type.startsWith('image/'))
      if(!imgItems.length)return
      e.preventDefault()
      const files=imgItems.map(i=>i.getAsFile()).filter(Boolean)
      if(files.length)addFiles(files)
    }
    window.addEventListener('paste',handler)
    return()=>window.removeEventListener('paste',handler)
  },[addFiles])

  // Drag reorder refs
  const dragRef=useRef(null)
  const handleRefDragStart=useCallback((e,idx)=>{dragRef.current=idx;e.dataTransfer.effectAllowed='move'},[])
  const handleRefDragOver=useCallback((e)=>{e.preventDefault();e.dataTransfer.dropEffect='move'},[])
  const handleRefDrop=useCallback((e,idx)=>{
    e.preventDefault();const from=dragRef.current;if(from==null||from===idx)return
    updateTask(activeIdx,{references:((refs)=>{const n=[...refs];const[item]=n.splice(from,1);n.splice(idx,0,item);return n})(task.references)})
    dragRef.current=null
  },[activeIdx,task,updateTask])

  // [R3-H2] Stable refs for async loops (must be declared before generateAll/retryUntilSuccess)
  const tasksRef=useRef(tasks);useEffect(()=>{tasksRef.current=tasks})
  const generateOneRef=useRef(null) // set after generateOne is defined

  // [M1 fix] Per-task debug log helper
  const addDebugToTask=useCallback((tid,entry)=>{
    setTasks(prev=>prev.map(t=>t.id===tid?{...t,debugLog:[...(t.debugLog||[]),{ts:Date.now(),...entry}]}:t))
  },[])

  // [M2 fix] Per-task status helper
  const setTaskStatus=useCallback((tid,type,text)=>{
    updateTaskById(tid,{statusType:type,statusText:text})
  },[updateTaskById])

  // ── Generate ──
  const generateOne=useCallback(async(idx)=>{
    const t=tasks[idx];if(!t||!(t.prompt||'').trim()){showToast('……提示词——不能是空的。');return false}
    if(!apiKey.trim()){showToast('……API Key——需要填写。');if(!settingsOpen)setSettingsOpen(true);return false}
    if(inflightRef.current.has(t.id))return false
    inflightRef.current.add(t.id)
    const tid=t.id
    const p={size:t.size,quality:t.quality,action:t.action,format:t.format,compression:t.compression,toolChoice:t.toolChoice,streaming:t.streaming}
    const parsed=parseSizeStr(p.size);if(parsed&&!validateSize(parsed.w,parsed.h).valid){setTaskStatus(tid,'error','……分辨率——不符合要求。');inflightRef.current.delete(tid);return false}
    const base=normBase(baseUrl);setGeneratingIds(prev=>new Set(prev).add(tid))
    // [M1 fix] Clear per-task debug log; [R2-H2] Revoke old result blob URL
    setTasks(prev=>prev.map(tk=>{if(tk.id!==tid)return tk;revokeUrl(tk.result?.src);revokeUrl(tk.partialSrc);return{...tk,debugLog:[],result:{status:'loading',src:null,summary:null,error:null},partialSrc:null,statusType:'loading',statusText:'……准备中……'}}))
    const onDebug=entry=>addDebugToTask(tid,entry)
    let ok=false
    try{
      let r
      if(t.type==='edit'){
        r=await callImagesEdit({base,key:apiKey.trim(),model:maskModel.trim(),prompt:t.prompt.trim(),imageDataUrl:t.editSource,maskDataUrl:t.editMask,params:p,
          onStatus:(tp,msg)=>setTaskStatus(tid,tp,msg),onDebug})
      }else{
        r=await callResponses({base,key:apiKey.trim(),model:model.trim(),prompt:t.prompt.trim(),refs:t.references,params:p,streaming:p.streaming,
          onPartial:src=>{
            // [H1 fix] Revoke old partial before setting new
            setTasks(prev=>prev.map(tk=>{if(tk.id!==tid)return tk;revokeUrl(tk.partialSrc);return{...tk,partialSrc:dataUrlToBlobUrl(src)}}))
          },
          onStatus:(tp,msg)=>setTaskStatus(tid,tp,msg),onDebug})
      }
      // [H1 fix] Revoke old partialSrc
      setTasks(prev=>prev.map(tk=>{if(tk.id!==tid)return tk;revokeUrl(tk.partialSrc);return tk}))
      const resultBlobUrl=dataUrlToBlobUrl(r.src)
      updateTaskById(tid,{result:{status:'done',src:resultBlobUrl,summary:r.summary,error:null,fallback:!!r.fallback,fullRes:!!r.fullRes},partialSrc:null})
      const label=(t.prompt||'').trim().slice(0,12)
      if(r.fallback){
        if(r.fullRes){showToast(`✓ ${label}… 完成（分辨率匹配）`,tid);notify('B.O.A.R.D.','完成');setTaskStatus(tid,'success','……完成了。连接中断——partial image 分辨率匹配。')}
        else{showToast(`⚠ ${label}… 连接中断——已使用预览图`,tid);notify('B.O.A.R.D.','连接中断');setTaskStatus(tid,'success','……连接中断——已使用预览图。')}
      }else{
        showToast(`✓ ${label}… 完成`,tid);notify('B.O.A.R.D.','生成完成')
        setTaskStatus(tid,'success',t.type==='edit'?'……编辑完成。':'……完成了。')
      }
      const resultBlob=dataUrlToBlob(r.src)
      const entry={id:crypto.randomUUID(),ts:Date.now(),prompt:t.prompt.trim(),blob:resultBlob,type:t.type,params:p}
      historySave(entry).then(saved=>{if(!saved)showToast('⚠ 历史保存失败——存储空间可能不足');reloadHistory()})
      ok=true
    }catch(err){
      updateTaskById(tid,{result:{status:'error',src:null,summary:null,error:err.message}})
      showToast(`✗ 失败: ${err.message.slice(0,30)}`,tid)
      notify('B.O.A.R.D.',`失败: ${err.message.slice(0,50)}`)
      setTaskStatus(tid,'error',err.message)
    }
    finally{inflightRef.current.delete(tid);setGeneratingIds(prev=>{const n=new Set(prev);n.delete(tid);return n})}
    return ok
  },[tasks,apiKey,baseUrl,model,maskModel,updateTaskById,settingsOpen,showToast,addDebugToTask,setTaskStatus,notify,reloadHistory])

  const generateAll=useCallback(async()=>{
    if(!apiKey.trim()){showToast('……API Key——需要填写。');return}
    const vt=tasks.filter(t=>(t.prompt||'').trim()&&!inflightRef.current.has(t.id))
    if(!vt.length){const empty=tasks.filter(t=>!(t.prompt||'').trim()).length;showToast(empty?`${empty} 个任务没有提示词。`:'没有可以生成的任务。');return}
    let okCount=0,failCount=0
    await runConcurrent(vt.map(t=>async()=>{
      // [R4-M2] Look up current index by ID at execution time via ref
      const idx=tasksRef.current.findIndex(x=>x.id===t.id)
      if(idx<0)return
      const ok=await generateOneRef.current(idx)
      if(ok)okCount++;else failCount++
    }),concurrency)
    showToast(failCount===0?`✓ ${okCount} 个任务——全部完成。`:`完成 ${okCount} / 失败 ${failCount}。`)
  },[tasks,apiKey,concurrency,showToast])

  const retryNoStream=useCallback(async(idx)=>{
    const t=tasks[idx];if(!t||!(t.prompt||'').trim()||!apiKey.trim())return
    if(inflightRef.current.has(t.id))return
    inflightRef.current.add(t.id)
    const tid=t.id
    const p={size:t.size,quality:t.quality,action:t.action,format:t.format,compression:t.compression,toolChoice:t.toolChoice,streaming:false}
    const base=normBase(baseUrl);setGeneratingIds(prev=>new Set(prev).add(tid))
    const onDebug=entry=>addDebugToTask(tid,entry)
    // [R2-L1] Revoke old result blob URL
    setTasks(prev=>prev.map(tk=>{if(tk.id!==tid)return tk;revokeUrl(tk.result?.src);revokeUrl(tk.partialSrc);return{...tk,debugLog:[],result:{status:'loading',src:null,summary:null,error:null,fallback:false},partialSrc:null,statusType:'loading',statusText:'……重试中（非流式）……'}}))
    try{
      const r=await callResponses({base,key:apiKey.trim(),model:model.trim(),prompt:t.prompt.trim(),refs:t.references,params:p,streaming:false,onStatus:(tp,msg)=>setTaskStatus(tid,tp,msg),onDebug})
      const resultBlobUrl=dataUrlToBlobUrl(r.src)
      updateTaskById(tid,{result:{status:'done',src:resultBlobUrl,summary:r.summary,error:null,fallback:false},partialSrc:null})
      showToast(`✓ 完成`,tid);notify('B.O.A.R.D.','生成完成');setTaskStatus(tid,'success','……完成了。')
      const resultBlob=dataUrlToBlob(r.src)
      historySave({id:crypto.randomUUID(),ts:Date.now(),prompt:t.prompt.trim(),blob:resultBlob,type:t.type,params:p}).then(saved=>{if(!saved)showToast('⚠ 历史保存失败');reloadHistory()})
    }catch(err){
      updateTaskById(tid,{result:{status:'error',src:null,summary:null,error:err.message,fallback:false}})
      showToast(`✗ 失败: ${err.message.slice(0,30)}`,tid);setTaskStatus(tid,'error',err.message)
    }finally{inflightRef.current.delete(tid);setGeneratingIds(prev=>{const n=new Set(prev);n.delete(tid);return n})}
  },[tasks,apiKey,baseUrl,model,updateTaskById,showToast,addDebugToTask,setTaskStatus,notify,reloadHistory])

  // Auto-retry (per-task) — uses refs for stable async access
  const cancelRetryRef=useRef(new Set())
  const retryUntilSuccess=useCallback(async(idx,maxAttempts=100)=>{
    const tid=tasks[idx]?.id;if(!tid)return
    cancelRetryRef.current.delete(tid)
    updateTaskById(tid,{retry:{attempt:0,max:maxAttempts,active:true}})
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      if(cancelRetryRef.current.has(tid)){updateTaskById(tid,{retry:null});setTaskStatus(tid,'idle',`……重试已取消（第 ${attempt-1} 次）。`);return}
      updateTaskById(tid,{retry:{attempt,max:maxAttempts,active:true}})
      // [R3-H2] Look up current index by tid each iteration
      const currentIdx=tasksRef.current.findIndex(t=>t.id===tid)
      if(currentIdx<0){updateTaskById(tid,{retry:null});return} // task was deleted
      const ok=await generateOneRef.current(currentIdx)
      if(ok){updateTaskById(tid,{retry:null});return}
      await new Promise(r=>setTimeout(r,3000))
    }
    updateTaskById(tid,{retry:null});setTaskStatus(tid,'error',`……${maxAttempts} 次尝试均失败。`)
  },[tasks,updateTaskById,setTaskStatus]) // tasksRef/generateOneRef accessed via ref, not closure
  const cancelRetry=useCallback((tid)=>{cancelRetryRef.current.add(tid)},[])

  const startMaskEdit=useCallback(srcDataUrl=>{const t=createTask();t.type='edit';t.editSource=srcDataUrl;setTasks(prev=>{const n=[...prev,t];setActiveIdx(n.length-1);return n})},[])

  // [H2 fix] Download: infer extension from blob MIME, not regex on URL
  const dl=useCallback(async(src,prefix='board')=>{
    let ext='png'
    try{const blob=src.startsWith('blob:')?await blobUrlToBlob(src):dataUrlToBlob(src);const m=blob.type.match(/image\/(\w+)/);if(m)ext=m[1]==='jpeg'?'jpg':m[1]}catch{}
    const a=document.createElement('a');a.href=src;a.download=`${prefix}-${Date.now()}.${ext}`;document.body.appendChild(a);a.click();a.remove()
  },[])
  const cpText=useCallback(async src=>{try{const du=src.startsWith('blob:')?await blobUrlToDataUrl(src):src;const b=du.split(',')?.[1];if(b){await navigator.clipboard.writeText(b);showToast('……base64——已复制。')}}catch{showToast('……复制失败。')}},[showToast])
  const cpImage=useCallback(async src=>{try{const blob=src.startsWith('blob:')?await blobUrlToBlob(src):dataUrlToBlob(src);await navigator.clipboard.write([new ClipboardItem({[blob.type]:blob})]);showToast('……图片——已复制到剪贴板。')}catch{showToast('……复制失败——浏览器可能不支持。')}},[showToast])

  // [L2 fix] Export with loading state
  const handleExport=useCallback(async()=>{
    const withResults=tasks.filter(t=>t.result?.src).length
    if(withResults>5&&!confirm(`导出 ${withResults} 张结果图——可能需要较多内存。继续？`))return
    setExporting(true);try{await exportSession(tasks)}finally{setExporting(false)}
  },[tasks])
  const handleImport=useCallback(async e=>{const f=e.target.files?.[0];if(!f)return;try{const imported=await importSession(f);if(imported.length){
    // Revoke all blob URLs from old tasks before replacing
    tasks.forEach(t=>{revokeUrl(t.result?.src);revokeUrl(t.partialSrc);t.references?.forEach(r=>revokeUrl(r.blobUrl))})
    setTasks(imported);setActiveIdx(0);showToast(`导入了 ${imported.length} 个任务。`)}else{showToast('文件里没有任务。')}}catch(err){showToast(`导入失败——${err.message}`)};e.target.value=''},[tasks,showToast])

  const loadFromHistory=useCallback(async(entry)=>{
    const t=createTask(defaultParams)
    t.prompt=entry.prompt||''
    // [R2-M2] Create a new blob URL — don't share with history list
    let imgUrl=null
    if(entry.blob) imgUrl=URL.createObjectURL(entry.blob)
    else if(entry.displayUrl?.startsWith('blob:')) {try{const b=await blobUrlToBlob(entry.displayUrl);imgUrl=URL.createObjectURL(b)}catch{imgUrl=entry.displayUrl}}
    else imgUrl=entry.displayUrl||entry.src
    t.result={status:'done',src:imgUrl,summary:null,error:null}
    if(entry.params){
      t.size=entry.params.size||defaultParams.size;t.quality=entry.params.quality||defaultParams.quality
      t.action=entry.params.action||defaultParams.action;t.format=entry.params.format||defaultParams.format
      t.compression=entry.params.compression??defaultParams.compression
      t.toolChoice=entry.params.toolChoice??defaultParams.toolChoice;t.streaming=entry.params.streaming??defaultParams.streaming
    }
    setTasks(prev=>{const n=[...prev,t];setActiveIdx(n.length-1);return n})
  },[defaultParams])

  const isGenerating=generatingIds.size>0;const taskIsGenerating=generatingIds.has(task.id);const displaySrc=task.result?.src||task.partialSrc
  const[lightboxSrc,setLightboxSrc]=useState(null)
  // [M2 fix] Show active task's status
  const status={type:task.statusType||'idle',text:task.statusText||''}

  // Sync generateOneRef after generateOne is defined
  useEffect(()=>{generateOneRef.current=generateOne})
  // ════════════════════════════════════════
  // Render
  // ════════════════════════════════════════

  return(<div className="app-shell">
    <header className="app-header">
      <div className="board">[&gt;v&lt;]</div>
      <h1>B.O.A.R.D.<span>Browser-Operated API Rendering Display</span></h1>
      <div className="header-actions">
        <button className="btn-secondary btn-sm" onClick={handleExport} disabled={exporting} title="导出会话">{exporting?'……':'↑ 导出'}</button>
        <button className="btn-secondary btn-sm" onClick={()=>importInputRef.current?.click()} title="导入会话">↓ 导入</button>
        <input ref={importInputRef} type="file" accept=".json" className="sr-only" onChange={handleImport}/>
      </div>
    </header>

    <button className="settings-toggle" onClick={()=>setSettingsOpen(!settingsOpen)}>
      <span className={`chevron ${settingsOpen?'open':''}`}>▸</span>连接设置
      {!settingsOpen&&apiKey&&<span style={{color:'var(--success)',marginLeft:6}}>● 已保存</span>}
    </button>
    {settingsOpen&&<div className="settings-panel">
      <div className="field"><label>Base URL</label><input type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1"/></div>
      <div className="field"><label>API Key</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off"/></div>
      <div className="field"><label>Responses Model</label><input type="text" value={model} onChange={e=>setModel(e.target.value)} placeholder="gpt-5.4"/></div>
      <div className="field"><label>Images API Model（区域编辑）</label><input type="text" value={maskModel} onChange={e=>setMaskModel(e.target.value)} placeholder="gpt-image-2"/></div>
      <div className="saved-hint">……设定保存在浏览器里。</div>
    </div>}

    <div className="tab-bar">
      <div className="tab-scroll">
        {tasks.map((t,i)=>(
          <button key={t.id} className={`tab ${i===activeIdx?'active':''} ${generatingIds.has(t.id)?'generating':''} ${t.result?.status==='done'?'done':''} ${t.result?.status==='error'?'error':''} ${t.retry?.active?'retrying':''}`}
            onClick={()=>setActiveIdx(i)}>
            <span className="tab-label">{taskLabel(t,i)}{t.retry?.active?` ↻${t.retry.attempt}`:''}</span>
            {tasks.length>1&&<span className="tab-close" onClick={e=>{e.stopPropagation();removeTask(i)}}>×</span>}
          </button>
        ))}
      </div>
      <button className="tab-add" onClick={addTask} title="新任务">+</button>
    </div>

    <div className="main-grid">
      <div className="card">
        {task.type==='edit'&&<div className="edit-badge">✎ 区域编辑 — Images API</div>}
        <div className="card-title">提示词</div>
        <div className="field"><textarea value={task.prompt||''} onChange={e=>updateTask(activeIdx,{prompt:e.target.value})}
          placeholder={task.type==='edit'?'……描述编辑后——整张图应该是什么样子。':'……描述想要生成的图像。'}
          onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();generateOne(activeIdx)}}}/></div>

        {task.type==='edit'&&task.editSource&&<MaskCanvas imageUrl={task.editSource} onMaskExport={url=>updateTask(activeIdx,{editMask:url})}/>}

        {task.type==='generate'&&<>
          <ParamsPanel p={task} set={patch=>updateTask(activeIdx,patch)}/>
          <div className="params-actions">
            <button className="btn-text" onClick={()=>{updateDefaults({size:task.size,quality:task.quality,action:task.action,format:task.format,compression:task.compression,toolChoice:task.toolChoice,streaming:task.streaming});showToast('……当前参数已设为默认。')}}>设为默认</button>
            <span className="params-sep">·</span>
            <button className="btn-text" onClick={()=>{if(!confirm('……确定要恢复为默认参数吗？'))return;const d=defaultParams;updateTask(activeIdx,{size:d.size,quality:d.quality,action:d.action,format:d.format,compression:d.compression,toolChoice:d.toolChoice,streaming:d.streaming});showToast('……已恢复为默认参数。')}}>恢复默认</button>
            <span className="params-sep">·</span>
            <button className="btn-text" style={{color:'var(--text-muted)'}} onClick={()=>{if(!confirm('……确定要还原出厂设置吗？当前任务的参数和保存的默认值都会被重置。'))return;updateDefaults(DEFAULT_PARAMS);updateTask(activeIdx,{size:DEFAULT_PARAMS.size,quality:DEFAULT_PARAMS.quality,action:DEFAULT_PARAMS.action,format:DEFAULT_PARAMS.format,compression:DEFAULT_PARAMS.compression,toolChoice:DEFAULT_PARAMS.toolChoice,streaming:DEFAULT_PARAMS.streaming});showToast('……已还原出厂设置。')}}>出厂设置</button>
          </div>

          <div className={`drop-zone ${dragOver?'dragover':''}`} onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);if(e.dataTransfer.files.length)addFiles(Array.from(e.dataTransfer.files))}} onClick={()=>fileInputRef.current?.click()}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={e=>{if(e.target.files?.length)addFiles(Array.from(e.target.files));e.target.value=''}}/>
            <p><span className="accent-text">点击</span>、拖拽或 <span className="accent-text">Ctrl+V 粘贴</span>——添加参考图片</p>
          </div>
          {task.references.length>0&&<div className="thumbs-row">
            {task.references.map((ref,i)=><div key={ref.id} className="thumb-item" draggable onDragStart={e=>handleRefDragStart(e,i)} onDragOver={handleRefDragOver} onDrop={e=>handleRefDrop(e,i)}><img src={ref.blobUrl||ref.dataUrl} alt="" onError={onImgError} onClick={()=>setLightboxSrc(ref.blobUrl||ref.dataUrl)}/><button onClick={()=>{revokeUrl(ref.blobUrl);updateTask(activeIdx,{references:task.references.filter(r=>r.id!==ref.id)})}}>×</button><span className="thumb-idx">{i+1}</span></div>)}
            <button className="btn-secondary btn-sm" onClick={()=>{task.references.forEach(r=>revokeUrl(r.blobUrl));updateTask(activeIdx,{references:[]})}}>清空</button>
          </div>}
        </>}

        <button className="btn-primary" onClick={()=>generateOne(activeIdx)} disabled={taskIsGenerating}>
          {taskIsGenerating?<><div className="spinner"/>……{task.type==='edit'?'编辑中':'生成中'}</>:task.type==='edit'?'应用编辑':'生成'}
        </button>
        {tasks.length>1&&(()=>{
          const ready=tasks.filter(t=>(t.prompt||'').trim()&&!generatingIds.has(t.id)).length
          const total=tasks.length
          return <div className="batch-bar">
            <button className="btn-secondary" onClick={generateAll} disabled={isGenerating||ready===0} style={{flex:1}}>
              ▸ 全部生成 ({ready === total ? ready : `${ready}/${total}`})
            </button>
            <div className="batch-conc">
              <span className="mono">并发</span>
              <input type="number" min="1" max="5" value={concurrency} onChange={e=>setConcurrency(Math.max(1,Math.min(5,+e.target.value)))}/>
            </div>
          </div>
        })()}
      </div>

      <div className="card result-card">
        <div className="card-title">结果</div>
        <div className="result-preview">
          {displaySrc?<><img src={displaySrc} alt="" onError={onImgError} onClick={()=>setLightboxSrc(displaySrc)} style={{cursor:'zoom-in'}}/>{task.partialSrc&&!task.result?.src&&<div className="partial-overlay">……生成中……</div>}</>
          :task.result?.status==='error'?<div className="result-empty"><div className="board-icon">[;v;]</div><p style={{color:'var(--danger)'}}>{task.result.error}</p></div>
          :<div className="result-empty"><div className="board-icon">[?_?]</div><p>……结果——会显示在这里。<br/>Ctrl+Enter——快速提交。</p></div>}
        </div>

        {task.result?.src&&<div className="result-actions">
          <button className="btn-secondary" onClick={()=>dl(task.result.src)}>↓ 下载</button>
          <button className="btn-secondary" onClick={()=>cpImage(task.result.src)}>📋 复制图片</button>
          <button className="btn-secondary" onClick={()=>cpText(task.result.src)} title="复制 base64 文本">⎘ base64</button>
          <a className="btn-secondary" href={task.result.src} target="_blank" rel="noopener noreferrer" style={{textDecoration:'none',textAlign:'center'}}>↗</a>
          {task.type!=='edit'&&<button className="btn-secondary" style={{color:'var(--accent)'}} onClick={()=>startMaskEdit(task.result.src)}>✎ 区域编辑</button>}
        </div>}

        {task.result?.fallback&&!taskIsGenerating&&<div className={`fallback-bar ${task.result.fullRes?'fallback-ok':''}`}>
          <span>{task.result.fullRes?'ℹ 连接提前断开——图像分辨率匹配，通常与最终结果差异很小。':'⚠ 流式传输中断——当前显示的是预览图，可能不是最终质量。'}</span>
          <button className="btn-secondary btn-sm" onClick={()=>retryNoStream(activeIdx)} disabled={taskIsGenerating}>关闭流式重试</button>
        </div>}

        {task.result?.status==='error'&&!taskIsGenerating&&!task.retry?.active&&<div className="retry-bar">
          <button className="btn-secondary" onClick={()=>generateOne(activeIdx)}>重试一次</button>
          <button className="btn-secondary" onClick={()=>retryUntilSuccess(activeIdx,100)}>自动重试（最多100次）</button>
        </div>}

        {task.retry?.active&&<div className="retry-bar retry-active">
          <span className="mono">第 {task.retry.attempt}/{task.retry.max} 次</span>
          <div className="retry-progress"><div className="retry-fill" style={{width:`${(task.retry.attempt/task.retry.max)*100}%`}}/></div>
          <button className="btn-secondary btn-sm" onClick={()=>cancelRetry(task.id)}>取消</button>
        </div>}

        {status.text&&<div className={`status-bar ${status.type==='error'?'error':''} ${status.type==='success'?'success':''}`}><span className={`status-dot ${status.type}`}/>{status.text}</div>}

        {task.result?.summary&&<details className="response-details"><summary>▸ 响应详情</summary><pre>{JSON.stringify(task.result.summary,null,2)}</pre></details>}

        {task.debugLog?.length>0&&<details className="response-details"><summary>▸ Debug Log ({task.debugLog.length} entries)</summary><pre style={{maxHeight:400}}>{JSON.stringify(task.debugLog,null,2)}</pre><button className="btn-text" onClick={()=>{navigator.clipboard.writeText(JSON.stringify(task.debugLog,null,2));showToast('……debug log——已复制。')}}>复制 debug log</button></details>}

        {tasks.filter(t=>t.result?.src).length>1&&<div className="overview-section"><div className="card-title" style={{marginTop:16}}>全部结果</div><div className="batch-grid">
          {tasks.map((t,i)=>t.result?.src?<div key={t.id} className={`batch-cell done ${i===activeIdx?'active-cell':''}`} onClick={()=>setActiveIdx(i)}><img src={t.result.src} alt="" onError={onImgError}/><div className="batch-prompt">#{i+1} {(t.prompt||'').slice(0,30)}</div></div>:null)}
        </div></div>}

        <div className="history-section">
          <button className="settings-toggle" onClick={()=>setHistoryOpen(!historyOpen)} style={{marginTop:12}}>
            <span className={`chevron ${historyOpen?'open':''}`}>▸</span>
            历史记录 <span className="mono" style={{fontSize:11,color:'var(--text-muted)'}}>({history.length}/{MAX_HISTORY})</span>
          </button>
          {historyOpen&&<>
            {history.length>0?<div className="history-grid">
              {history.map(h=><div key={h.id} className="history-item" onClick={()=>loadFromHistory(h)}>
                <img src={h.displayUrl} alt="" loading="lazy" onError={onImgError}/>
                <div className="history-meta">
                  <span>{(h.prompt||'').slice(0,25)||'无提示词'}</span>
                  <span className="mono">{h.params?.size||'auto'}</span>
                  <span className="mono">{new Date(h.ts).toLocaleDateString()}</span>
                </div>
                <button className="history-del" onClick={e=>{e.stopPropagation();historyDelete(h.id).then(reloadHistory)}} title="删除">×</button>
              </div>)}
            </div>:<p style={{fontSize:12,color:'var(--text-muted)',padding:'8px 0'}}>……还没有历史记录。</p>}
            {history.length>0&&<button className="btn-text" style={{color:'var(--danger)'}} onClick={()=>{if(confirm('……确定要清除所有历史记录吗？'))historyClear().then(reloadHistory)}}>清除全部历史</button>}
          </>}
        </div>
      </div>
    </div>

    {lightboxSrc&&<Lightbox src={lightboxSrc} onClose={()=>setLightboxSrc(null)}/>}

    {toasts.length>0&&<div className="toast-container">
      {toasts.map(t=><div key={t.id} className={`toast ${(t.text||'').startsWith('✗')?'toast-error':''}`}
        onClick={()=>{if(t.taskId!=null){const i=tasks.findIndex(x=>x.id===t.taskId);if(i>=0)setActiveIdx(i)};setToasts(prev=>prev.filter(x=>x.id!==t.id))}}>
        {t.text}
        {t.taskId!=null&&<span className="toast-jump">点击查看</span>}
      </div>)}
    </div>}
  </div>)
}
