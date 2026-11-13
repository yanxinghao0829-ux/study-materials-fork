const BASE = "https://huangguoai.com";
const MEDIA_HOSTS = new Set(["huangguoai.com","huangguoai.ai","pic.drleao.cn","yd-hls.hzjvlo.cn","yd-lphu-hls.hzjvlo.cn","tp3.drleao.cn"]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CORS = {"X-Content-Type-Options":"nosniff"};
const json = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...CORS,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
const fail = (message,status=502)=>json({error:String(message).slice(0,180)},status);
const int = (v,fallback,min=1,max=100)=>{const n=Number(v);return Number.isInteger(n)?Math.max(min,Math.min(max,n)):fallback;};
function mediaUrl(raw) {
  const u=new URL(raw);
  if(u.protocol!=="https:" || u.username || u.password || u.port && u.port!=="443" || !MEDIA_HOSTS.has(u.hostname.toLowerCase())) throw new Error("媒体地址不在允许的来源范围");
  return u;
}
async function upstream(raw,range) {
  let u=mediaUrl(raw);
  for(let hop=0;hop<=4;hop++){
    const h={"User-Agent":UA,"Referer":BASE+"/"};
    if(range) h.Range=range;
    const r=await fetch(u.href,{headers:h,redirect:"manual",signal:AbortSignal.timeout(25000)});
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get("location");
      if(!loc || hop===4) throw new Error("媒体重定向无效");
      u=mediaUrl(new URL(loc,u).href); continue;
    }
    if(!r.ok && r.status!==206) throw new Error("媒体源返回 HTTP "+r.status);
    return r;
  }
  throw new Error("媒体重定向次数超限");
}
async function edge(method,path,body){
  if(!path.startsWith("/api/") || path.includes("..")) throw new Error("接口路径无效");
  const envelope={method,path,body:body==null?"":btoa(unescape(encodeURIComponent(JSON.stringify(body)))),content_type:body==null?"":"application/json"};
  const r=await fetch(BASE+"/api/edge/request",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json","Referer":BASE+"/","User-Agent":UA},body:JSON.stringify(envelope),redirect:"manual",signal:AbortSignal.timeout(18000)});
  if(r.status>=300 && r.status<400) throw new Error("业务接口重定向已拒绝");
  const raw=await r.text();
  if(!r.ok) { const hint=raw.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,220); throw new Error("上游接口 HTTP "+r.status+(hint?": "+hint:"")); }
  let data; try { data=raw?JSON.parse(raw):null; } catch { throw new Error("上游接口返回非 JSON: "+raw.slice(0,120)); }
  if(data==null) return null;
  if(data.status===1) return data.data??null;
  throw new Error(typeof data.msg==="string"?data.msg:"接口返回失败");
}
function streamValue(v){
  if(typeof v==="string") return v;
  if(v && typeof v==="object") {
    for(const k of ["url","src","play_url","video_url","m3u8"]) if(typeof v[k]==="string" && v[k]) return v[k];
  }
  return "";
}
function playInfo(info){
  if(!info || typeof info!=="object") return info;
  if(!info.video_url) info.video_url=streamValue(info.streams?.main)||streamValue(info.main)||streamValue(info.play_url);
  if(!info.video_url_hevc) info.video_url_hevc=streamValue(info.streams?.hevc);
  return info;
}
async function api(path,q){
  switch(path){
    case "/api/feed": return edge("GET","/api/videos?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/posts": return edge("GET","/api/posts?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/rank": {const k=["hot","recommend","potential"].includes(q.get("kind"))?q.get("kind"):"hot";return edge("GET","/api/ranks/"+k);}
    case "/api/search": return edge("GET","/api/search?q="+encodeURIComponent(String(q.get("q")||"").slice(0,100))+"&page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/category": {const c=String(q.get("cate")||"");if(!/^[\p{L}\p{N}_-]{1,40}$/u.test(c))throw new Error("分类参数无效");return edge("GET","/api/videos/category/"+encodeURIComponent(c)+"?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));}
    case "/api/video": return edge("GET","/api/videos/"+int(q.get("id"),0,1,2147483647));
    case "/api/post": return edge("GET","/api/posts/"+int(q.get("id"),0,1,2147483647));
    case "/api/comments": return edge("GET","/api/videos/"+int(q.get("id"),0,1,2147483647)+"/comments?ep="+int(q.get("ep"),1)+"&page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/post-comments": return edge("GET","/api/posts/"+int(q.get("id"),0,1,2147483647)+"/comments?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/play": {const id=int(q.get("id"),0,1,2147483647),ep=int(q.get("ep"),1);let p,postError="",getError="";try{p=playInfo(await edge("POST","/api/videos/"+id+"/episodes/"+ep+"/playback",{}));}catch(x){postError=x?.message||String(x);}if(p?.video_url)return p;try{const old=playInfo(await edge("GET","/api/videos/"+id+"/play?ep="+ep+"&page_texts=0"));if(old?.video_url)return old;}catch(x){getError=x?.message||String(x);}const detail=[postError&&("POST: "+postError),getError&&("GET: "+getError)].filter(Boolean).join(" | ");throw new Error(detail||"播放接口未返回 streams.main / video_url");}
    default: throw new Error("游客模式不支持此操作");
  }
}
function proxy(u,route="/seg"){return route+"?u="+encodeURIComponent(u);}
function rewritePlaylist(target,txt){
  const base=new URL(target);
  return txt.replace(/^\uFEFF/,"").split(/\r?\n/).map(line=>{
    const s=line.trimEnd();if(!s)return "";
    if(s.startsWith("#EXT-X-CONTENT-STEERING:"))return "";
    if(s.startsWith("#EXT-X-DATERANGE:"))return s.replace(/,(?:X-ASSET-LIST|[^,]*URI)="[^"]*"/gi,"");
    if(s.startsWith("#"))return s.replace(/URI="([^"]+)"/g,(_m,u)=>'URI="'+proxy(new URL(u,base).href)+'"');
    return proxy(new URL(s,base).href);
  }).join("\n")+"\n";
}
async function imageBytes(buf){
  if(buf.byteLength<16 || buf.byteLength%16) return buf;
  try{
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("f5d965df75336270"),{name:"AES-CBC"},false,["decrypt"]);
    return await crypto.subtle.decrypt({name:"AES-CBC",iv:new TextEncoder().encode("97b60394abc2fbe1")},key,buf);
  }catch{return buf;}
}
function imageType(b,original){
  const a=new Uint8Array(b);
  if(a[0]===0x89 && a[1]===0x50 && a[2]===0x4e && a[3]===0x47)return "image/png";
  if(a[0]===0x47 && a[1]===0x49 && a[2]===0x46)return "image/gif";
  if(a[0]===0xff && a[1]===0xd8)return "image/jpeg";
  if(a[0]===0x52 && a[1]===0x49 && a[2]===0x46 && a[8]===0x57)return "image/webp";
  return original.startsWith("image/")?original:"image/jpeg";
}
async function media(req,url,route){
  const target=url.searchParams.get("u");if(!target)return new Response("missing u",{status:400});
  const r=await upstream(target,req.headers.get("Range"));
  const b=await r.arrayBuffer(),type=r.headers.get("content-type")||"application/octet-stream";
  if(route==="/img"){
    const plain=/^image\/(jpeg|png|gif|webp)/i.test(type)?b:await imageBytes(b);
    return new Response(plain,{headers:{...CORS,"Content-Type":imageType(plain,type),"Cache-Control":"public, max-age=86400"}});
  }
  if(route==="/hls" || type.toLowerCase().includes("mpegurl") || new TextDecoder().decode(b.slice(0,7))==="#EXTM3U"){
    const txt=new TextDecoder().decode(b);if(!txt.trimStart().startsWith("#EXTM3U"))throw new Error("响应不是 HLS 播放列表");
    return new Response(rewritePlaylist(target,txt),{headers:{...CORS,"Content-Type":"application/vnd.apple.mpegurl","Cache-Control":"no-store"}});
  }
  const h=new Headers({...CORS,"Content-Type":type,"Cache-Control":"public, max-age=3600","Accept-Ranges":"bytes"});
  for(const k of ["content-range","content-length"])if(r.headers.has(k))h.set(k,r.headers.get(k));
  return new Response(b,{status:r.status,headers:h});
}
export default {
 async fetch(req,env){
  const u=new URL(req.url);
  if(req.method!=="GET")return new Response("method not allowed",{status:405,headers:{Allow:"GET"}});
  try{
   if(u.pathname==="/health")return json({ok:true});
   if(["/img","/hls","/seg"].includes(u.pathname))return await media(req,u,u.pathname);
   if(u.pathname.startsWith("/api/"))return json(await api(u.pathname,u.searchParams));
   return env.ASSETS.fetch(req);
  }catch(e){return fail(e?.message||"request failed");}
 }
};
