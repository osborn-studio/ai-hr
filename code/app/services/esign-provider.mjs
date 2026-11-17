import{createHash,createHmac}from'node:crypto';
const HOSTS={sandbox:'https://smlopenapi.esign.cn',production:'https://openapi.esign.cn'};
const OSS={sandbox:['esignoss.esign.cn'],production:['oss.esign.cn']};
const fail=(code='E_ESIGN_PROTOCOL')=>{throw Object.assign(Error('电子签协议核验未通过，请核对已登记的外部事实。'),{code});};
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export const md5=b=>createHash('md5').update(b).digest('base64');
export function requestSignature({method,path,body='',appId,appSecret,timestamp=Date.now()}){
 if(!/^\/v3\/[A-Za-z0-9/_-]+$/.test(path)||!['GET','POST'].includes(method))fail();
 const contentType='application/json',contentMd5=body?md5(Buffer.from(body)):'';
 const canonical=[method,'*/*',contentMd5,contentType,'',path].join('\n');
 return{'X-Tsign-Open-App-Id':appId,'X-Tsign-Open-Auth-Mode':'Signature','X-Tsign-Open-Ca-Timestamp':String(timestamp),Accept:'*/*','Content-Type':contentType,'Content-MD5':contentMd5,'X-Tsign-Open-Ca-Signature':createHmac('sha256',appSecret).update(canonical).digest('base64')};
}
async function bounded(response,max){const out=[];let size=0;for await(const b of response.body||[]){size+=b.length;if(size>max)fail();out.push(b);}return Buffer.concat(out);}
export function esignClient({environment,credentials,fetchImpl=fetch}){
 const host=HOSTS[environment];if(!host||!credentials?.app_id||!credentials?.app_secret)fail('E_ESIGN_NOT_CONFIGURED');
 const invoke=async(method,path,input)=>{const body=input===undefined?'':JSON.stringify(input),headers=requestSignature({method,path,body,appId:credentials.app_id,appSecret:credentials.app_secret});let res;
  try{res=await fetchImpl(host+path,{method,headers,...(body?{body}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{fail('E_ESIGN_REMOTE_UNKNOWN');}
  if(!res.ok){if(res.status>=500||res.status===408||res.status===429)fail('E_ESIGN_REMOTE_UNKNOWN');fail();}
  let result;try{result=JSON.parse((await bounded(res,2*1024*1024)).toString());}catch{fail();}if(result?.code!==0)fail('E_ESIGN_PROVIDER_REJECTED');return result.data;
 };
 const assetUrl=value=>{let u;try{u=new URL(value);}catch{fail();}if(u.protocol!=='https:'||u.port&&u.port!=='443'||!OSS[environment].includes(u.hostname)||u.username||u.password||u.hash)fail('E_ESIGN_ASSET_HOST');return u.href;};
 const transfer=async(url,{method='GET',bytes}={})=>{const target=assetUrl(url);let res;try{res=await fetchImpl(target,{method,redirect:'manual',signal:AbortSignal.timeout(20000),...(bytes?{headers:{'Content-Type':'application/pdf','Content-MD5':md5(bytes)},body:bytes}:{})});}catch{fail('E_ESIGN_REMOTE_UNKNOWN');}if(!res.ok)fail(res.status>=500?'E_ESIGN_REMOTE_UNKNOWN':'E_ESIGN_ASSET');return bytes?null:bounded(res,8*1024*1024);};
 return{invoke,transfer,allocate:bytes=>invoke('POST','/v3/files/file-upload-url',{contentMd5:md5(bytes.content),contentType:'application/pdf',fileName:bytes.name,fileSize:bytes.content.length,convertToPDF:false}),file:id=>invoke('GET','/v3/files/'+externalId(id)),create:input=>invoke('POST','/v3/sign-flow/create-by-file',input),start:id=>invoke('POST','/v3/sign-flow/'+externalId(id)+'/start'),detail:id=>invoke('GET','/v3/sign-flow/'+externalId(id)+'/detail'),download:id=>invoke('POST','/v3/sign-flow/'+externalId(id)+'/file-download-url',{urlAvailableDate:60}),verify:(flow,file)=>invoke('POST','/v3/files/'+externalId(file)+'/verify',{signFlowId:flow,async:false}),evidence:id=>invoke('POST','/v3/antchain-file-info',{signFlowId:id})};
}
export function externalId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(value))fail();return value;}
export function createFlowPayload({intent,fileId,person,organization}){
 const field=(suffix,pos)=>({fileId,customBizNum:intent.intent_key+':'+suffix,signFieldType:0,mustSign:true,normalSignFieldConfig:{autoSign:false,freeMode:false,movableSignField:false,signFieldSize:pos.size,signFieldStyle:1,signFieldPosition:{positionPage:String(pos.page),positionX:pos.x,positionY:pos.y}}});
 return{docs:[{fileId,fileName:intent.filename,contractNo:intent.contract_code}],signFlowConfig:{signFlowTitle:intent.flow_title,autoStart:false,autoFinish:true,identityVerify:true,signConfig:{availableSignClientTypes:'1'},noticeConfig:{noticeTypes:''}},signers:[{signerType:0,psnSignerInfo:{psnId:person.external_id},noticeConfig:{noticeTypes:''},signFields:[field('employee',intent.positions.employee)]},{signerType:1,orgSignerInfo:{orgId:organization.external_id,transactorInfo:{psnId:organization.transactor_id}},noticeConfig:{noticeTypes:''},signFields:[field('employer',intent.positions.employer)]}]};
}
export function verifyFlow(detail,{intent,person,organization,completed=false}){
 if(!detail||detail.signFlowConfig?.signFlowTitle!==intent.flow_title||detail.signFlowConfig?.autoFinish!==true||detail.docs?.length!==1||detail.docs[0].fileId!==intent.remote_file_id||detail.signers?.length!==2||![0,1,2,3,5,7].includes(detail.signFlowStatus))fail('E_ESIGN_FLOW_MISMATCH');
 const psn=detail.signers.find(s=>s.signerType===0),org=detail.signers.find(s=>s.signerType===1);
 if(psn?.psnSigner?.psnId!==person.external_id||org?.orgSigner?.orgId!==organization.external_id||org.orgSigner.transactor?.psnId!==organization.transactor_id)fail('E_ESIGN_PARTY_MISMATCH');
 for(const[s,suffix]of[[psn,'employee'],[org,'employer']]){if(s.signFields?.length!==1)fail();const f=s.signFields[0],p=intent.positions[suffix];if(f.fileId!==intent.remote_file_id||f.customBizNum!==intent.intent_key+':'+suffix||f.normalSignFieldConfig?.autoSign!==false||f.normalSignFieldConfig?.freeMode!==false||f.normalSignFieldConfig?.movableSignField!==false||String(f.normalSignFieldConfig?.signFieldPosition?.positionPage)!==String(p.page)||Number(f.normalSignFieldConfig?.signFieldPosition?.positionX)!==p.x||Number(f.normalSignFieldConfig?.signFieldPosition?.positionY)!==p.y)fail('E_ESIGN_FIELDS_MISMATCH');if(completed&&s.signStatus!==2)fail('E_ESIGN_INCOMPLETE');}
 if(completed&&(detail.signFlowStatus!==2||!Number.isSafeInteger(detail.signFlowFinishTime)||detail.signFlowFinishTime>Date.now()+60000||detail.rescissionStatus!==0))fail('E_ESIGN_INCOMPLETE');return detail.signFlowStatus;
}
export function verifiedEvidence({bytes,download,evidence,verification,intent}){
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||download.files?.length!==1||download.files[0].fileId!==intent.remote_file_id)fail('E_ESIGN_FILE_MISMATCH');
 const entries=evidence.antchainFiles;if(entries?.length!==1||entries[0].fileId!==intent.remote_file_id||entries[0].fileHash?.toLowerCase()!==sha256(bytes)||!entries[0].antTxHash||!entries[0].antTransactionId)fail('E_ESIGN_HASH_MISMATCH');
 if(verification.verifyTaskId||!Array.isArray(verification.signInfos)||verification.signInfos.length<2||verification.signInfos.some(s=>s.signature?.modify!==false||!s.cert?.certOwner||!s.cert?.certSN||!s.signature?.signTime))fail('E_ESIGN_SIGNATURE_INVALID');
 return{sha256:sha256(bytes),evidence_number:entries[0].antTxHash,transaction_id:entries[0].antTransactionId,signature_count:verification.signInfos.length,provider_verification:'valid_unmodified',cryptographic_proof:'provider_report',local_pdf_verifier:false};
}
