// Tải số liệu công khai từ FRED (Fed St. Louis) và tính ĐỀ XUẤT cho các ô chọn của app liên thị trường.
// Chạy hằng ngày bởi GitHub Actions (.github/workflows/update-market.yml), ghi ra data/market.json.
// Trang web chỉ ĐỌC file này và hiện đề xuất kèm nút "Áp dụng" — không bao giờ tự ghi đè lựa chọn của người dùng.
//
// Chạy tay:  node scripts/fetch-market.mjs
// Không cần thư viện ngoài, không cần API key (dùng endpoint CSV công khai fredgraph.csv).

import { writeFile, mkdir } from 'node:fs/promises';

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

  // Quá nhiều chuỗi lỗi — dừng TRƯỚC khi ghi, để không đè file cũ đầy đủ bằng một file thiếu
  if(Object.keys(data).length < Object.keys(SERIES).length / 2){
    console.error('Lỗi quá nhiều, giữ nguyên data/market.json cũ:', errors.join('; '));
    process.exit(1);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'FRED — Federal Reserve Bank of St. Louis (fred.stlouisfed.org)',
    thresholds: TH,
    series: Object.fromEntries(Object.entries(data).map(([id, s]) => [id, { label: SERIES[id], date: last(s).date, value: last(s).value }])),
    suggestions: sug,
    errors,
  };
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/market.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Đã ghi ${Object.keys(sug).length} đề xuất từ ${Object.keys(data).length}/${Object.keys(SERIES).length} chuỗi số liệu.`);
  if(errors.length) console.warn('Lỗi:', errors.join('; '));
}

main().catch(e => { console.error(e); process.exit(1); });
