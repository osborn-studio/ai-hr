// Provider signatures replace login only on this exact raw callback route.
import{withTx}from'./db.mjs';
import{receiveCallback}from'./services/integration-runtime.mjs';
export async function handleIntegrationCallback({req,res,url,db,readBody}){
 const match=/^\/api\/integrations\/callback\/([1-9][0-9]*)$/.exec(url.pathname);if(!match)return false;
 const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);};
 if(!['GET','POST'].includes(req.method)){res.setHeader('allow','GET, POST');send(405,{error:'E_CALLBACK_METHOD',message:'回调方法不受支持'});return true;}
 try{
  if(!(await db.query("SELECT to_regclass('public.ty_ix_profile')IS NOT NULL ok")).rows[0].ok){send(503,{error:'E_CALLBACK_NOT_READY',message:'集成回调尚未就绪'});return true;}
  const rawBody=await readBody(req,1024*1024);
  // Do not send success until nonce and the encrypted source have committed.
  const result=await withTx(db,t=>receiveCallback(t,{connectionId:match[1],rawBody,headers:req.headers,query:Object.fromEntries(url.searchParams),method:req.method}));
  if(result.ack===undefined)throw new Error('E_CALLBACK_ACK');
  if(typeof result.ack==='string')send(200,result.ack,'text/plain; charset=utf-8');else send(200,result.ack);
 }catch(error){send(error.code==='E_BODY_TOO_LARGE'?413:403,{error:error.code==='E_BODY_TOO_LARGE'?'E_BODY_TOO_LARGE':'E_CALLBACK_REJECTED',message:error.code==='E_BODY_TOO_LARGE'?'回调内容超过允许大小':'集成回调未通过核验'});}
 return true;
}
