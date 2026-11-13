import http from "node:http";
import { URL } from "node:url";
import { createDecipheriv } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const BASE = "https://huangguoai.com";
const MEDIA_HOSTS = new Set(["huangguoai.com","huangguoai.ai","pic.drleao.cn","yd-hls.hzjvlo.cn","yd-lphu-hls.hzjvlo.cn","tp3.drleao.cn"]);
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".json":"application/json",".webmanifest":"application/manifest+json",".png":"image/png",".ico":"image/x-icon"};

function send(res,status,body,type="application/json; charset=utf-8",headers={}) {
  res.writeHead(status,{"Content-Type":type,"X-Content-Type-Options":"nosniff","Cache-Control":"no-store",...headers}); res.end(body);
}
function json(res,status,value) { send(res,status,JSON.stringify(value)); }
function parseMedia(raw) {
  let u; try { u=new URL(raw); } catch { throw new Error("媒体地址无效"); }
  if(u.protocol!=="https:" || u.username || u.password || !MEDIA_HOSTS.has(u.hostname.toLowerCase())) throw new Error("媒体地址不在允许的来源范围");
  return u;
}
async function upstreamBytes(raw,range) {
  let u=parseMedia(raw);
  for(let hop=0;hop<=4;hop++) {
    const headers={"User-Agent":"Mozilla/5.0 HGhub-PWA","Referer":BASE+"/"}; if(range) headers.Range=range;
    const response=await fetch(u,{headers,redirect:"manual",signal:AbortSignal.timeout(25000)});
    if([301,302,303,307,308].includes(response.status)) {
      const loc=response.headers.get("location"); if(!loc || hop===4) throw new Error("媒体重定向无效");
      u=parseMedia(new URL(loc,u).href); continue;
    }
    if(!response.ok && response.status!==206) throw new Error("媒体源返回 HTTP "+response.status);
    return response;
  }
  throw new Error("媒体重定向次数超限");
}
async function edge(method,path,body) {
  if(!path.startsWith("/api/") || path.includes("..")) throw new Error("接口路径无效");
  const envelope={method,path,body:body==null?"":Buffer.from(JSON.stringify(body)).toString("base64"),content_type:body==null?"":"application/json"};
  const response=await fetch(BASE+"/api/edge/request",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json","Referer":BASE+"/"},body:JSON.stringify(envelope),redirect:"manual",signal:AbortSignal.timeout(18000)});
  if(response.status>=300 && response.status<400) throw new Error("业务接口重定向已拒绝");
  const text=await response.text(); if(!response.ok) throw new Error("上游接口 HTTP "+response.status);
  let data; try { data=JSON.parse(text); } catch { throw new Error("上游接口返回格式错误"); }
  if(data==null) return null;
  if(data.status===1) return data.data??null;
  throw new Error(typeof data.msg==="string"?data.msg:"接口返回失败");
}
function int(v,fallback,min=1,max=100) { const n=Number(v); return Number.isInteger(n)?Math.max(min,Math.min(max,n)):fallback; }
function normalizePlay(info) {
  if(!info || typeof info!=="object") return info;
  if(!info.video_url && info.streams?.main) info.video_url=info.streams.main;
  if(!info.video_url_hevc && info.streams?.hevc) info.video_url_hevc=info.streams.hevc;
  return info;
}
async function apiRoute(path,q) {
  switch(path) {
    case "/api/feed": return edge("GET","/api/videos?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/posts": return edge("GET","/api/posts?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/rank": { const kind=["hot","recommend","potential"].includes(q.get("kind"))?q.get("kind"):"hot"; return edge("GET","/api/ranks/"+kind); }
    case "/api/search": return edge("GET","/api/search?q="+encodeURIComponent(String(q.get("q")||"").slice(0,100))+"&page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/category": {
      const cate=String(q.get("cate")||""); if(!/^[\p{L}\p{N}_-]{1,40}$/u.test(cate)) throw new Error("分类参数无效");
      return edge("GET","/api/videos/category/"+encodeURIComponent(cate)+"?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    }
    case "/api/video": return edge("GET","/api/videos/"+int(q.get("id"),0,1,2147483647));
    case "/api/post": return edge("GET","/api/posts/"+int(q.get("id"),0,1,2147483647));
    case "/api/comments": return edge("GET","/api/videos/"+int(q.get("id"),0,1,2147483647)+"/comments?ep="+int(q.get("ep"),1)+"&page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/post-comments": return edge("GET","/api/posts/"+int(q.get("id"),0,1,2147483647)+"/comments?page="+int(q.get("page"),1)+"&size="+int(q.get("size"),20,1,50));
    case "/api/play": {
      const id=int(q.get("id"),0,1,2147483647), ep=int(q.get("ep"),1); let primary, primaryError;
      try { primary=await edge("POST","/api/videos/"+id+"/episodes/"+ep+"/playback",{}); } catch(e) { primaryError=e; }
      if(primary && (primary.streams?.main || primary.video_url)) return normalizePlay(primary);
      try { const legacy=normalizePlay(await edge("GET","/api/videos/"+id+"/play?ep="+ep+"&page_texts=0")); if(legacy.video_url || !primary) return legacy; } catch {}
      if(primary) return normalizePlay(primary); throw primaryError || new Error("暂无可播放线路");
    }
    default: throw new Error("游客模式不支持此操作");
  }
}
function decryptImage(input) {
  if(input.length<16 || input.length%16) return input;
  try { const d=createDecipheriv("aes-128-cbc",Buffer.from("f5d965df75336270"),Buffer.from("97b60394abc2fbe1")); return Buffer.concat([d.update(input),d.final()]); }
  catch { return input; }
}
function proxyUrl(target,route) { return route+"?u="+encodeURIComponent(target); }
function rewritePlaylist(target,text) {
  const base=new URL(target);
  return text.replace(/^\uFEFF/,"").split(/\r?\n/).map(line=>{
    const s=line.trimEnd(); if(!s) return "";
    if(s.startsWith("#EXT-X-CONTENT-STEERING:")) return "";
    if(s.startsWith("#EXT-X-DATERANGE:")) return s.replace(/,(?:X-ASSET-LIST|[^,]*URI)="[^"]*"/gi,"");
    if(s.startsWith("#")) return s.replace(/URI="([^"]+)"/g,(_m,u)=>'URI="'+proxyUrl(new URL(u,base).href,"/seg")+'"');
    return proxyUrl(new URL(s,base).href,"/seg");
  }).join("\n")+"\n";
}
async function media(req,res,url,route) {
  const response=await upstreamBytes(url,req.headers.range); const bytes=Buffer.from(await response.arrayBuffer());
  if(route==="img") {
    let plain=bytes; if(!/^image\/(jpeg|png|gif|webp)/i.test(response.headers.get("content-type")||"")) plain=decryptImage(bytes);
    let type="image/jpeg";
    if(plain[0]===0x89 && plain.toString("ascii",1,4)==="PNG") type="image/png";
    else if(plain.subarray(0,4).toString()==="GIF8") type="image/gif";
    else if(plain.subarray(0,2).toString("hex")==="ffd8") type="image/jpeg";
    else if(plain.subarray(0,4).toString()==="RIFF" && plain.subarray(8,12).toString()==="WEBP") type="image/webp";
    else if((response.headers.get("content-type")||"").startsWith("image/")) type=response.headers.get("content-type");
    return send(res,200,plain,type,{"Cache-Control":"public, max-age=86400"});
  }
  const type=response.headers.get("content-type")||"application/octet-stream";
  if(route==="hls" || type.toLowerCase().includes("mpegurl") || bytes.subarray(0,7).toString()==="#EXTM3U") {
    const txt=bytes.toString("utf8"); if(!txt.trimStart().startsWith("#EXTM3U")) throw new Error("响应不是 HLS 播放列表");
    return send(res,200,rewritePlaylist(url,txt),"application/vnd.apple.mpegurl",{"Cache-Control":"no-store"});
  }
  const headers={"Cache-Control":"public, max-age=3600","Accept-Ranges":"bytes"};
  for(const k of ["content-range","content-length"]) if(response.headers.has(k)) headers[k]=response.headers.get(k);
  return send(res,response.status,bytes,type,headers);
}
async function serveStatic(req,res,url) {
  let pathname=decodeURIComponent(url.pathname); if(pathname==="/" || !extname(pathname)) pathname="/index.html";
  const root=join(process.cwd(),"dist"), file=normalize(join(root,pathname));
  if(!file.startsWith(root)) return send(res,403,"forbidden","text/plain");
  try { const info=await stat(file); if(!info.isFile()) throw new Error("not file");
    send(res,200,await readFile(file),MIME[extname(file)]||"application/octet-stream",{"Cache-Control":pathname==="/index.html"?"no-cache":"public, max-age=31536000, immutable"});
  } catch { send(res,404,"not found","text/plain"); }
}
http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  try {
    if(req.method==="GET" && url.pathname==="/health") return json(res,200,{ok:true});
    if(req.method==="GET" && ["/img","/hls","/seg"].includes(url.pathname)) { const u=url.searchParams.get("u"); if(!u) return send(res,400,"missing u","text/plain"); return await media(req,res,u,url.pathname.slice(1)); }
    if(req.method==="GET" && url.pathname.startsWith("/api/")) return json(res,200,await apiRoute(url.pathname,url.searchParams));
    if(req.method==="GET") return await serveStatic(req,res,url);
    return send(res,405,"method not allowed","text/plain",{"Allow":"GET"});
  } catch(e) { return json(res,502,{error:String(e?.message||"request failed").slice(0,180)}); }
}).listen(PORT,"0.0.0.0",()=>console.log("HGhub PWA server listening on "+PORT));
