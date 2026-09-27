// Tải số liệu công khai từ FRED (Fed St. Louis) và tính ĐỀ XUẤT cho các ô chọn của app liên thị trường.
// Chạy hằng ngày bởi GitHub Actions (.github/workflows/update-market.yml), ghi ra data/market.json.
// Trang web chỉ ĐỌC file này và hiện đề xuất kèm nút "Áp dụng" — không bao giờ tự ghi đè lựa chọn của người dùng.
//
// Chạy tay:  node scripts/fetch-market.mjs
// Không cần thư viện ngoài, không cần API key (dùng endpoint CSV công khai fredgraph.csv).

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import https from 'node:https';

const FRED = id => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2010-01-01`;

const SERIES = {
  DGS10:           'Lợi suất Trái Phiếu Kho Bạc Mỹ 10 năm (%)',
  DFF:             'Lãi suất Fed Funds hiệu dụng, ngày (%)',
  M2SL:            'Cung tiền M2 (tỷ USD)',
  SP500:           'S&P 500',
  DTWEXBGS:        'Chỉ số USD rộng (Nominal Broad Dollar Index)',
  DCOILBRENTEU:    'Dầu Brent (USD/thùng)',
  PALLFNFINDEXM:   'Chỉ số giá toàn bộ hàng hóa IMF (tháng)',
  WALCL:           'Tổng tài sản Fed (triệu USD)',
  GFDEGDQ188S:     'Nợ công liên bang Mỹ / GDP (%)',
  STLFSI4:         'Chỉ số Căng thẳng Tài chính St. Louis',
  ECIWAG:          'Chỉ số Chi Phí Tiền Lương ECI (tư nhân)',
  IRLTLT01DEM156N: 'Lợi suất dài hạn Đức (%)',
  IRLTLT01JPM156N: 'Lợi suất dài hạn Nhật (%)',
  IRLTLT01GBM156N: 'Lợi suất dài hạn Anh (%)',
};

async function fetchSeries(id, tries = 4){
  for(let i = 1; i <= tries; i++){
    try{
      const res = await fetch(FRED(id), { headers: { 'User-Agent': 'lien-thi-truong-data-bot' } });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.text()).trim().split('\n').slice(1)
        .map(l => l.split(','))
        .filter(r => r[1] && r[1] !== '.' && !isNaN(+r[1]))
        .map(r => ({ date: r[0], value: +r[1] }));
      if(!rows.length) throw new Error('rỗng');
      return rows;
    }catch(e){
      if(i === tries) throw new Error(`${id}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

// ---- tiện ích chuỗi thời gian ----
const last = s => s[s.length - 1];
function valueAtOrBefore(s, date){
  for(let i = s.length - 1; i >= 0; i--) if(s[i].date <= date) return s[i];
  return s[0];
}
function daysBefore(dateStr, days){
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function change(s, days){
  const now = last(s), prev = valueAtOrBefore(s, daysBefore(now.date, days));
  return { now, prev, abs: now.value - prev.value, pct: (now.value / prev.value - 1) * 100 };
}
// Trung bình theo tháng (YYYY-MM) để đếm độ dài xu hướng
function monthly(s){
  const m = new Map();
  for(const r of s){ const k = r.date.slice(0, 7); (m.get(k) || m.set(k, []).get(k)).push(r.value); }
  return [...m].map(([k, v]) => ({ date: k, value: v.reduce((a, b) => a + b, 0) / v.length }));
}
const dirWord = d => d === 1 ? 'Tăng' : (d === -1 ? 'Giảm' : 'Đi Ngang');
const fmt = (x, n = 2) => (x >= 0 ? '+' : '') + x.toFixed(n);
const viDate = d => d.length === 7 ? `${d.slice(5)}/${d.slice(0, 4)}` : `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

// Ngưỡng "Đi Ngang" cho thay đổi 3 tháng — dưới ngưỡng coi là chưa có xu hướng rõ
const TH = { yieldBp: 25, stocksPct: 3, usdPct: 1.5, commPct: 3, oilPct: 5 };
const dir = (x, th) => x > th ? 1 : (x < -th ? -1 : 0);

// =====================================================================================
// VIỆT NAM — Ngân hàng Nhà nước (sbv.gov.vn). SBV có tường lửa chặn truy cập không giống trình duyệt, nên gửi
// header như trình duyệt và giữ cookie giữa các request. Nếu SBV lỗi/chặn, giữ lại số liệu VN của lần trước
// (đánh dấu cũ) thay vì làm hỏng cả file.
// =====================================================================================
const SBV = 'https://sbv.gov.vn';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
};
// Dùng module https gốc thay vì fetch(): fetch() của Node tự thêm header "sec-fetch-mode: cors", bị tường lửa
// SBV nhận ra là không phải trình duyệt và trả trang "Request Rejected".
const sbvCookies = new Map();
function httpsGet(url, accept){
  return new Promise((resolve, reject) => {
    const cookie = [...sbvCookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const req = https.get(url, { headers: { ...BROWSER_HEADERS, Accept: accept, ...(cookie ? { Cookie: cookie } : {}) }, timeout: 30000 }, res => {
      for(const c of res.headers['set-cookie'] || []){ const [kv] = c.split(';'); const i = kv.indexOf('='); sbvCookies.set(kv.slice(0, i), kv.slice(i + 1)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('timeout', () => req.destroy(new Error('hết thời gian chờ')));
    req.on('error', reject);
  });
}
async function sbvFetch(path, accept = 'text/html', tries = 3){
  for(let i = 1; i <= tries; i++){
    try{
      let url = SBV + path;
      for(let hop = 0; hop < 5; hop++){ // tự theo redirect để giữ cookie
        const res = await httpsGet(url, accept);
        if(res.status >= 300 && res.status < 400 && res.location){ url = new URL(res.location, url).href; continue; }
        if(res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if(res.body.includes('Request Rejected')) throw new Error('bị tường lửa SBV chặn');
        return res.body;
      }
      throw new Error('quá nhiều redirect');
    }catch(e){
      if(i === tries) throw new Error(`SBV ${path.slice(0, 40)}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}
const vnNum = s => +String(s).trim().replace(/\./g, '').replace(',', '.').replace('%', ''); // "18.594.930,02" -> 18594930.02
const htmlText = h => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, '|').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/(\| ?)+/g, '|');

// Lãi suất NHNN quy định (tái cấp vốn, tái chiết khấu) + lãi suất liên ngân hàng — cùng 1 trang
// Tường lửa SBV chỉ cho vào trang con khi đã có cookie phiên cấp từ trang chủ — "làm nóng" 1 lần trước
let sbvWarm = null;
function sbvWarmUp(){
  if(!sbvWarm) sbvWarm = sbvFetch('/vi/trang-chu').catch(e => { sbvWarm = null; throw e; });
  return sbvWarm;
}

async function fetchSbvRates(){
  await sbvWarmUp();
  const t = htmlText(await sbvFetch('/vi/l%C3%A3i-su%E1%BA%A5t1'));
  const grab = (label) => {
    const m = t.match(new RegExp(label + '\\|([0-9.,]+)%\\|([^|]*)\\|(\\d{2}/\\d{2}/\\d{4})'));
    return m ? { value: vnNum(m[1]), decision: m[2].trim(), since: m[3].split('/').reverse().join('-') } : null;
  };
  const refi = grab('Lãi suất tái cấp vốn');
  const rediscount = grab('Lãi suất tái chiết khấu');
  if(!refi) throw new Error('không đọc được lãi suất tái cấp vốn (SBV có thể đã đổi giao diện)');
  const ibDate = (t.match(/Lãi suất thị trường liên ngân hàng\|Ngày áp dụng: \|(\d{2}\/\d{2}\/\d{4})/) || [])[1];
  const ib = {};
  for(const [key, label] of [['overnight', 'Qua đêm'], ['w1', '1 Tuần'], ['m1', '1 Tháng'], ['m3', '3 Tháng']]){
    const m = t.match(new RegExp('\\|' + label + '\\|([0-9,]+) ?\\|'));
    if(m) ib[key] = vnNum(m[1]);
  }
  return { refi, rediscount, interbank: { date: ibDate ? ibDate.split('/').reverse().join('-') : null, ...ib } };
}

// Dư nợ tín dụng đối với nền kinh tế (tháng) — API nội bộ mà chính trang SBV dùng để vẽ biểu đồ
async function fetchSbvCredit(){
  await sbvWarmUp();
  const from = `${new Date().getUTCFullYear() - 2}-01-01`;
  const filter = `status eq 0 and Date62813077 ne '' and Date62813077 ge '${from}' and Date62813077 le '2099-12-31'`;
  const rows = [];
  for(let page = 1; page <= 5; page++){
    const txt = await sbvFetch(`/o/article/v1.0/articles?scopeKey=20117&contentStructureId=10034332&pageSize=200&page=${page}&filter=${encodeURIComponent(filter)}`, 'application/json');
    const j = JSON.parse(txt);
    for(const a of j.articles || []){
      const f = a.fields || {};
      if(f.Date62813077 && f.soDuTongCong) rows.push({ date: f.Date62813077, total: vnNum(f.soDuTongCong), ytd: vnNum(f.tocDoTangGiamTongCong), modified: a.dateModified });
    }
    if(!j.lastPage || page >= j.lastPage) break;
  }
  // Dữ liệu SBV có lỗi nhập liệu: trùng tháng, ngày ghi nhầm (vd 2026-03-20 lặp lại số tháng 1). Làm sạch:
  // mỗi tháng giữ bản ghi có NGÀY muộn nhất; cùng ngày thì giữ số dư lớn nhất (bản ghi nhỏ bất thường là số của
  // một ngành bị nhập nhầm vào ô tổng). Rồi loại điểm lệch >8% so với tháng liền trước (tín dụng không nhảy như vậy).
  const byMonth = new Map();
  for(const r of rows){
    const k = r.date.slice(0, 7), cur = byMonth.get(k);
    if(!cur || r.date > cur.date || (r.date === cur.date && r.total > cur.total)) byMonth.set(k, r);
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, r]) => ({ month, ...r }));
  const clean = [];
  for(const m of months){
    const prev = clean[clean.length - 1];
    if(prev && Math.abs(m.total / prev.total - 1) > 0.08) continue;
    clean.push(m);
  }
  if(clean.length < 13) throw new Error(`chỉ có ${clean.length} tháng dữ liệu tín dụng, cần ≥ 13 để tính YoY`);
  const last = clean[clean.length - 1];
  const [y, mo] = last.month.split('-');
  const yearAgo = clean.find(m => m.month === `${+y - 1}-${mo}`);
  if(!yearAgo) throw new Error(`thiếu dữ liệu tháng ${mo}/${+y - 1} để tính YoY`);
  return { month: last.month, date: last.date, total: last.total, ytd: last.ytd, yoy: +((last.total / yearAgo.total - 1) * 100).toFixed(2) };
}

async function main(){
  const data = {};
  const errors = [];
  await Promise.all(Object.keys(SERIES).map(async id => {
    try { data[id] = await fetchSeries(id); } catch(e){ errors.push(e.message); }
  }));

  const sug = {};   // key -> { value, reason, asOf, confidence }
  const put = (key, value, reason, asOf, confidence = 'cao') => { sug[key] = { value, reason, asOf, confidence }; };

  // ---- 4 tài sản (thay đổi 3 tháng) ----
  let bondsDir = null, stocksDir = null, usdDir = null, commDir = null, oil = null, comm = null;
  if(data.DGS10){
    const c = change(data.DGS10, 91);
    const bp = c.abs * 100;
    bondsDir = dir(-bp, TH.yieldBp); // lợi suất tăng => giá trái phiếu giảm
    put('bonds', bondsDir, `Lợi suất 10 năm ${c.prev.value.toFixed(2)}% → ${c.now.value.toFixed(2)}% (${fmt(bp, 0)} điểm cơ bản trong 3 tháng; ngưỡng ±${TH.yieldBp}) — giá trái phiếu đi ngược lợi suất.`, c.now.date);
  }
  if(data.SP500){
    const c = change(data.SP500, 91);
    stocksDir = dir(c.pct, TH.stocksPct);
    put('stocks', stocksDir, `S&P 500 ${fmt(c.pct, 1)}% trong 3 tháng (${Math.round(c.prev.value)} → ${Math.round(c.now.value)}; ngưỡng ±${TH.stocksPct}%).`, c.now.date);
  }
  if(data.DTWEXBGS){
    const c = change(data.DTWEXBGS, 91);
    usdDir = dir(c.pct, TH.usdPct);
    put('usd', usdDir, `Chỉ số USD rộng ${fmt(c.pct, 1)}% trong 3 tháng (ngưỡng ±${TH.usdPct}%).`, c.now.date);
  }
  if(data.DCOILBRENTEU){
    oil = change(data.DCOILBRENTEU, 91);
    const oilDir = dir(oil.pct, TH.oilPct);
    put('oilTrend', oilDir, `Brent ${fmt(oil.pct, 1)}% trong 3 tháng (${oil.prev.value.toFixed(0)} → ${oil.now.value.toFixed(0)} USD; ngưỡng ±${TH.oilPct}%).`, oil.now.date);
    if(oilDir !== 0){
      // Độ trưởng thành: bao nhiêu tháng liên tiếp thay đổi 3 tháng cùng chiều
      const m = monthly(data.DCOILBRENTEU);
      let n = 0;
      for(let i = m.length - 1; i >= 3; i--){ if(Math.sign(m[i].value - m[i - 3].value) === oilDir) n++; else break; }
      put('oilMaturity', n >= 9 ? 'extended' : 'fresh', `Xu hướng ${dirWord(oilDir).toLowerCase()} của Dầu đã kéo dài khoảng ${n} tháng (từ 9 tháng trở lên coi là "Đã Kéo Dài").`, oil.now.date, 'trung bình');
    }
  }
  if(data.PALLFNFINDEXM){
    comm = change(data.PALLFNFINDEXM, 92);
    commDir = dir(comm.pct, TH.commPct);
    const ageDays = Math.round((Date.now() - new Date(comm.now.date)) / 864e5);
    const oilDir = oil ? dir(oil.pct, TH.oilPct) : null;
    const conflict = oilDir !== null && oilDir !== 0 && commDir !== oilDir;
    const stale = ageDays > 60;
    // Chỉ số IMF là số liệu THÁNG, thường trễ 2-3 tháng. Khi đã quá cũ mà lại ngược chiều Dầu (số liệu NGÀY, và là
    // cấu phần lớn nhất của các chỉ số hàng hóa), ưu tiên chiều của Dầu — nhưng hạ độ tin cậy xuống "thấp".
    if(stale && conflict){
      commDir = oilDir;
      put('commodities', commDir,
        `Chỉ số hàng hóa IMF ${fmt(comm.pct, 1)}% nhưng đã cũ (tháng ${viDate(comm.now.date.slice(0, 7))}, trễ ~${ageDays} ngày) và ngược chiều Dầu Brent ${fmt(oil.pct, 1)}% (số liệu ngày) — tạm theo chiều của Dầu. Nên tự kiểm tra thêm kim loại/nông sản.`,
        oil.now.date, 'thấp');
    } else {
      put('commodities', commDir,
        `Chỉ số hàng hóa IMF ${fmt(comm.pct, 1)}% trong 3 tháng (số liệu tháng ${viDate(comm.now.date.slice(0, 7))}, trễ ~${ageDays} ngày).` +
        (conflict ? ` ⚠ Ngược chiều với Dầu Brent (${fmt(oil.pct, 1)}%) — nên tự kiểm tra lại.` : ''),
        comm.now.date, conflict || stale ? 'thấp' : 'trung bình');
    }
  }

  // ---- Fed & tín dụng ----
  let fedCycle = null, fedRate = null, t10 = null, m2yoy = null;
  if(data.DFF){
    const c = change(data.DFF, 183);
    fedRate = c.now.value;
    fedCycle = c.abs > 0.2 ? 'hiking' : (c.abs < -0.2 ? 'cutting' : 'normal');
    put('fedCycle', fedCycle, `Lãi suất Fed ${c.prev.value.toFixed(2)}% → ${c.now.value.toFixed(2)}% trong 6 tháng (${fmt(c.abs)} điểm %; ngưỡng ±0,2).`, c.now.date);
  }
  if(data.M2SL){
    const s = data.M2SL, now = last(s), yearAgo = valueAtOrBefore(s, daysBefore(now.date, 365));
    m2yoy = +((now.value / yearAgo.value - 1) * 100).toFixed(2);
  }
  if(data.DGS10) t10 = last(data.DGS10).value;
  if(fedRate !== null){
    put('creditInputs', { m2yoy, fedRate: +fedRate.toFixed(2), treasury10y: t10 },
      `M2 YoY ${m2yoy ?? '—'}% (tháng ${data.M2SL ? viDate(last(data.M2SL).date.slice(0, 7)) : '—'}), lãi suất Fed ${fedRate.toFixed(2)}%, lợi suất 10 năm ${t10 ?? '—'}%.`,
      last(data.DFF).date);
  }

  // ---- Nợ/GDP Mỹ so với trung bình 10 năm (40 quý) ----
  if(data.GFDEGDQ188S){
    const s = data.GFDEGDQ188S, now = last(s), win = s.slice(-40);
    const avg = win.reduce((a, r) => a + r.value, 0) / win.length;
    const rel = (now.value / avg - 1) * 100;
    const level = rel > 3 ? 'above' : (rel < -3 ? 'below' : 'average');
    put('debtGdpLevel', level, `Nợ liên bang/GDP ${now.value.toFixed(1)}% so với trung bình 10 năm ${avg.toFixed(1)}% (${fmt(rel, 1)}%; lệch dưới ±3% coi là ngang bằng). Chỉ áp dụng cho phạm vi Mỹ/Thế Giới.`, now.date, 'trung bình');
  }

  // ---- Trái Phiếu: độ dài xu hướng, số tháng, vùng giá nhiều năm ----
  if(data.DGS10 && bondsDir){
    const m = monthly(data.DGS10);
    const yieldDir = -bondsDir;
    let n = 0;
    for(let i = m.length - 1; i >= 6; i--){ if(Math.sign(m[i].value - m[i - 6].value) === yieldDir) n++; else break; }
    const months = n + 6; // cộng cửa sổ 6 tháng dùng để đo
    const maturity = months >= 60 ? 'secular' : (months >= 9 ? 'extended' : 'fresh');
    put('bondTrendMonths', months, `Lợi suất 10 năm đã ${yieldDir === 1 ? 'tăng' : 'giảm'} liên tục (so với 6 tháng trước) khoảng ${months} tháng.`, last(m).date, 'trung bình');
    put('bondTrendMaturity', maturity, `${months} tháng — dưới 9 tháng là "Mới Đảo Chiều", 9-59 tháng "Đã Kéo Dài", từ 60 tháng "Đã Vượt Quá 1 Chu Kỳ".`, last(m).date, 'trung bình');
    const win = m.slice(-60).map(r => r.value).sort((a, b) => a - b);
    const cur = last(m).value;
    const pctile = win.filter(v => v <= cur).length / win.length;
    const level = pctile >= 0.8 ? 'near_low' : (pctile <= 0.2 ? 'near_high' : 'middle'); // lợi suất cao = giá thấp
    put('bondPriceLevel', level, `Lợi suất hiện ở bách phân vị ${Math.round(pctile * 100)} của 5 năm qua — ${level === 'near_low' ? 'lợi suất gần đỉnh, tức giá Trái Phiếu gần vùng THẤP nhiều năm' : (level === 'near_high' ? 'lợi suất gần đáy, tức giá Trái Phiếu gần vùng CAO nhiều năm' : 'giá ở vùng giữa')}.`, last(m).date);
  }

  // ---- Lợi suất nhiều nước cùng tăng? (Đức, Nhật, Anh, 3 tháng) ----
  const intl = ['IRLTLT01DEM156N', 'IRLTLT01JPM156N', 'IRLTLT01GBM156N'].filter(id => data[id]);
  if(intl.length === 3 && data.DGS10){
    const ch = intl.map(id => change(data[id], 92).abs);
    const usUp = change(data.DGS10, 91).abs > 0.1;
    const allUp = ch.every(x => x > 0.1);
    if(usUp) put('globalYieldSync', allUp ? 'yes' : 'no', `Thay đổi lợi suất dài hạn 3 tháng — Đức ${fmt(ch[0])}, Nhật ${fmt(ch[1])}, Anh ${fmt(ch[2])} điểm %. ${allUp ? 'Cả 3 cùng tăng cùng Mỹ.' : 'Không phải tất cả cùng tăng.'}`, last(data[intl[0]]).date, 'trung bình');
  }

  // ---- Chế độ tương quan ----
  if(data.WALCL){
    const c = change(data.WALCL, 365);
    put('activeQE', c.pct > 5 ? 'yes' : 'no', `Tổng tài sản Fed ${fmt(c.pct, 1)}% trong 12 tháng (trên +5% coi là đang bơm QE).`, c.now.date);
  }
  if(data.STLFSI4){
    const now = last(data.STLFSI4);
    if(now.value > 1 || now.value < 0) put('usdFundingStress', now.value > 1 ? 'yes' : 'no', `Chỉ số Căng thẳng Tài chính St. Louis = ${now.value.toFixed(2)} (trên 1 là căng thẳng rõ, dưới 0 là thấp hơn bình thường). Đây là chỉ báo đại diện, không đo trực tiếp thanh khoản USD.`, now.date, 'trung bình');
  }

  // ---- ECI: tăng trưởng YoY quý mới nhất & quý trước ----
  if(data.ECIWAG && data.ECIWAG.length >= 6){
    const s = data.ECIWAG, n = s.length;
    const yoy = i => +((s[i].value / s[i - 4].value - 1) * 100).toFixed(2);
    put('eci', { current: yoy(n - 1), previous: yoy(n - 2) }, `ECI tiền lương tư nhân: ${yoy(n - 1)}%/năm (quý ${viDate(s[n - 1].date.slice(0, 7))}) so với ${yoy(n - 2)}%/năm quý trước.`, s[n - 1].date);
  }

  // ---- Suy ra từ các đề xuất trên ----
  if(usdDir !== null && stocksDir !== null){
    let ctx = 'normal', why;
    if(usdDir === 1 && stocksDir === -1){ ctx = 'crisis'; why = 'USD Tăng trong khi Cổ Phiếu Giảm — dòng tiền trú ẩn, đúng đầu "Khủng Hoảng" của Dollar Smile.'; }
    else if(usdDir === 1 && stocksDir === 1){ ctx = 'boom'; why = 'USD và Cổ Phiếu cùng Tăng — vốn đổ vào Mỹ vì tăng trưởng vượt trội, đúng đầu "Mỹ Hưng Thịnh".'; }
    else why = `USD ${dirWord(usdDir)}, Cổ Phiếu ${dirWord(stocksDir)} — không khớp đầu nào của Dollar Smile, giữ "Bình Thường".`;
    put('usdContext', ctx, why, null, 'trung bình');
    if(ctx !== 'normal') put('capitalFlowType', ctx === 'boom' ? 'investment' : 'safe_haven', `Suy ra từ Dollar Smile "${ctx === 'boom' ? 'Mỹ Hưng Thịnh' : 'Khủng Hoảng Toàn Cầu'}".`, null, 'trung bình');
  }
  if(oil && (commDir === 1 || dir(oil.pct, TH.oilPct) === 1)){
    const gap = oil.pct - (comm ? comm.pct : 0);
    if(gap > 10) put('commodityCause', 'cost_push', `Dầu tăng ${fmt(oil.pct, 1)}% vượt xa phần hàng hóa còn lại (${comm ? fmt(comm.pct, 1) + '%' : '—'}) — áp lực đến từ năng lượng/nguồn cung, không phải cầu chung.`, oil.now.date, 'trung bình');
    else if(commDir === 1 && stocksDir === 1) put('commodityCause', 'demand', 'Hàng hóa tăng rộng cùng lúc với Cổ Phiếu — dấu hiệu cầu thực đang kéo giá.', null, 'trung bình');
  }

  // ---- VIỆT NAM (SBV) ----
  const prevFile = await readFile(new URL('../data/market.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);
  const histUrl = new URL('../data/vn-history.json', import.meta.url);
  const history = await readFile(histUrl, 'utf8').then(JSON.parse).catch(() => []);
  let vn = { ok: false };
  try{
    const rates = await fetchSbvRates();   // tuần tự, không song song — tránh bị tường lửa coi là bot
    const credit = await fetchSbvCredit();
    vn = { ok: true, fetchedAt: new Date().toISOString(), rates, credit };
    // Lưu lịch sử mỗi ngày (1 bản ghi/ngày) — cần để biết SBV vừa TĂNG hay GIẢM khi lãi suất điều hành đổi, và để
    // sau này đọc xu hướng lãi suất liên ngân hàng
    const today = new Date().toISOString().slice(0, 10);
    const rec = { date: today, refi: rates.refi.value, refiSince: rates.refi.since, rediscount: rates.rediscount ? rates.rediscount.value : null,
                  ibDate: rates.interbank.date, ibOvernight: rates.interbank.overnight ?? null, ibW1: rates.interbank.w1 ?? null, ibM3: rates.interbank.m3 ?? null,
                  creditMonth: credit.month, creditYoy: credit.yoy };
    const idx = history.findIndex(h => h.date === today);
    if(idx >= 0) history[idx] = rec; else history.push(rec);
    history.sort((a, b) => a.date.localeCompare(b.date));
    await mkdir(new URL('../data/', import.meta.url), { recursive: true });
    await writeFile(histUrl, JSON.stringify(history, null, 1) + '\n');
  }catch(e){
    errors.push(e.message);
    // Giữ số liệu VN lần trước, đánh dấu cũ
    if(prevFile && prevFile.vn && prevFile.vn.ok) vn = { ...prevFile.vn, stale: true, staleReason: e.message };
  }
  if(vn.ok){
    const { rates, credit } = vn;
    const staleNote = vn.stale ? ` ⚠ Không tải được SBV lần này (${vn.staleReason}) — đang dùng số liệu lấy lúc ${vn.fetchedAt.slice(0, 10)}.` : '';
    const conf = vn.stale ? 'thấp' : 'cao';
    const creditMonthVi = `${credit.month.slice(5)}/${credit.month.slice(0, 4)}`;
    put('vnCreditInputs', { creditYoy: credit.yoy, policyRate: rates.refi.value },
      `Dư nợ tín dụng toàn nền kinh tế tháng ${creditMonthVi}: ${Math.round(credit.total).toLocaleString('vi-VN')} tỷ đồng, tăng ${credit.yoy}% so với cùng kỳ (${credit.ytd}% từ đầu năm). Lãi suất điều hành (tái cấp vốn) ${rates.refi.value}%.${staleNote}`,
      credit.date, conf);
    // Chu kỳ SBV: tái cấp vốn đổi trong 12 tháng qua thì so với giá trị trước đó (trong lịch sử đã lưu); không đổi
    // hơn 12 tháng thì "Bình Thường"
    const daysSince = (Date.now() - new Date(rates.refi.since)) / 864e5;
    const ibText = rates.interbank.w1 != null ? ` Liên ngân hàng ngày ${viDate(rates.interbank.date || '')}: qua đêm ${rates.interbank.overnight}%, 1 tuần ${rates.interbank.w1}%, 3 tháng ${rates.interbank.m3}%.` : '';
    if(daysSince > 365){
      put('vnRateCycle', 'normal', `Lãi suất tái cấp vốn giữ nguyên ${rates.refi.value}% từ ${viDate(rates.refi.since)} (${Math.floor(daysSince / 30)} tháng) — chưa có chu kỳ tăng/giảm chính thức.${ibText}${staleNote}`, rates.refi.since, conf);
    } else {
      const before = [...history].reverse().find(h => h.refi != null && h.refi !== rates.refi.value);
      if(before) put('vnRateCycle', rates.refi.value > before.refi ? 'hiking' : 'cutting',
        `SBV ${rates.refi.value > before.refi ? 'TĂNG' : 'GIẢM'} lãi suất tái cấp vốn từ ${before.refi}% ${rates.refi.value > before.refi ? 'lên' : 'xuống'} ${rates.refi.value}% (áp dụng từ ${viDate(rates.refi.since)}).${ibText}${staleNote}`, rates.refi.since, conf);
    }
  }

  // Quá nhiều chuỗi lỗi — dừng TRƯỚC khi ghi, để không đè file cũ đầy đủ bằng một file thiếu
  if(Object.keys(data).length < Object.keys(SERIES).length / 2){
    console.error('Lỗi quá nhiều, giữ nguyên data/market.json cũ:', errors.join('; '));
    process.exit(1);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'FRED — Federal Reserve Bank of St. Louis (fred.stlouisfed.org)',
    thresholds: TH,
    series: Object.fromEntries(Object.keys(SERIES).filter(id => data[id]).map(id => [id, data[id]]).map(([id, s]) => [id, { label: SERIES[id], date: last(s).date, value: last(s).value }])),
    suggestions: sug,
    vn,
    errors,
  };
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/market.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Đã ghi ${Object.keys(sug).length} đề xuất từ ${Object.keys(data).length}/${Object.keys(SERIES).length} chuỗi số liệu.`);
  if(errors.length) console.warn('Lỗi:', errors.join('; '));
}

main().catch(e => { console.error(e); process.exit(1); });
