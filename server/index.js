import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, Interface, getAddress, formatUnits, id } from 'ethers';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(__dirname,'..');
const PORT=Number(process.env.PORT||10000);
const RPC_URL=process.env.RH_RPC_URL||'https://rpc.mainnet.chain.robinhood.com';
const BLOCKSCOUT=process.env.BLOCKSCOUT_URL||'https://robinhoodchain.blockscout.com/api/v2';
const provider=new JsonRpcProvider(RPC_URL,4663,{staticNetwork:true});

const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO='0x0000000000000000000000000000000000000000';
const WETH='0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();
const PAIR_CREATED_TOPIC='0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e';
const V3_POOL_TOPIC='0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
const PONS_LAUNCHED=id('TokenLaunched(address,address,address,address,uint256,uint256)');
const FACTORIES={};
FACTORIES['0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'.toLowerCase()]='Uniswap V3';
FACTORIES['0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'.toLowerCase()]='Pons V1';
FACTORIES['0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'.toLowerCase()]='Pons V2';

const erc20=new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
]);
const cache=new Map();
const codeCache=new Map();
const poolSet=new Set();
const history=new Map();
let state={status:'STARTING',lastUpdate:null,scanCycle:0,discovered:0,analyzed:0,active:0,errors:0,warnings:[],latestBlock:null,uptime:0};
const started=Date.now();

async function callToken(address,method,fallback=null){try{return await new Contract(address,erc20,provider)[method]()}catch{return fallback}}
async function tokenMeta(address){
  const key=address.toLowerCase();
  if(cache.has(key))return cache.get(key);
  const [name,symbol,decimals,totalSupply]=await Promise.all([
    callToken(address,'name','Unknown'),callToken(address,'symbol','?'),callToken(address,'decimals',18),callToken(address,'totalSupply',0n)
  ]);
  const meta={address:getAddress(address),name:String(name||'Unknown'),symbol:String(symbol||'?'),decimals:Number(decimals||18),totalSupply:BigInt(totalSupply||0)};
  cache.set(key,meta);return meta;
}
async function isContract(address){
  const key=address.toLowerCase();
  if(codeCache.has(key))return codeCache.get(key);
  try{const value=(await provider.getCode(address))!=='0x';codeCache.set(key,value);return value}catch{return false}
}
async function blockscoutToken(address){
  try{const r=await fetch(`${BLOCKSCOUT}/tokens/${address}`);return r.ok?await r.json():null}catch{return null}
}
async function discoverPools(from,to){
  for(const [factory,venue] of Object.entries(FACTORIES)){
    try{
      const logs=await provider.getLogs({address:factory,fromBlock:from,toBlock:to});
      for(const l of logs){
        if(l.topics?.[0]===PAIR_CREATED_TOPIC||l.topics?.[0]===V3_POOL_TOPIC){
          const candidate=l.data.length>=66?'0x'+l.data.slice(-40):null;
          if(candidate&&candidate!==ZERO)poolSet.add(candidate.toLowerCase());
        }else if(l.topics?.[0]===PONS_LAUNCHED&&l.topics[2]){
          poolSet.add(('0x'+l.topics[2].slice(-40)).toLowerCase());
        }
      }
    }catch(e){state.warnings=[...state.warnings.slice(-9),`${venue}: ${e.message}`]}
  }
}
async function transferLogs(from,to){
  const out=[];
  for(let b=from;b<=to;b+=20){
    const end=Math.min(to,b+19);
    try{
      const batch=await provider.getLogs({fromBlock:b,toBlock:end,topics:[TRANSFER_TOPIC]});
      out.push(...batch);
      // Keep the in-memory working set bounded on busy blocks.
      if(out.length>8000)out.splice(0,out.length-8000);
    }catch(e){state.warnings=[...state.warnings.slice(-9),`transfer scan ${b}-${end}: ${e.message}`]}
  }
  return out;
}
async function analyzeLogs(meta,logs){
  const relevant=logs.filter(l=>l.address.toLowerCase()===meta.address.toLowerCase());
  const counterparties=new Set();
  for(const l of relevant){
    if(l.topics.length>=3){
      counterparties.add('0x'+l.topics[1].slice(26).toLowerCase());
      counterparties.add('0x'+l.topics[2].slice(26).toLowerCase());
    }
  }
  for(const a of [...counterparties].filter(a=>a!==ZERO).slice(0,20)){
    if(await isContract(a))poolSet.add(a);
  }
  const trades=[];
  for(const l of relevant){
    if(l.topics.length<3)continue;
    const from='0x'+l.topics[1].slice(26).toLowerCase();
    const to='0x'+l.topics[2].slice(26).toLowerCase();
    const amount=Number(formatUnits(BigInt(l.data),meta.decimals));
    const buy=poolSet.has(from)&&to!==ZERO;
    const sell=poolSet.has(to)&&from!==ZERO;
    if(buy||sell)trades.push({buy,sell,value:Math.abs(amount),block:l.blockNumber,tx:l.transactionHash});
  }
  return trades;
}
function scoreCandidate(meta,scout,trades){
  const marketCap=Number(scout?.market_cap||scout?.circulating_market_cap||0);
  const price=Number(scout?.exchange_rate||0);
  const holders=Number(scout?.holders_count||0);
  const buys=trades.filter(x=>x.buy).length;
  const sells=trades.filter(x=>x.sell).length;
  const total=buys+sells;
  const buyValue=trades.filter(x=>x.buy).reduce((a,x)=>a+x.value,0);
  const sellValue=trades.filter(x=>x.sell).reduce((a,x)=>a+x.value,0);
  const buyShare=total?buys/total:.5;
  const pressure=Math.round(50+(buyShare-.5)*100);
  const activity=Math.min(100,total*4);
  const distribution=Math.min(100,Math.log10(Math.max(holders,1))*18);
  const liquidity=Math.min(100,Math.log10(Math.max((buyValue+sellValue)*100,1))*14);
  const balance=Math.max(0,100-Math.abs(buys-sells)/Math.max(total,1)*100);
  const organic=Math.round(pressure*.25+distribution*.25+liquidity*.25+balance*.25);
  const momentum=Math.min(100,activity*.55+Math.max(0,pressure)*.25+liquidity*.2);
  const score=Math.round(momentum*.55+organic*.45);
  const stage=score>=82?'RUNNING':score>=68?'GROWING':score>=52?'EARLY':'PULLBACK';
  return{marketCap,price,holders,buys,sells,buyValue,sellValue,pressure,organic,momentum,score,stage};
}
async function scan(){
  const latest=await provider.getBlockNumber();
  // Short rolling window keeps the free Render instance stable while still catching fresh activity.
  const from=Math.max(0,latest-180);
  state.latestBlock=latest;
  await discoverPools(from,latest);
  const logs=await transferLogs(from,latest);
  const candidates=new Set();
  for(const l of logs){const a=l.address.toLowerCase();if(a!==WETH&&a!==ZERO)candidates.add(a)}
  const results=[];
  for(const address of [...candidates].slice(0,60)){
    const meta=await tokenMeta(address);
    if(!meta.symbol||meta.symbol==='?')continue;
    const scout=await blockscoutToken(meta.address);
    const trades=await analyzeLogs(meta,logs);
    const metrics=scoreCandidate(meta,scout,trades);
    if(metrics.marketCap>0&&metrics.marketCap<50000)continue;
    if(metrics.marketCap===0&&trades.length<4)continue;
    const prev=history.get(address)||[];
    history.set(address,[...prev,{ts:Date.now(),score:metrics.score}].slice(-24));
    results.push({...meta,...metrics,history:history.get(address)});
  }
  results.sort((a,b)=>b.score-a.score);
  state={...state,status:'LIVE',lastUpdate:new Date().toISOString(),scanCycle:state.scanCycle+1,discovered:candidates.size,analyzed:results.length,active:results.filter(x=>x.score>=52).length,errors:0,warnings:state.warnings.slice(-10),latestBlock:latest,uptime:Math.floor((Date.now()-started)/1000)};
  return results;
}
let radar=[];
async function safeScan(){try{radar=await scan()}catch(e){state.status='DEGRADED';state.errors++;state.warnings=[...state.warnings.slice(-9),e.message]}}

const app=express();
app.use(express.json());
app.get('/health',(req,res)=>res.json({ok:true,chainId:4663,status:state.status,latestBlock:state.latestBlock,uptime:state.uptime}));
app.get('/api/status',(req,res)=>res.json(state));
app.get('/api/radar',(req,res)=>res.json(radar));
app.get('/api/token/:address',async(req,res)=>{
  try{
    const address=getAddress(req.params.address);
    const meta=await tokenMeta(address);
    const scout=await blockscoutToken(address);
    const latest=await provider.getBlockNumber();
    const logs=await transferLogs(Math.max(0,latest-180),latest);
    const trades=await analyzeLogs(meta,logs);
    const metrics=scoreCandidate(meta,scout,trades);
    res.json({...meta,...metrics,history:history.get(address.toLowerCase())||[]});
  }catch(e){res.status(400).json({error:e.message})}
});
app.get('/api/rpc',(req,res)=>res.json({chainId:4663,rpc:process.env.RH_RPC_URL?'configured':'public fallback',publicFallback:!process.env.RH_RPC_URL,blockscout:BLOCKSCOUT}));
app.use(express.static(path.join(ROOT,'dist')));
app.get(/.*/,(req,res)=>res.sendFile(path.join(ROOT,'dist','index.html')));
app.listen(PORT,'0.0.0.0',()=>{console.log(`RunnerHunter listening on 0.0.0.0:${PORT}`);safeScan();setInterval(safeScan,Number(process.env.SCAN_INTERVAL_MS||30000))});
