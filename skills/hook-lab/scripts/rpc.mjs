/** Bounded, read-only JSON-RPC transport. Endpoint values never enter reports. */
const METHODS = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
  'eth_getCode','eth_getStorageAt','eth_call','eth_getBalance','eth_getTransactionCount',
  'eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','debug_traceCall']);
export function makeRpc(endpoint, {timeoutMs=12000,maxBytes=4*1024*1024,fetchImpl=fetch}={}) {
  let url; try { url=new URL(endpoint); } catch { throw new Error('Invalid RPC endpoint'); }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash) throw new Error('Unsupported RPC endpoint');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024) throw new Error('Invalid transport bounds');
  let id=0;
  return async (method,params=[])=>{
    if(!METHODS.has(method)) throw new Error('RPC method is outside the read-only allowlist');
    if(!Array.isArray(params)||JSON.stringify(params).length>262144) throw new Error('Invalid or oversized RPC params');
    const requestId=++id, controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),signal:controller.signal});
      if(!response.ok) throw new Error('RPC HTTP '+response.status);
      let size=0; const chunks=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes){controller.abort();throw new Error('RPC response exceeded byte limit');}chunks.push(Buffer.from(chunk));}
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('RPC returned invalid JSON');}
      if(value?.jsonrpc!=='2.0'||value.id!==requestId||Object.hasOwn(value,'result')===Object.hasOwn(value,'error'))throw new Error('Invalid RPC envelope');
      if(value.error){const e=new Error('RPC error '+(Number.isInteger(value.error.code)?value.error.code:'unknown'));e.code=Number.isInteger(value.error.code)?value.error.code:null;
        // Hex revert data is useful; provider prose can contain endpoint credentials.
        if(typeof value.error.data==='string'&&/^0x(?:[0-9a-fA-F]{2}){0,32768}$/.test(value.error.data))e.data=value.error.data;
        throw e;}
      return value.result;
    } catch(e) {
      if(e?.message?.startsWith('RPC ')||e?.message==='Invalid RPC envelope')throw e;
      throw new Error(controller.signal.aborted?'RPC request timed out':'RPC transport failed');
    } finally {clearTimeout(timer);}
  };
}
