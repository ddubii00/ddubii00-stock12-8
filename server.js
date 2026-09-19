import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const port = Number(process.env.PORT || 3000);
const root = new URL('.', import.meta.url).pathname;
const cache = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function kisDaily(code) {
  const appKey = process.env.KIS_APP_KEY, appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) return null;
  const base = process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
  const tokenResponse = await fetch(`${base}/oauth2/tokenP`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({grant_type:'client_credentials', appkey:appKey, appsecret:appSecret}) });
  if (!tokenResponse.ok) throw new Error('KIS 인증에 실패했습니다.');
  const { access_token } = await tokenResponse.json();
  const end = new Date().toISOString().slice(0,10).replaceAll('-','');
  const start = new Date(Date.now() - 1000*60*60*24*365).toISOString().slice(0,10).replaceAll('-','');
  const response = await fetch(`${base}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(code)}&FID_INPUT_DATE_1=${start}&FID_INPUT_DATE_2=${end}&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0`, { headers: { authorization:`Bearer ${access_token}`, appkey:appKey, appsecret:appSecret, tr_id:'FHKST03010100' } });
  if (!response.ok) throw new Error('KIS 시세 요청에 실패했습니다.');
  const json = await response.json();
  return (json.output2 || []).reverse().map(x => ({date:x.stck_bsop_date, open:+x.stck_oprc, high:+x.stck_hgpr, low:+x.stck_lwpr, close:+x.stck_clpr})).filter(x => x.close);
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
async function chart(symbol) {
  const key = symbol.toUpperCase(); const old = cache.get(key);
  if (old && Date.now() - old.at < 5 * 60_000) return old.data;
  let data; try { data = await kisDaily(key); } catch (error) { console.warn(error.message); }
  if (!data) data = await stooqDaily(key);
  const latest = data.slice(-180); cache.set(key, {at:Date.now(), data:latest}); return latest;
}
http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/chart') { const data = await chart((url.searchParams.get('symbol') || '005930').replace(/[^0-9A-Za-z.^-]/g,'')); res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); return res.end(JSON.stringify({data, source:process.env.KIS_APP_KEY ? 'KIS API' : 'Stooq (개발용)'})); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const body = await readFile(join(root, 'public', path)); res.writeHead(200, {'content-type':mime[extname(path)] || 'application/octet-stream'}); res.end(body);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500, {'content-type':'application/json'}); res.end(JSON.stringify({error:error.message})); }
}).listen(port, () => console.log(`Stock12 running at http://localhost:${port}`));
