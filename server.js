const http=require('http');
const https=require('https');
const fs=require('fs');
const path=require('path');
const PORT=process.env.PORT||3000;
const HOST='www.sofascore.com';

function requestJSON(p){
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:HOST,path:p,method:'GET',headers:{
      'User-Agent':'Mozilla/5.0','Accept':'application/json,text/plain,*/*',
      'Referer':'https://www.sofascore.com/'
    }},res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300)return reject(new Error('SofaScore HTTP '+res.statusCode));
        try{resolve(JSON.parse(d))}catch(e){reject(new Error('Resposta não-JSON do SofaScore'))}
      });
    });
    req.on('error',reject); req.setTimeout(10000,()=>req.destroy(new Error('Timeout')));
  });
}
function idFrom(s){
  const x=String(s||'').trim();
  if(/^\d{5,}$/.test(x)) return x;
  let m=x.match(/#id:(\d{5,})/); if(m)return m[1];
  m=x.match(/(?:event|match)[^#?]*?(\d{5,})(?:[#?]|$)/i); if(m)return m[1];
  m=x.match(/\b(\d{6,})\b/); return m?m[1]:null;
}
const endpoints={
  event:id=>`/api/v1/event/${id}`,
  stats:id=>`/api/v1/event/${id}/statistics`,
  incidents:id=>`/api/v1/event/${id}/incidents`,
  lineups:id=>`/api/v1/event/${id}/lineups`,
  graph:id=>`/api/v1/event/${id}/graph`,
  momentum:id=>`/api/v1/event/${id}/momentum`
};
async function api(id){
  const out={};
  for(const [k,fn] of Object.entries(endpoints)){
    try{out[k]=await requestJSON(fn(id))}catch(e){out[k]={error:e.message}}
  }
  return out;
}
const html=fs.readFileSync(path.join(__dirname,'public','index.html'));
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/api/match')){
      const u=new URL(req.url,'http://localhost'); const id=idFrom(u.searchParams.get('id')||u.searchParams.get('url'));
      if(!id){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'ID da partida não encontrado'}))}
      const data=await api(id); res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); return res.end(JSON.stringify({id,data}));
    }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
  }catch(e){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
});
server.listen(PORT,()=>console.log('Live Match Stats V2 on '+PORT));
