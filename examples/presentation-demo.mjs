import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../dist/memory-store.js';
import { computeReceipt, toLean, SSEBus } from '../dist/readback.js';
const folder=mkdtempSync(join(tmpdir(),'mempeek-demo-'));
const store=new MemoryStore(join(folder,'memory.db'),'demo');
try {
  store.write({id:'deployment',ts:1,content:'deployment uses port 8080',session_id:'demo'});
  store.write({id:'format',ts:2,content:'format source files with prettier',session_id:'demo'});
  const entries=store.readback('deployment port',{topK:1,sessionId:'demo'}).entries;
  const receipt=computeReceipt(entries,{displayed:true,sideChannel:'local-demo'});
  const bus=new SSEBus();
  let delivered=[];
  const off=bus.subscribe(event=>{if(event.type==='recall')delivered=event.entries;});
  bus.emit({type:'recall',query:'deployment port',entries:entries.map(toLean),receipt,ts:3});
  off();
  console.log(JSON.stringify({model_receipt:receipt,side_channel_content:delivered.map(e=>e.content),receipt_contains_full_content:JSON.stringify(receipt).includes(entries[0].content)},null,2));
} finally {store.close();rmSync(folder,{recursive:true,force:true});}
