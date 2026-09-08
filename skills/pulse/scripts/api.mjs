import {createServer} from 'node:http';

/** Local-only read interface. Retained spool remains the replay source. */
export async function serve({port=0,health,snapshot,events}) {
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET') {res.writeHead(405);res.end('{"error":"GET only"}');return;}
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      let result;
      if(url.pathname==='/health') result=health();
      else if(url.pathname==='/v1/pools') result=snapshot();
      else if(url.pathname==='/v1/events') {
        const after=Number(url.searchParams.get('after')??'0'), limit=Number(url.searchParams.get('limit')??'100');
        if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('invalid cursor');
        result=events(after,limit);
        if(result.status==='CURSOR_EXPIRED') res.statusCode=410;
      } else {res.writeHead(404);res.end('{"error":"unknown route"}');return;}
      res.end(JSON.stringify(result));
    } catch {res.writeHead(400);res.end('{"error":"invalid request"}');}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=32;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {address:server.address(), close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
