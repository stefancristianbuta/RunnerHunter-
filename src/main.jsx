import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';

const tokens=[
 {name:'MoonBolt',symbol:'MOONB',mcap:'$2.4M',vol:'$420K',age:'4m',score:92,safety:78,stage:'EARLY',trend:'+18.4%',liq:'$220K',dex:'Uniswap V3'},
 {name:'SwiftCat',symbol:'SWCAT',mcap:'$3.1M',vol:'$520K',age:'9m',score:85,safety:70,stage:'GROWING',trend:'+14.2%',liq:'$310K',dex:'Ramses V3'},
 {name:'RocketDog',symbol:'RDOG',mcap:'$1.7M',vol:'$280K',age:'13m',score:81,safety:66,stage:'RUNNING',trend:'+24.8%',liq:'$220K',dex:'Pons V2'},
 {name:'AlphaMind',symbol:'ALPHA',mcap:'$2.1M',vol:'$390K',age:'18m',score:79,safety:73,stage:'PULLBACK',trend:'+9.7%',liq:'$190K',dex:'Uniswap V4'},
 {name:'GreenFuel',symbol:'GFUEL',mcap:'$2.8M',vol:'$540K',age:'24m',score:76,safety:81,stage:'GROWING',trend:'+12.1%',liq:'$340K',dex:'Up V3'},
 {name:'TurboMoon',symbol:'TURBO',mcap:'$1.4M',vol:'$260K',age:'29m',score:72,safety:69,stage:'EARLY',trend:'+8.9%',liq:'$160K',dex:'Pons V2'}
];

function Icon({children}){return <span className="icon">{children}</span>}
function App(){
 const [tab,setTab]=useState('EARLY');
 const [page,setPage]=useState('radar');
 const [selected,setSelected]=useState(null);
 const [favorites,setFavorites]=useState([]);
 const [query,setQuery]=useState('');
 const [notice,setNotice]=useState('');
 const filtered=tokens.filter(t=>tab==='ALL'||t.stage===tab|| (tab==='RUNNING'&&t.stage==='PULLBACK'));
 const toggleFav=(symbol)=>setFavorites(f=>f.includes(symbol)?f.filter(x=>x!==symbol):[...f,symbol]);
 const analyze=()=>{ if(!query.trim()) return; setNotice('Analysis queued for Robinhood Chain'); setTimeout(()=>setNotice('Token analysis ready'),700); };
 const openToken=(t)=>{setSelected(t);setPage('detail')};
 return <div className="app">
  <header className="topbar">
   <button className="brand" onClick={()=>setPage('radar')}><div className="panther">◢</div><div><b>RUNNER<span>HUNTER</span></b><small>FIND · TRACK · ANALYZE</small></div></button>
   <div className="live"><i/> RADAR LIVE <small>Chain 4663</small></div>
  </header>
  {notice&&<div className="toast">{notice}</div>}
  <main>
   {page==='radar'&&<>
    <section className="hero"><div><p className="eyebrow">ROBINHOOD CHAIN</p><h1>Find the next runner.</h1><p className="muted">Live discovery of organic momentum across the chain.</p></div><div className="heroStats"><strong>LIVE</strong><span>Last update 6s ago</span><span>Scan cycle 28s</span></div></section>
    <div className="metrics"><div><b>{tokens.length}</b><span>Active candidates</span></div><div><b>4663</b><span>Chain ID</span></div><div><b>{favorites.length}</b><span>Favorites</span></div><div><b>0</b><span>Errors</span></div></div>
    <nav className="tabs">{['EARLY','GROWING','RUNNING','PULLBACK'].map(x=><button className={tab===x?'active':''} onClick={()=>setTab(x)} key={x}>{x}</button>)}</nav>
    <section className="list">{filtered.map((t,i)=><button className="tokenRow" key={t.symbol} onClick={()=>openToken(t)}><div className="rank">{i+1}</div><div className="coin">{t.symbol[0]}</div><div className="tokenName"><b>{t.name}</b><span>{t.symbol} · RH · {t.dex}</span></div><div className="numbers"><b>{t.mcap}</b><span>{t.vol} · {t.age}</span></div><div className="score">{t.score}</div><div className="trend">{t.trend}</div><button className="star" onClick={(e)=>{e.stopPropagation();toggleFav(t.symbol)}}>{favorites.includes(t.symbol)?'★':'☆'}</button></button>)}</section>
   </>}
   {page==='detail'&&selected&&<TokenDetail t={selected} back={()=>setPage('radar')} fav={favorites.includes(selected.symbol)} toggle={()=>toggleFav(selected.symbol)}/>} 
   {page==='search'&&<Search query={query} setQuery={setQuery} analyze={analyze}/>} 
   {page==='favorites'&&<Favorites tokens={tokens.filter(t=>favorites.includes(t.symbol))} open={openToken} toggle={toggleFav}/>} 
   {page==='settings'&&<Settings/>}
  </main>
  <footer><button className={page==='radar'||page==='detail'?'sel':''} onClick={()=>setPage('radar')}><Icon>⌁</Icon>Radar</button><button className={page==='search'?'sel':''} onClick={()=>setPage('search')}><Icon>⌕</Icon>Search</button><button className={page==='favorites'?'sel':''} onClick={()=>setPage('favorites')}><Icon>★</Icon>Favorites</button><button className={page==='settings'?'sel':''} onClick={()=>setPage('settings')}><Icon>⚙</Icon>Settings</button></footer>
 </div>
}
function TokenDetail({t,back,fav,toggle}){return <section className="detail"><button className="back" onClick={back}>‹ Back</button><div className="detailHead"><div className="coin big">{t.symbol[0]}</div><div><h2>{t.name}</h2><p>{t.symbol} · Robinhood Chain · {t.dex}</p></div><button className="star bigStar" onClick={toggle}>{fav?'★':'☆'}</button></div><div className="scores"><div><span>RADAR SCORE</span><b>{t.score}</b></div><div><span>SAFETY SCORE</span><b>{t.safety}</b></div><div><span>STAGE</span><b>{t.stage}</b></div></div><div className="price"><span>Price</span><b>$0.03421</b><em>{t.trend} · 1h</em></div><div className="detailGrid"><div><span>Market Cap</span><b>{t.mcap}</b></div><div><span>Volume</span><b>{t.vol}</b></div><div><span>Liquidity</span><b>{t.liq}</b></div><div><span>Age</span><b>{t.age}</b></div></div><div className="chart"><div className="chartLine"/><span>Price & momentum</span><small>1m · 5m · 1h · 4h · 1d</small></div><div className="contract"><span>Contract</span><code>0x3a...7f2d</code><button onClick={()=>navigator.clipboard?.writeText('0x3a...7f2d')}>Copy</button></div></section>}
function Search({query,setQuery,analyze}){return <section className="searchPage"><p className="eyebrow">TOKEN INSPECTOR</p><h1>Analyze any token.</h1><p className="muted">Paste a Robinhood Chain contract, name or symbol.</p><div className="searchBox"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="0x... / token name / symbol"/><button onClick={analyze}>Analyze</button></div><div className="infoCard"><b>Same engine as Radar</b><span>Momentum, liquidity, holders, buy/sell pressure and organicity are scored the same way.</span></div><div className="chainCard"><span>ROBINHOOD CHAIN</span><b>Chain ID 4663</b><i>● ONLINE</i></div></section>}
function Favorites({tokens,open,toggle}){return <section><p className="eyebrow">SAVED</p><h1>My Favorites</h1>{tokens.length===0?<div className="empty">No favorites yet.<br/>Tap ☆ on a runner to save it.</div>:<section className="list">{tokens.map(t=><button className="tokenRow" key={t.symbol} onClick={()=>open(t)}><div className="coin">{t.symbol[0]}</div><div className="tokenName"><b>{t.name}</b><span>{t.symbol} · RH</span></div><div className="numbers"><b>{t.mcap}</b><span>{t.vol}</span></div><button className="star" onClick={e=>{e.stopPropagation();toggle(t.symbol)}}>★</button></button>)}</section>}</section>}
function Settings(){return <section className="settings"><p className="eyebrow">SYSTEM</p><h1>Settings</h1>{[['◉','Radar Diagnostics','Live status, scan cycle, resources'],['⌁','RPC Status','Robinhood Chain endpoints'],['◔','Notifications','Alerts and runner events'],['◐','Appearance','Dark premium theme'],['ⓘ','About','RunnerHunter v0.1.0']].map(x=><div className="setting" key={x[1]}><span>{x[0]}</span><div><b>{x[1]}</b><small>{x[2]}</small></div><strong>›</strong></div>)}</section>}
createRoot(document.getElementById('root')).render(<App/>);
