import {readFileSync} from "node:fs";
import {expandedKeywordPayload} from "@/lib/market/keyword-expansion";
interface Candidate {repoId:string;appId:string;activeRevision:number;latestRevision:number;payload:unknown;publicConfirmed:boolean;terms:string[];}
async function main(){
 const file=process.argv[2];if(!file)throw Error('CANDIDATE_FILE_REQUIRED');
 const token=process.env.INTERNAL_ADMIN_TOKEN;if(!token)throw Error('REGISTERED_OPERATOR_TOKEN_REQUIRED');
 const headers={"content-type":"application/json","authorization":`Bearer ${token}`,"x-seori-principal":"backoffice:fleet-operator"};
 async function post(path:string,body:unknown,key:string){const response=await fetch(`https://backoffice.vzyx.xyz/api/control-plane/config-revisions${path}`,{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});const result=await response.json();if(!response.ok)throw Error(`CONTROL_PLANE_${response.status}:${result.code??'FAILED'}`);return result;}
 for(const candidate of JSON.parse(readFileSync(file,'utf8')) as Candidate[]){
  const expanded=expandedKeywordPayload(candidate);
  if(expanded.status!=='ready'){console.log(JSON.stringify({appId:candidate.appId,status:expanded.status}));continue;}
  try{
   const prefix=`keyword-expansion-540:${candidate.appId}:${candidate.activeRevision}`;
   const created=await post('',{repoId:candidate.repoId,expectedLatestRevision:candidate.latestRevision,payload:expanded.payload},prefix+':create');
   const active=await post('/activate',{repoId:candidate.repoId,revision:created.revision,expectedActiveRevision:candidate.activeRevision},prefix+':activate');
   console.log(JSON.stringify({appId:candidate.appId,status:active.status,revision:active.revision}));
  }catch(error){console.log(JSON.stringify({appId:candidate.appId,status:'needs_input',reason:String(error)}));}
 }
}
main().catch(error=>{console.error(String(error));process.exitCode=1});
