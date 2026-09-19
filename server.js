import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const port = Number(process.env.PORT || 3000);
const basePath = '/stock12-8';
const root = new URL('.', import.meta.url).pathname;
const cache = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function kisToken() {
  const appKey = process.env.KIS_APP_KEY, appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) return null;
  const base = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  const response = await fetch(`${base}/oauth2/tokenP`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({grant_type:'client_credentials', appkey:appKey, appsecret:appSecret}) });
  if (!response.ok) throw new Error('KIS 인증에 실패했습니다.');
  const { access_token } = await response.json();
  return { appKey, appSecret, base, access_token };
}

async function kisDaily(code) {
  const auth = await kisToken(); if (!auth) return null;
  const { appKey, appSecret, base, access_token } = auth;
  const end = new Date().toISOString().slice(0,10).replaceAll('-','');
  const start = new Date(Date.now() - 1000*60*60*24*365).toISOString().slice(0,10).replaceAll('-','');
  const response = await fetch(`${base}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}&FID_INPUT_DATE_1=${start}&FID_INPUT_DATE_2=${end}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`, { headers: { authorization:`Bearer ${access_token}`, appkey:appKey, appsecret:appSecret, tr_id:'FHKST03010100' } });
  if (!response.ok) throw new Error('KIS 시세 요청에 실패했습니다.');
  const json = await response.json();
  return (json.output2 || []).reverse().map(x => ({date:x.stck_bsop_date, open:+x.stck_oprc, high:+x.stck_hgpr, low:+x.stck_lwpr, close:+x.stck_clpr})).filter(x => x.close);
}
function aggregate(data, count) {
  if (count <= 1) return data;
  const bars = [];
  for (let i = 0; i < data.length; i += count) { const part = data.slice(i, i + count); if (part.length) bars.push({date:part.at(-1).date,open:part[0].open,high:Math.max(...part.map(x=>x.high)),low:Math.min(...part.map(x=>x.low)),close:part.at(-1).close}); }
  return bars;
}
async function kisIntraday(code, minutes, session) {
  const auth = await kisToken(); if (!auth) return null;
  const { appKey, appSecret, base, access_token } = auth;
  const response = await fetch(`${base}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}&FID_INPUT_HOUR_1=153000&FID_PW_DATA_INCU_YN=Y&FID_ETC_CLS_CODE=`, { headers: { authorization:`Bearer ${access_token}`, appkey:appKey, appsecret:appSecret, tr_id:'FHKST03010200' } });
  if (!response.ok) throw new Error('KIS 분봉 요청에 실패했습니다.');
  const json = await response.json();
  const data = (json.output2 || []).reverse().filter(x => session === 'after' ? x.stck_cntg_hour > '153000' : x.stck_cntg_hour >= '090000' && x.stck_cntg_hour <= '153000').map(x => ({date:`${x.stck_bsop_date || ''} ${x.stck_cntg_hour || ''}`.trim(),open:+x.stck_oprc,high:+x.stck_hgpr,low:+x.stck_lwpr,close:+x.stck_prpr})).filter(x => x.close && x.open && x.high && x.low);
  return aggregate(data, minutes);
}
async function yahooIntraday(symbol, minutes) {
  const suffixes = { '035420':'.KS', '035720':'.KS' };
  const suffix = /^[0-9]{6}$/.test(symbol) ? `${symbol}${suffixes[symbol] || '.KS'}` : symbol;
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(suffix)}?range=5d&interval=1m`);
  if (!response.ok) throw new Error('개발용 분봉 요청에 실패했습니다.');
  const result = (await response.json()).chart.result?.[0], q = result?.indicators?.quote?.[0] || {}, times = result?.timestamp || [];
  const data = times.map((time,i) => ({date:new Date(time*1000).toISOString().slice(0,16).replace('T',' '),open:q.open?.[i],high:q.high?.[i],low:q.low?.[i],close:q.close?.[i]})).filter(x => x.close && x.open && x.high && x.low);
  return aggregate(data, minutes);
}
async function stooqDaily(symbol) {
  const map = { '005930':'005930.kr', '000660':'000660.kr', '035420':'035420.kr', '035720':'035720.kr', 'AAPL':'aapl.us', 'MSFT':'msft.us', 'NVDA':'nvda.us', 'TSLA':'tsla.us' };
  const id = map[symbol.toUpperCase()] || '005930.kr';
  const response = await fetch(`https://stooq.com/q/d/l/?s=${id}&i=d`);
  if (!response.ok) throw new Error('대체 시세 요청에 실패했습니다.');
  const rows = (await response.text()).trim().split('\n').slice(1).map(line => { const [date,open,high,low,close] = line.split(','); return {date,open:+open,high:+high,low:+low,close:+close}; }).filter(x => x.close);
  if (rows.length > 20) return rows;
  const suffix = /^[0-9]{6}$/.test(symbol) ? `${symbol}.KS` : symbol;
  const yahoo = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(suffix)}?range=1y&interval=1d`);
  if (!yahoo.ok) throw new Error('개발용 시세 요청에 실패했습니다.');
  const result = (await yahoo.json()).chart.result?.[0];
  const q = result?.indicators?.quote?.[0] || {}, times = result?.timestamp || [];
  return times.map((time,i) => ({date:new Date(time*1000).toISOString().slice(0,10),open:q.open?.[i],high:q.high?.[i],low:q.low?.[i],close:q.close?.[i]})).filter(x => x.close && x.open && x.high && x.low);
}
async function chart(symbol, interval = 'd', session = 'regular') {
  const key = `${symbol.toUpperCase()}:${interval}:${session}`, old = cache.get(key);
  if (old && Date.now() - old.at < 60_000) return old.data;
  const intradayMinutes = { '1m':1, '3m':3, '5m':5, '10m':10, '15m':15, '30m':30, '60m':60 }[interval];
  let data, source;
  if (intradayMinutes) { try { data = await kisIntraday(symbol, intradayMinutes, session); source = `KIS API ${session === 'after' ? '장후' : '정규장'} 분봉`; } catch (error) { console.warn(error.message); } if (!data?.length) { data = await yahooIntraday(symbol, intradayMinutes); source = 'Yahoo 분봉 (개발용)'; } }
  else { try { data = await kisDaily(symbol); source = 'KIS API 일봉'; } catch (error) { console.warn(error.message); } if (!data) { data = await stooqDaily(symbol); source = 'Stooq 일봉 (개발용)'; } data = aggregate(data, interval === 'w' ? 5 : interval === 'mo' ? 20 : 1); }
  const latest = data.slice(-180); cache.set(key, {at:Date.now(), data:{data:latest,source}}); return {data:latest,source};
}
async function assetVersion(file) {
  return String(Math.floor((await stat(join(root, 'public', file))).mtimeMs));
}
http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Accept both direct Node access and the /stock12-8 Nginx reverse-proxy path.
    const requestPath = url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname;
    if (requestPath === '/api/chart') { const symbol = (url.searchParams.get('symbol') || '005930').replace(/[^0-9A-Za-z.^-]/g,''); const interval = ['1m','3m','5m','10m','15m','30m','60m','d','w','mo'].includes(url.searchParams.get('interval')) ? url.searchParams.get('interval') : 'd'; const session = url.searchParams.get('session') === 'after' ? 'after' : 'regular'; const result = await chart(symbol, interval, session); res.writeHead(200, {'content-type':'application/json','cache-control':'no-store, no-cache, must-revalidate, max-age=0'}); return res.end(JSON.stringify(result)); }
    const path = requestPath === '/' ? '/index.html' : requestPath;
    if (!path.startsWith('/') || path.includes('..')) throw Object.assign(new Error('Not found'), {code:'ENOENT'});
    let body = await readFile(join(root, 'public', path));
    const headers = {'content-type':mime[extname(path)] || 'application/octet-stream'};
    if (path === '/index.html') {
      const [appVersion, styleVersion] = await Promise.all([assetVersion('app.js'), assetVersion('styles.css')]);
      body = Buffer.from(body.toString().replace('__APP_VERSION__', appVersion).replace('__STYLE_VERSION__', styleVersion));
      headers['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0';
    } else if (path === '/app.js' || path === '/styles.css') {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['cache-control'] = 'no-cache';
    }
    res.writeHead(200, headers); res.end(body);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500, {'content-type':'application/json'}); res.end(JSON.stringify({error:error.message})); }
}).listen(port, () => console.log(`Stock12 running at http://localhost:${port}`));
