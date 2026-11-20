(() => {
  'use strict';

  const STORAGE_KEY = 'pipnote_fx_journal_v1';

  const CURRENCY_CONFIG = {
    USD: { symbol: '$', locale: 'en-US', decimals: 2 },
    IDR: { symbol: 'Rp ', locale: 'id-ID', decimals: 0 },
    EUR: { symbol: '€', locale: 'de-DE', decimals: 2 },
    USC: { symbol: '¢', locale: 'en-US', decimals: 2 }
  };

  /** @type {{ account: { currency: string, initialBalance: number, depositAdjust: number, manualFloating: number }, trades: Array<any>, isDemo: boolean }} */
  let state = loadState();
  let activeDetailTradeId = null;

  // ---------- Utility & Formatters ----------
  function uid() {
    return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isSafeHttpUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function formatCurrency(amount, showSign = false) {
    const cfg = CURRENCY_CONFIG[state.account.currency] || CURRENCY_CONFIG.USD;
    const num = Number(amount) || 0;
    const absFormatted = Math.abs(num).toLocaleString(cfg.locale, {
      minimumFractionDigits: cfg.decimals,
      maximumFractionDigits: cfg.decimals
    });
    if (num < 0) return `-${cfg.symbol}${absFormatted}`;
    if (showSign && num > 0) return `+${cfg.symbol}${absFormatted}`;
    return `${cfg.symbol}${absFormatted}`;
  }

  function getPipMeta(pairRaw) {
    const pair = String(pairRaw || '').toUpperCase().replace(/\s+/g, '');
    if (pair.includes('JPY')) return { pipSize: 0.01, decimals: 3 };
    if (pair.includes('XAU') || pair.includes('GOLD')) return { pipSize: 0.1, decimals: 2 };
    if (pair.includes('XAG') || pair.includes('SILVER')) return { pipSize: 0.01, decimals: 3 };
    if (/(US30|NAS|SPX|NDX|DJI|BTC|ETH|GER|UK100)/.test(pair)) return { pipSize: 1, decimals: 2 };
    return { pipSize: 0.0001, decimals: 5 };
  }

  function formatPrice(value, pair) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    const { decimals } = getPipMeta(pair);
    return num.toFixed(decimals);
  }

  function calcPipMetrics(pair, entry, sl, tp) {
    const { pipSize } = getPipMeta(pair);
    const e = Number(entry);
    const s = Number(sl);
    const t = Number(tp);
    const slPips = Number.isFinite(e) && Number.isFinite(s) && e > 0 && s > 0 ? Math.abs(e - s) / pipSize : 0;
    const tpPips = Number.isFinite(e) && Number.isFinite(t) && e > 0 && t > 0 ? Math.abs(t - e) / pipSize : 0;
    const rr = slPips > 0 ? tpPips / slPips : 0;
    return { slPips, tpPips, rr };
  }

  /**
   * Estimate signed P/L in the account currency from pair, direction, lot, entry and target price.
   */
  function estimateMoneyPnl({ pair, direction, lot, entry, targetPrice }) {
    const clean = String(pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const lotNum = Number(lot);
    const e = Number(entry);
    const t = Number(targetPrice);
    if (!clean || !Number.isFinite(lotNum) || lotNum <= 0 || !Number.isFinite(e) || !Number.isFinite(t) || e <= 0 || t <= 0) {
      return null;
    }

    const diff = direction === 'SELL' ? (e - t) : (t - e);
    let usdPnl = 0;

    if (clean.includes('XAU') || clean.includes('GOLD')) {
      usdPnl = diff * lotNum * 100;
    } else if (clean.includes('XAG') || clean.includes('SILVER')) {
      usdPnl = diff * lotNum * 5000;
    } else if (/(US30|NAS|SPX|NDX|DJI|GER|UK100|BTC|ETH)/.test(clean)) {
      usdPnl = diff * lotNum;
    } else if (clean.endsWith('USD') && clean.length === 6) {
      usdPnl = diff * lotNum * 100000;
    } else if (clean.startsWith('USD') && clean.length === 6) {
      usdPnl = (diff / t) * lotNum * 100000;
    } else if (clean.endsWith('JPY')) {
      usdPnl = (diff / 150) * lotNum * 100000;
    } else {
      usdPnl = diff * lotNum * 100000;
    }

    const curr = state.account.currency;
    const rate = curr === 'IDR' ? 16000 : curr === 'EUR' ? 0.92 : 1; // USC cent-lot already yields cents directly
    const decimals = (CURRENCY_CONFIG[curr] || CURRENCY_CONFIG.USD).decimals;
    return Number((usdPnl * rate).toFixed(decimals));
  }

  function formatDateShort(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatTimeShort(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  function toDatetimeLocalValue(dateObj) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
  }

  function showToast(message, variant = 'mint') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${variant === 'coral' ? 'toast-coral' : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s ease';
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  // ---------- Default Demo Data & Persistence ----------
  function createDemoState() {
    const now = new Date();
    const daysAgo = (d, h = 14) => {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      dt.setHours(h, 30, 0, 0);
      return toDatetimeLocalValue(dt);
    };

    return {
      isDemo: true,
      account: {
        currency: 'USD',
        initialBalance: 1000,
        depositAdjust: 0,
        manualFloating: 0
      },
      trades: [
        {
          id: uid(),
          date: daysAgo(12, 15),
          pair: 'EUR/USD',
          direction: 'BUY',
          lot: 0.10,
          entry: 1.08150,
          sl: 1.07950,
          tp: 1.08750,
          exitPrice: 1.08750,
          entryDistanceManual: null,
          timeframe: 'M15',
          session: 'London',
          status: 'WIN',
          pnl: 60.00,
          setupTag: 'Supply & Demand',
          reason: 'Harga pullback ke area Demand H1, muncul bullish engulfing di M15 dengan sweep liquidity low Asia.',
          notes: 'Eksekusi rapi sesuai trading plan.',
          chartUrl: ''
        },
        {
          id: uid(),
          date: daysAgo(9, 20),
          pair: 'XAU/USD',
          direction: 'SELL',
          lot: 0.05,
          entry: 2658.50,
          sl: 2663.50,
          tp: 2643.50,
          exitPrice: 2663.50,
          entryDistanceManual: null,
          timeframe: 'M15',
          session: 'New York',
          status: 'LOSS',
          pnl: -25.00,
          setupTag: 'SMC / Order Block',
          reason: 'Entry sell di supply zone NY open, tetapi momentum news USD mendorong harga tembus SL.',
          notes: 'SL terjaga ketat 50 pips, tidak geser SL.',
          chartUrl: ''
        },
        {
          id: uid(),
          date: daysAgo(7, 14),
          pair: 'GBP/JPY',
          direction: 'BUY',
          lot: 0.10,
          entry: 191.200,
          sl: 190.850,
          tp: 192.250,
          exitPrice: 192.250,
          entryDistanceManual: null,
          timeframe: 'H1',
          session: 'London',
          status: 'WIN',
          pnl: 78.40,
          setupTag: 'Break & Retest',
          reason: 'Breakout resistance minor London open lalu retest sempurna dengan rejection wick panjang.',
          notes: 'TP hit penuh 1:3 RR.',
          chartUrl: ''
        },
        {
          id: uid(),
          date: daysAgo(5, 16),
          pair: 'EUR/USD',
          direction: 'SELL',
          lot: 0.12,
          entry: 1.09100,
          sl: 1.09300,
          tp: 1.08500,
          exitPrice: 1.09100,
          entryDistanceManual: null,
          timeframe: 'M30',
          session: 'Overlap',
          status: 'BE',
          pnl: 0,
          setupTag: 'Trendline Bounce',
          reason: 'Rejection trendline bearish H4, harga sempat jalan +18 pips lalu kembali ke entry.',
          notes: 'SL digeser ke BE setelah +15 pips.',
          chartUrl: ''
        },
        {
          id: uid(),
          date: daysAgo(3, 21),
          pair: 'XAU/USD',
          direction: 'BUY',
          lot: 0.08,
          entry: 2642.00,
          sl: 2637.00,
          tp: 2657.00,
          exitPrice: 2657.00,
          entryDistanceManual: null,
          timeframe: 'M15',
          session: 'New York',
          status: 'WIN',
          pnl: 120.00,
          setupTag: 'SMC / Order Block',
          reason: 'Change of Character (ChoCH) bullish setelah sweep low harian, entry di FVG + Order Block.',
          notes: 'Setup A+ sangat sabar menunggu konfirmasi.',
          chartUrl: ''
        },
        {
          id: uid(),
          date: daysAgo(1, 15),
          pair: 'GBP/USD',
          direction: 'BUY',
          lot: 0.10,
          entry: 1.29400,
          sl: 1.29150,
          tp: 1.30150,
          exitPrice: null,
          entryDistanceManual: null,
          timeframe: 'H1',
          session: 'London',
          status: 'OPEN',
          pnl: 24.50,
          setupTag: 'Support & Resistance',
          reason: 'Bounce dari support kuat H4 sejalan dengan struktur uptrend mingguan.',
          notes: 'Masih running +24.5 pips, SL masih di posisi awal.',
          chartUrl: ''
        }
      ]
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const demo = createDemoState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(demo));
        return demo;
      }
      const parsed = JSON.parse(raw);
      return {
        isDemo: Boolean(parsed.isDemo),
        account: {
          currency: parsed.account?.currency || 'USD',
          initialBalance: Number(parsed.account?.initialBalance) || 0,
          depositAdjust: Number(parsed.account?.depositAdjust) || 0,
          manualFloating: Number(parsed.account?.manualFloating) || 0
        },
        trades: Array.isArray(parsed.trades) ? parsed.trades : []
      };
    } catch {
      return createDemoState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      showToast('Penyimpanan browser penuh! Hapus beberapa screenshot lama atau backup JSON.', 'coral');
      return false;
    }
  }

  // ---------- Analytics Engine ----------
  function computeAnalytics() {
    const baseCapital = (Number(state.account.initialBalance) || 0) + (Number(state.account.depositAdjust) || 0);

    // Sort chronologically ascending for balance/equity progression
    const chronoTrades = [...state.trades].sort((a, b) => new Date(a.date) - new Date(b.date));

    let runningBalance = baseCapital;
    let floatingOpenPnl = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let breakevens = 0;
    let openCount = 0;
    let bestTrade = 0;
    let worstTrade = 0;
    let rrSum = 0;
    let rrCount = 0;

    let peakBalance = baseCapital;
    let maxDrawdownPct = 0;

    const pairMap = new Map();
    const curvePoints = [
      {
        label: 'Modal Awal',
        pair: 'Start',
        pnl: 0,
        balance: runningBalance,
        equity: runningBalance
      }
    ];

    const enrichedById = new Map();

    chronoTrades.forEach((tr, idx) => {
      const metrics = calcPipMetrics(tr.pair, tr.entry, tr.sl, tr.tp);
      const signedPnl = normalizePnlByStatus(tr.status, tr.pnl);

      if (tr.status === 'OPEN') {
        openCount += 1;
        floatingOpenPnl += signedPnl;
      } else {
        runningBalance += signedPnl;
        if (tr.status === 'WIN') {
          wins += 1;
          grossProfit += Math.max(0, signedPnl);
          if (signedPnl > bestTrade) bestTrade = signedPnl;
        } else if (tr.status === 'LOSS') {
          losses += 1;
          grossLoss += Math.abs(Math.min(0, signedPnl));
          if (signedPnl < worstTrade) worstTrade = signedPnl;
        } else {
          breakevens += 1;
        }

        if (runningBalance > peakBalance) {
          peakBalance = runningBalance;
        } else if (peakBalance > 0) {
          const dd = ((peakBalance - runningBalance) / peakBalance) * 100;
          if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }

        curvePoints.push({
          label: `#${idx + 1} ${tr.pair}`,
          date: formatDateShort(tr.date),
          pair: tr.pair,
          pnl: signedPnl,
          balance: runningBalance,
          equity: runningBalance
        });
      }

      if (metrics.rr > 0) {
        rrSum += metrics.rr;
        rrCount += 1;
      }

      // Per-pair aggregation (closed trades only for realized stats, count all)
      const pairKey = String(tr.pair || 'UNKNOWN').toUpperCase();
      if (!pairMap.has(pairKey)) {
        pairMap.set(pairKey, { pair: pairKey, total: 0, wins: 0, losses: 0, netPnl: 0 });
      }
      const pStat = pairMap.get(pairKey);
      pStat.total += 1;
      if (tr.status !== 'OPEN') {
        pStat.netPnl += signedPnl;
        if (tr.status === 'WIN') pStat.wins += 1;
        if (tr.status === 'LOSS') pStat.losses += 1;
      }

      enrichedById.set(tr.id, {
        ...tr,
        signedPnl,
        slPips: metrics.slPips,
        tpPips: metrics.tpPips,
        rr: metrics.rr,
        balanceAfter: runningBalance,
        equityAtPoint: runningBalance + (tr.status === 'OPEN' ? signedPnl : 0)
      });
    });

    const manualFloating = Number(state.account.manualFloating) || 0;
    const totalFloating = floatingOpenPnl + manualFloating;
    const currentBalance = runningBalance;
    const currentEquity = currentBalance + totalFloating;
    const netPnl = grossProfit - grossLoss;
    const decidedCount = wins + losses;
    const winrate = decidedCount > 0 ? (wins / decidedCount) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.99 : 0);
    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const avgRR = rrCount > 0 ? rrSum / rrCount : 0;
    const growthPct = baseCapital > 0 ? ((currentBalance - baseCapital) / baseCapital) * 100 : 0;

    // Add live equity endpoint if floating is non-zero
    if (totalFloating !== 0 && curvePoints.length > 0) {
      curvePoints.push({
        label: 'Equity Live',
        date: 'Sekarang',
        pair: `${openCount} Open`,
        pnl: totalFloating,
        balance: currentBalance,
        equity: currentEquity,
        isLiveEquity: true
      });
    }

    const pairStats = [...pairMap.values()].sort((a, b) => b.total - a.total || b.netPnl - a.netPnl);

    return {
      baseCapital,
      currentBalance,
      currentEquity,
      totalFloating,
      growthPct,
      netPnl,
      grossProfit,
      grossLoss,
      wins,
      losses,
      breakevens,
      openCount,
      totalTrades: state.trades.length,
      decidedCount,
      winrate,
      profitFactor,
      avgWin,
      avgLoss,
      avgRR,
      bestTrade,
      worstTrade,
      maxDrawdownPct,
      curvePoints,
      pairStats,
      enrichedById
    };
  }

  function normalizePnlByStatus(status, rawPnl) {
    const val = Number(rawPnl) || 0;
    if (status === 'WIN') return Math.abs(val);
    if (status === 'LOSS') return -Math.abs(val);
    if (status === 'BE') return 0;
    return val; // OPEN can be + or -
  }

  // ---------- Rendering ----------
  function renderAll() {
    const analytics = computeAnalytics();

    // Demo banner
    document.getElementById('demoBanner').hidden = !state.isDemo;

    // Primary KPIs
    document.getElementById('kpiBalance').textContent = formatCurrency(analytics.currentBalance);
    document.getElementById('kpiInitialBalance').textContent = formatCurrency(analytics.baseCapital);

    const growthBadge = document.getElementById('kpiGrowthBadge');
    const growthSign = analytics.growthPct > 0 ? '+' : '';
    growthBadge.textContent = `${growthSign}${analytics.growthPct.toFixed(1)}%`;
    growthBadge.className = `kpi-pill ${analytics.growthPct < 0 ? 'negative' : ''}`;

    document.getElementById('kpiEquity').textContent = formatCurrency(analytics.currentEquity);
    document.getElementById('kpiOpenCountTag').textContent = `${analytics.openCount} Open`;

    const floatingEl = document.getElementById('kpiFloating');
    floatingEl.textContent = formatCurrency(analytics.totalFloating, true);
    floatingEl.className = `mono ${analytics.totalFloating >= 0 ? 'text-mint-dark' : 'text-coral-dark'}`;
    document.getElementById('kpiEquityNote').textContent =
      analytics.totalFloating === 0 ? 'Sama dgn Balance' : 'Termasuk Floating';

    document.getElementById('kpiWinrate').textContent = `${analytics.winrate.toFixed(1)}%`;
    document.getElementById('kpiTotalTradesTag').textContent = `${analytics.totalTrades} Trade`;
    document.getElementById('kpiWinsCount').textContent = analytics.wins;
    document.getElementById('kpiLossesCount').textContent = analytics.losses;
    document.getElementById('kpiBeCount').textContent = analytics.breakevens;

    const totalDecidedOrAll = analytics.wins + analytics.losses;
    const winPctBar = totalDecidedOrAll > 0 ? (analytics.wins / totalDecidedOrAll) * 100 : 0;
    const lossPctBar = totalDecidedOrAll > 0 ? (analytics.losses / totalDecidedOrAll) * 100 : 0;
    document.getElementById('winrateBarWin').style.width = `${winPctBar}%`;
    document.getElementById('winrateBarLoss').style.width = `${lossPctBar}%`;

    const netEl = document.getElementById('kpiNetPnl');
    netEl.textContent = formatCurrency(analytics.netPnl, true);
    netEl.className = `kpi-value mono ${analytics.netPnl >= 0 ? 'text-mint-dark' : 'text-coral-dark'}`;
    document.getElementById('kpiProfitFactorTag').textContent =
      analytics.profitFactor >= 99 ? 'PF: ∞' : `PF: ${analytics.profitFactor.toFixed(2)}`;
    document.getElementById('kpiGrossProfit').textContent = formatCurrency(analytics.grossProfit, true);
    document.getElementById('kpiGrossLoss').textContent = formatCurrency(-analytics.grossLoss);

    // Secondary strip
    document.getElementById('statAvgWin').textContent = formatCurrency(analytics.avgWin, analytics.avgWin > 0);
    document.getElementById('statAvgLoss').textContent = formatCurrency(-analytics.avgLoss);
    document.getElementById('statAvgRR').textContent = `1 : ${analytics.avgRR.toFixed(2)}`;
    document.getElementById('statBestTrade').textContent = formatCurrency(analytics.bestTrade, analytics.bestTrade > 0);
    document.getElementById('statWorstTrade').textContent = formatCurrency(analytics.worstTrade);
    document.getElementById('statMaxDD').textContent = `${analytics.maxDrawdownPct.toFixed(1)}%`;

    // Mobile topbar & account panel sync
    document.getElementById('mobileTopWinrate').textContent = `${analytics.winrate.toFixed(1)}%`;
    const navBadge = document.getElementById('mobileNavJournalBadge');
    navBadge.textContent = analytics.totalTrades > 99 ? '99+' : String(analytics.totalTrades);
    navBadge.hidden = analytics.totalTrades === 0;
    document.getElementById('mobileAccCurrencyBadge').textContent = state.account.currency;
    document.getElementById('mobileAccInitial').textContent = formatCurrency(analytics.baseCapital);
    document.getElementById('mobileAccBalance').textContent = formatCurrency(analytics.currentBalance);
    document.getElementById('mobileAccEquity').textContent = formatCurrency(analytics.currentEquity);

    // Charts & Filters & Table
    renderEquityChart(analytics.curvePoints);
    renderWinLossDonut(analytics);
    renderPairBreakdown(analytics.pairStats);
    populatePairFilter();
    renderJournalList(analytics);
  }

  function renderEquityChart(points) {
    const container = document.getElementById('equityChartContainer');
    if (!points || points.length <= 1) {
      container.innerHTML = `
        <div style="height:210px;display:grid;place-items:center;color:var(--ink-muted);font-size:0.86rem;text-align:center;">
          Catat minimal 1 trade tertutup (Win/Loss/BE) untuk menampilkan kurva pertumbuhan Balance &amp; Equity.
        </div>`;
      return;
    }

    const width = 680;
    const height = 230;
    const pad = { top: 20, right: 20, bottom: 30, left: 66 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const values = points.flatMap((p) => [p.balance, p.equity]);
    let minVal = Math.min(...values);
    let maxVal = Math.max(...values);
    if (minVal === maxVal) {
      minVal -= 50;
      maxVal += 50;
    } else {
      const margin = (maxVal - minVal) * 0.14;
      minVal -= margin;
      maxVal += margin;
    }

    const xAt = (i) => pad.left + (i / Math.max(1, points.length - 1)) * plotW;
    const yAt = (v) => pad.top + ((maxVal - v) / (maxVal - minVal)) * plotH;

    // Grid lines (4 steps)
    let gridSvg = '';
    for (let g = 0; g <= 3; g++) {
      const ratio = g / 3;
      const val = maxVal - ratio * (maxVal - minVal);
      const y = pad.top + ratio * plotH;
      gridSvg += `
        <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#EFE4C7" stroke-dasharray="4 4" />
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="#7C878E" font-size="11" font-family="JetBrains Mono, monospace">${escapeHtml(formatCompactMoney(val))}</text>
      `;
    }

    // Balance points (exclude live equity point if present for solid line, then connect equity)
    const closedPts = points.filter((p) => !p.isLiveEquity);
    const livePt = points.find((p) => p.isLiveEquity);

    const balLineD = closedPts
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(idx).toFixed(1)} ${yAt(p.balance).toFixed(1)}`)
      .join(' ');

    const lastClosedIdx = closedPts.length - 1;
    const areaD =
      `${balLineD} L ${xAt(lastClosedIdx).toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${xAt(0).toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;

    let liveSegmentSvg = '';
    if (livePt && closedPts.length > 0) {
      const prevIdx = closedPts.length - 1;
      const liveIdx = points.length - 1;
      liveSegmentSvg = `
        <line x1="${xAt(prevIdx).toFixed(1)}" y1="${yAt(closedPts[prevIdx].balance).toFixed(1)}"
              x2="${xAt(liveIdx).toFixed(1)}" y2="${yAt(livePt.equity).toFixed(1)}"
              stroke="#D9A31E" stroke-width="2.5" stroke-dasharray="5 4" />
      `;
    }

    const dotsSvg = points
      .map((p, idx) => {
        const yVal = p.isLiveEquity ? p.equity : p.balance;
        const fill = p.isLiveEquity ? '#FFE394' : (p.pnl < 0 ? '#F48F68' : '#8BDFDD');
        const stroke = p.isLiveEquity ? '#8E6900' : (p.pnl < 0 ? '#B64219' : '#106F6D');
        return `
          <circle class="chart-dot" data-idx="${idx}"
            cx="${xAt(idx).toFixed(1)}" cy="${yAt(yVal).toFixed(1)}" r="5"
            fill="${fill}" stroke="${stroke}" stroke-width="2" style="cursor:pointer" />
        `;
      })
      .join('');

    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="230" role="img" aria-label="Grafik Balance dan Equity">
        <defs>
          <linearGradient id="mintAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8BDFDD" stop-opacity="0.52" />
            <stop offset="100%" stop-color="#8BDFDD" stop-opacity="0.03" />
          </linearGradient>
        </defs>
        ${gridSvg}
        <path d="${areaD}" fill="url(#mintAreaGrad)" />
        <path d="${balLineD}" fill="none" stroke="#188C89" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
        ${liveSegmentSvg}
        ${dotsSvg}
        <text x="${pad.left}" y="${height - 6}" fill="#7C878E" font-size="11">Start</text>
        <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" fill="#7C878E" font-size="11">${points.length - 1} Langkah</text>
      </svg>
      <div class="chart-tooltip" id="chartTooltip" hidden></div>
    `;

    const tooltip = container.querySelector('#chartTooltip');
    const showDotTooltip = (dot) => {
      const idx = Number(dot.getAttribute('data-idx'));
      const pt = points[idx];
      const val = pt.isLiveEquity ? pt.equity : pt.balance;
      const pnlText = idx === 0 ? 'Modal Awal' : `P/L: ${formatCurrency(pt.pnl, true)}`;
      tooltip.innerHTML = `<strong>${escapeHtml(pt.label)}</strong><br>${escapeHtml(pnlText)} &bull; Saldo: ${escapeHtml(formatCurrency(val))}`;
      tooltip.hidden = false;
      const rect = container.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const rawLeft = dotRect.left - rect.left + dotRect.width / 2;
      const clampedLeft = Math.max(76, Math.min(rect.width - 76, rawLeft));
      tooltip.style.left = `${clampedLeft}px`;
      tooltip.style.top = `${dotRect.top - rect.top}px`;
    };

    container.querySelectorAll('.chart-dot').forEach((dot) => {
      dot.addEventListener('mouseenter', () => showDotTooltip(dot));
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        showDotTooltip(dot);
      });
      dot.addEventListener('mouseleave', () => {
        tooltip.hidden = true;
      });
    });
  }

  function formatCompactMoney(val) {
    const cfg = CURRENCY_CONFIG[state.account.currency] || CURRENCY_CONFIG.USD;
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return `${sign}${cfg.symbol}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 10_000) return `${sign}${cfg.symbol}${(abs / 1_000).toFixed(1)}k`;
    return `${sign}${cfg.symbol}${abs.toFixed(cfg.decimals === 0 ? 0 : 0)}`;
  }

  function renderWinLossDonut(analytics) {
    const container = document.getElementById('winLossDonutContainer');
    const total = analytics.wins + analytics.losses + analytics.breakevens;
    const size = 124;
    const stroke = 16;
    const radius = (size - stroke) / 2;
    const circ = 2 * Math.PI * radius;

    if (total === 0) {
      container.innerHTML = `
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#EFE6CE" stroke-width="${stroke}" />
          <text x="50%" y="52%" text-anchor="middle" font-size="14" font-weight="700" fill="#7C878E">0%</text>
        </svg>
        <span class="muted" style="font-size:0.76rem">Belum ada hasil</span>
      `;
      return;
    }

    const winLen = (analytics.wins / total) * circ;
    const lossLen = (analytics.losses / total) * circ;
    const beLen = (analytics.breakevens / total) * circ;

    container.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <g transform="rotate(-90 ${size / 2} ${size / 2})">
          <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#EFE6CE" stroke-width="${stroke}" />
          <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#8BDFDD" stroke-width="${stroke}"
            stroke-dasharray="${winLen} ${circ}" stroke-dashoffset="0" />
          <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#F48F68" stroke-width="${stroke}"
            stroke-dasharray="${lossLen} ${circ}" stroke-dashoffset="${-winLen}" />
          <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#FFE394" stroke-width="${stroke}"
            stroke-dasharray="${beLen} ${circ}" stroke-dashoffset="${-(winLen + lossLen)}" />
        </g>
        <text x="50%" y="49%" text-anchor="middle" font-size="16" font-weight="800" fill="#1F262A" font-family="JetBrains Mono, monospace">${analytics.winrate.toFixed(0)}%</text>
        <text x="50%" y="65%" text-anchor="middle" font-size="10" font-weight="600" fill="#7C878E">Winrate</text>
      </svg>
      <div style="display:flex;gap:10px;font-size:0.74rem;color:var(--ink-secondary);font-weight:600">
        <span><span class="dot dot-mint"></span> ${analytics.wins}W</span>
        <span><span class="dot dot-coral"></span> ${analytics.losses}L</span>
        <span><span class="dot dot-gold"></span> ${analytics.breakevens}BE</span>
      </div>
    `;
  }

  function renderPairBreakdown(pairStats) {
    const container = document.getElementById('pairBreakdownContainer');
    if (!pairStats || pairStats.length === 0) {
      container.innerHTML = `<div class="muted" style="font-size:0.82rem;">Statistik per pair akan tampil di sini.</div>`;
      return;
    }

    const topPairs = pairStats.slice(0, 4);
    const maxAbs = Math.max(1, ...topPairs.map((p) => Math.abs(p.netPnl)));

    container.innerHTML = topPairs
      .map((p) => {
        const wr = p.wins + p.losses > 0 ? Math.round((p.wins / (p.wins + p.losses)) * 100) : 0;
        const pct = Math.min(100, Math.max(8, (Math.abs(p.netPnl) / maxAbs) * 100));
        const isPos = p.netPnl >= 0;
        return `
          <div class="pair-bar-row">
            <div class="pair-bar-meta">
              <span>${escapeHtml(p.pair)} <span class="muted">(${p.total}x &bull; WR ${wr}%)</span></span>
              <span class="mono ${isPos ? 'text-mint-dark' : 'text-coral-dark'}">${escapeHtml(formatCurrency(p.netPnl, true))}</span>
            </div>
            <div class="pair-bar-track">
              <div class="pair-bar-fill" style="width:${pct}%;background:${isPos ? 'var(--palette-mint)' : 'var(--palette-coral)'}"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function populatePairFilter() {
    const select = document.getElementById('filterPair');
    const prev = select.value;
    const pairs = [...new Set(state.trades.map((t) => String(t.pair || '').toUpperCase()).filter(Boolean))].sort();
    select.innerHTML = `<option value="ALL">Semua Pair</option>` +
      pairs.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    if (pairs.includes(prev)) select.value = prev;
  }

  function getFilteredTrades(analytics) {
    const search = document.getElementById('filterSearch').value.trim().toLowerCase();
    const pairFilter = document.getElementById('filterPair').value;
    const dirFilter = document.getElementById('filterDirection').value;
    const statusFilter = document.getElementById('filterStatus').value;

    const list = [...state.trades]
      .map((tr) => analytics.enrichedById.get(tr.id))
      .filter(Boolean)
      .sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first

    return list.filter((tr) => {
      if (pairFilter !== 'ALL' && tr.pair.toUpperCase() !== pairFilter) return false;
      if (dirFilter !== 'ALL' && tr.direction !== dirFilter) return false;
      if (statusFilter !== 'ALL' && tr.status !== statusFilter) return false;
      if (search) {
        const hay = `${tr.pair} ${tr.reason} ${tr.notes || ''} ${tr.setupTag || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function statusBadgeHtml(status) {
    if (status === 'WIN') return `<span class="badge badge-mint">WIN</span>`;
    if (status === 'LOSS') return `<span class="badge badge-coral">LOSS</span>`;
    if (status === 'BE') return `<span class="badge badge-neutral">BE</span>`;
    return `<span class="badge badge-gold">OPEN</span>`;
  }

  function renderJournalList(analytics) {
    const filtered = getFilteredTrades(analytics);
    const tbody = document.getElementById('journalTableBody');
    const mobileList = document.getElementById('mobileTradeList');
    const emptyState = document.getElementById('emptyState');

    document.getElementById('filteredCountBadge').textContent = `${filtered.length} catatan`;

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      mobileList.innerHTML = '';
      emptyState.hidden = false;
      return;
    }

    emptyState.hidden = true;

    tbody.innerHTML = filtered
      .map((tr) => {
        const pnlClass = tr.signedPnl > 0 ? 'text-mint-dark' : tr.signedPnl < 0 ? 'text-coral-dark' : 'muted';
        const dirBadge = tr.direction === 'BUY' ? 'badge-soft-mint' : 'badge-soft-coral';
        const distManualHtml =
          tr.entryDistanceManual != null && tr.entryDistanceManual !== ''
            ? `<span class="cell-sub">Jarak: ${Number(tr.entryDistanceManual).toFixed(1)} pips</span>`
            : `<span class="cell-sub">SL ${tr.slPips.toFixed(1)}p &bull; TP ${tr.tpPips.toFixed(1)}p</span>`;

        return `
          <tr data-trade-id="${escapeHtml(tr.id)}">
            <td>
              <span class="cell-pair">${escapeHtml(tr.pair.toUpperCase())}</span>
              <span class="cell-sub">${escapeHtml(formatDateShort(tr.date))} ${escapeHtml(formatTimeShort(tr.date))}</span>
            </td>
            <td>
              <span class="badge ${dirBadge}">${escapeHtml(tr.direction)}</span>
              <span class="cell-sub mono">${Number(tr.lot).toFixed(2)} lot &bull; ${escapeHtml(tr.timeframe || '-')}</span>
            </td>
            <td>
              <span class="mono" style="font-weight:600">${escapeHtml(formatPrice(tr.entry, tr.pair))}</span>
              ${distManualHtml}
            </td>
            <td>
              <span class="mono text-coral-dark">${escapeHtml(formatPrice(tr.sl, tr.pair))}</span>
              <span class="cell-sub mono">-${tr.slPips.toFixed(1)} pips</span>
            </td>
            <td>
              <span class="mono text-mint-dark">${escapeHtml(formatPrice(tr.tp, tr.pair))}</span>
              <span class="cell-sub mono">+${tr.tpPips.toFixed(1)} pips (1:${tr.rr.toFixed(1)})</span>
            </td>
            <td>
              <div class="reason-clamp" title="${escapeHtml(tr.reason)}">${escapeHtml(tr.reason)}</div>
              ${tr.setupTag ? `<span class="cell-sub">${escapeHtml(tr.setupTag)}</span>` : ''}
            </td>
            <td class="text-right">
              <div class="pnl-amount mono ${pnlClass}">${escapeHtml(formatCurrency(tr.signedPnl, true))}</div>
              <div style="margin-top:3px">${statusBadgeHtml(tr.status)}</div>
            </td>
            <td class="text-right">
              <span class="mono" style="font-weight:600">${escapeHtml(formatCurrency(tr.balanceAfter))}</span>
              <span class="cell-sub mono">Eq: ${escapeHtml(formatCurrency(tr.equityAtPoint))}</span>
            </td>
            <td class="text-center">
              <div class="row-actions">
                <button type="button" class="btn-table-action" data-action="edit" data-id="${escapeHtml(tr.id)}">Edit</button>
                <button type="button" class="btn-table-action delete" data-action="delete" data-id="${escapeHtml(tr.id)}">Hapus</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    mobileList.innerHTML = filtered
      .map((tr) => {
        const pnlClass = tr.signedPnl > 0 ? 'text-mint-dark' : tr.signedPnl < 0 ? 'text-coral-dark' : 'muted';
        const dirBadge = tr.direction === 'BUY' ? 'badge-soft-mint' : 'badge-soft-coral';
        const statusClass = `status-${String(tr.status || 'OPEN').toLowerCase()}`;
        const entrySub =
          tr.entryDistanceManual != null && tr.entryDistanceManual !== ''
            ? `${Number(tr.entryDistanceManual).toFixed(1)}p`
            : `1:${tr.rr.toFixed(1)}`;
        return `
          <article class="trade-mobile-card ${statusClass}" data-trade-id="${escapeHtml(tr.id)}">
            <div class="tmc-top">
              <div class="tmc-title-col">
                <div class="tmc-pair-row">
                  <strong class="tmc-pair">${escapeHtml(tr.pair.toUpperCase())}</strong>
                  <span class="badge ${dirBadge}">${escapeHtml(tr.direction)}</span>
                  <span class="tmc-lot mono">${Number(tr.lot).toFixed(2)}L</span>
                </div>
                <span class="tmc-date">${escapeHtml(formatDateShort(tr.date))} &bull; ${escapeHtml(tr.timeframe || '-')}</span>
              </div>
              <div class="tmc-pnl-col">
                <div class="mono pnl-amount ${pnlClass}">${escapeHtml(formatCurrency(tr.signedPnl, true))}</div>
                ${statusBadgeHtml(tr.status)}
              </div>
            </div>
            <div class="tmc-grid mono">
              <div class="tmc-item">
                <span>Entry (${entrySub})</span>
                <strong>${escapeHtml(formatPrice(tr.entry, tr.pair))}</strong>
              </div>
              <div class="tmc-item">
                <span>SL (-${tr.slPips.toFixed(0)}p)</span>
                <strong class="text-coral-dark">${escapeHtml(formatPrice(tr.sl, tr.pair))}</strong>
              </div>
              <div class="tmc-item">
                <span>TP (+${tr.tpPips.toFixed(0)}p)</span>
                <strong class="text-mint-dark">${escapeHtml(formatPrice(tr.tp, tr.pair))}</strong>
              </div>
            </div>
            <div class="tmc-reason">${escapeHtml(tr.reason)}</div>
            <div class="tmc-bottom">
              <span class="mono tmc-bal">Bal <strong>${escapeHtml(formatCurrency(tr.balanceAfter))}</strong> &bull; R:R 1:${tr.rr.toFixed(1)}</span>
              <div class="row-actions">
                <button type="button" class="btn-table-action" data-action="edit" data-id="${escapeHtml(tr.id)}">Edit</button>
                <button type="button" class="btn-table-action delete" data-action="delete" data-id="${escapeHtml(tr.id)}">Hapus</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // ---------- Modals & Forms ----------
  let confirmResolver = null;

  function openModal(id) {
    const el = document.getElementById(id);
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    el.hidden = true;
    if (id === 'confirmModal' && confirmResolver) {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(false);
    }
    if ([...document.querySelectorAll('.modal-backdrop')].every((m) => m.hidden)) {
      document.body.style.overflow = '';
    }
  }

  function showConfirmDialog({
    title = 'Apakah Anda yakin?',
    message = 'Tindakan ini tidak dapat dibatalkan.',
    note = '',
    confirmText = 'Ya, Lanjutkan',
    cancelText = 'Batal',
    variant = 'coral'
  }) {
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }

    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;

    const noteEl = document.getElementById('confirmModalNote');
    if (note) {
      noteEl.textContent = note;
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
    }

    const iconEl = document.getElementById('confirmModalIcon');
    iconEl.className = `confirm-icon ${variant === 'gold' ? 'is-gold' : ''}`;

    const acceptBtn = document.getElementById('btnConfirmAccept');
    const cancelBtn = document.getElementById('btnConfirmCancel');
    acceptBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    acceptBtn.className = `btn ${variant === 'gold' ? 'btn-secondary' : 'btn-primary'}`;

    openModal('confirmModal');
    acceptBtn.focus();

    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  let pnlManuallyEdited = false;
  let pendingScreenshotData = '';
  let tesseractPromise = null;

  function setScreenshotPreviewUI(dataUrl, statusText = 'Siap dipindai', badgeText = 'Siap', badgeClass = 'badge-gold') {
    const emptyEl = document.getElementById('ocrEmptyState');
    const previewEl = document.getElementById('ocrPreviewState');
    const imgEl = document.getElementById('ocrPreviewImg');
    const badgeEl = document.getElementById('ocrStatusBadge');
    const textEl = document.getElementById('ocrResultText');

    if (!dataUrl) {
      emptyEl.hidden = false;
      previewEl.hidden = true;
      imgEl.src = '';
      return;
    }

    emptyEl.hidden = true;
    previewEl.hidden = false;
    imgEl.src = dataUrl;
    badgeEl.textContent = badgeText;
    badgeEl.className = `badge ${badgeClass}`;
    textEl.textContent = statusText;
  }

  function ensureTesseractLoaded() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;

    tesseractPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.async = true;
      script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract unavailable')));
      script.onerror = () => {
        tesseractPromise = null;
        reject(new Error('Gagal memuat mesin OCR'));
      };
      document.head.appendChild(script);
    });
    return tesseractPromise;
  }

  function prepareOcrCanvasFromSrc(src, includeCompressed = false) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Format gambar tidak didukung'));
      img.onload = () => {
        let storedDataUrl = src;
        if (includeCompressed) {
          const maxStoreW = 960;
          const storeScale = img.width > maxStoreW ? maxStoreW / img.width : 1;
          const storeCanvas = document.createElement('canvas');
          storeCanvas.width = Math.round(img.width * storeScale);
          storeCanvas.height = Math.round(img.height * storeScale);
          storeCanvas.getContext('2d').drawImage(img, 0, 0, storeCanvas.width, storeCanvas.height);
          storedDataUrl = storeCanvas.toDataURL('image/jpeg', 0.74);
        }

        const ocrScale = img.width < 1200 ? 2 : 1;
        const ocrCanvas = document.createElement('canvas');
        ocrCanvas.width = Math.round(img.width * ocrScale);
        ocrCanvas.height = Math.round(img.height * ocrScale);
        const ctx = ocrCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0, ocrCanvas.width, ocrCanvas.height);

        const imgData = ctx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
        const data = imgData.data;
        let lumaSum = 0;
        for (let i = 0; i < data.length; i += 4) {
          lumaSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const isDark = (lumaSum / (data.length / 4)) < 120;

        for (let i = 0; i < data.length; i += 4) {
          let lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (isDark) lum = 255 - lum;
          lum = Math.max(0, Math.min(255, (lum - 128) * 1.35 + 128));
          data[i] = data[i + 1] = data[i + 2] = lum;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ storedDataUrl, ocrDataUrl: ocrCanvas.toDataURL('image/png') });
      };
      img.src = src;
    });
  }

  function processImageForStorageAndOcr(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Gagal membaca gambar'));
      reader.onload = () => {
        prepareOcrCanvasFromSrc(String(reader.result), true).then(resolve, reject);
      };
      reader.readAsDataURL(file);
    });
  }

  let bulkOcrRows = [];

  function normalizeOcrNumbers(raw) {
    // Strip thousand commas (e.g. 3,719.549 -> 3719.549) before converting lone decimal commas
    return String(raw || '')
      .replace(/[|]/g, ' ')
      .replace(/(\d),(\d{3})(?=\.\d|\D|$)/g, '$1$2')
      .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
  }

  function parseOcrMonthDate(str) {
    const m = String(str || '').match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+(\d{1,2})[.,]?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/i);
    if (!m) return null;
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const monthIdx = months[m[1].toUpperCase().slice(0, 3)];
    const day = Number(m[2]);
    let hour = Number(m[3]);
    const min = Number(m[4]);
    const ampm = m[5] ? m[5].toUpperCase() : '';
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const yr = new Date().getFullYear();
    return toDatetimeLocalValue(new Date(yr, monthIdx, day, hour, min, 0));
  }

  function extractPairFromUpper(upper) {
    const indexMatch = upper.match(/\b(US30|NAS100|SPX500|NDX100|BTCUSD|ETHUSD|GOLD|SILVER)\b/);
    if (indexMatch) {
      return indexMatch[1] === 'GOLD' ? 'XAU/USD' : indexMatch[1] === 'SILVER' ? 'XAG/USD' : indexMatch[1];
    }
    const fxMatch = upper.match(/\b(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF|XAU|XAG)\s*\/?\s*(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF|USD)\b/);
    if (fxMatch && fxMatch[1] !== fxMatch[2]) {
      return `${fxMatch[1]}/${fxMatch[2]}`;
    }
    return '';
  }

  function parseTableRowFromLine(rawLine) {
    const cleanLine = normalizeOcrNumbers(rawLine).trim();
    const upper = cleanLine.toUpperCase();
    const pair = extractPairFromUpper(upper);
    const dirMatch = upper.match(/\b(BUY|SELL)\b/);
    if (!pair || !dirMatch) return null;

    const direction = dirMatch[1];
    const dirIdx = upper.indexOf(direction) + direction.length;
    const afterDir = cleanLine.slice(dirIdx).trim();

    // Anchor before Position ID (7-12 digits) or Month Name
    const anchorMatch = afterDir.match(/\b(?:\d{7,12}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{1,2})\b/i);
    const priceSection = anchorMatch ? afterDir.slice(0, anchorMatch.index).trim() : afterDir;
    const tokens = priceSection.split(/\s+/).filter((t) => /^(?:-|\d+(?:\.\d+)?)$/.test(t));
    if (tokens.length < 3) return null;

    const toNumOrNull = (tok) => (tok && tok !== '-' && Number.isFinite(Number(tok)) ? Number(tok) : null);
    const lot = toNumOrNull(tokens[0]);
    const entry = toNumOrNull(tokens[1]);
    const exitPrice = toNumOrNull(tokens[2]);
    // Exness history order: Open price, Close price, T/P, S/L
    const tp = toNumOrNull(tokens[3]);
    const sl = toNumOrNull(tokens[4]);

    if (!lot || !entry) return null;

    const trailingPnlMatch = cleanLine.match(/([+-]\s*\$?\s*\d+(?:\.\d{1,2})?)\s*$/);
    const pnl = trailingPnlMatch ? Number(trailingPnlMatch[1].replace(/[\s$]/g, '')) : null;
    const status = typeof pnl === 'number' && Number.isFinite(pnl)
      ? (pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BE')
      : 'WIN';

    const date = parseOcrMonthDate(cleanLine) || toDatetimeLocalValue(new Date());

    let reasonText = '';
    if (/TAKE\s*PROFIT/i.test(cleanLine)) reasonText = 'Hit Take Profit (Impor Screenshot)';
    else if (/STOP\s*LOSS/i.test(cleanLine)) reasonText = 'Hit Stop Loss (Impor Screenshot)';
    else reasonText = 'Impor riwayat trading dari screenshot';

    return {
      selected: true,
      date,
      pair,
      direction,
      lot,
      entry,
      exitPrice,
      sl: sl ?? entry,
      tp: tp ?? (exitPrice || entry),
      pnl: typeof pnl === 'number' && Number.isFinite(pnl) ? pnl : 0,
      status,
      reason: reasonText
    };
  }

  function parseTradeRowsFromOcr(rawText) {
    const lines = String(rawText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const parsed = parseTableRowFromLine(line);
      if (parsed) rows.push(parsed);
    }
    const hasUscHint = /\bUSC\b/i.test(String(rawText || ''));
    return { rows, hasUscHint };
  }

  function parseTradeTextFromOcr(rawText) {
    const text = normalizeOcrNumbers(rawText);
    const upper = text.toUpperCase();
    const detected = {};

    const pair = extractPairFromUpper(upper);
    if (pair) detected.pair = pair;

    const dirLotMatch = upper.match(/\b(BUY|SELL)(?:\s+(?:LIMIT|STOP))?\s+(\d+(?:\.\d{1,2})?)\b/);
    if (dirLotMatch) {
      detected.direction = dirLotMatch[1];
      detected.lot = Number(dirLotMatch[2]);
    } else {
      const dirOnly = upper.match(/\b(BUY|SELL)\b/);
      if (dirOnly) detected.direction = dirOnly[1];
    }

    const arrowPrices = text.match(/(\d+(?:\.\d{2,5}))\s*(?:->|→|=>|—|-|>)\s*(\d+(?:\.\d{2,5}))/);
    if (arrowPrices) {
      detected.entry = Number(arrowPrices[1]);
      detected.exitPrice = Number(arrowPrices[2]);
    } else {
      const openMatch = text.match(/(?:open|entry|price)\s*[:=]?\s*(\d+(?:\.\d{2,5}))/i);
      if (openMatch) detected.entry = Number(openMatch[1]);
      const closeMatch = text.match(/(?:close|exit)\s*[:=]?\s*(\d+(?:\.\d{2,5}))/i);
      if (closeMatch) detected.exitPrice = Number(closeMatch[1]);
    }

    const slMatch = text.match(/(?:S\s*\/?\s*L|STOP\s*LOSS)\s*[:=]?\s*(\d+(?:\.\d{2,5}))/i);
    if (slMatch && Number(slMatch[1]) > 0) detected.sl = Number(slMatch[1]);

    const tpMatch = text.match(/(?:T\s*\/?\s*P|TAKE\s*PROFIT|TARGET)\s*[:=]?\s*(\d+(?:\.\d{2,5}))/i);
    if (tpMatch && Number(tpMatch[1]) > 0) detected.tp = Number(tpMatch[1]);

    const labeledPnl = text.match(/(?:PROFIT|P\s*\/\s*L|PNL|NET)\s*[:=]?\s*([+-]?\s*\$?\s*\d+(?:\.\d{1,2})?)/i);
    const signedMoney = text.match(/([+-]\s*\$?\s*\d+\.\d{2})\b/);
    const rawPnlStr = labeledPnl ? labeledPnl[1] : (signedMoney ? signedMoney[1] : null);
    if (rawPnlStr) {
      const cleanVal = Number(rawPnlStr.replace(/[\s$]/g, ''));
      if (Number.isFinite(cleanVal)) {
        detected.pnl = cleanVal;
        detected.status = cleanVal > 0 ? 'WIN' : cleanVal < 0 ? 'LOSS' : 'BE';
      }
    }

    return detected;
  }

  function applyParsedOcrToForm(parsed) {
    const appliedLabels = [];

    if (parsed.pair) {
      document.getElementById('tradePair').value = parsed.pair;
      appliedLabels.push(`Pair ${parsed.pair}`);
    }
    if (parsed.direction) {
      document.getElementById(parsed.direction === 'SELL' ? 'dirSell' : 'dirBuy').checked = true;
      appliedLabels.push(parsed.direction);
    }
    if (parsed.lot && parsed.lot > 0) {
      document.getElementById('tradeLot').value = parsed.lot.toFixed(2);
      appliedLabels.push(`${parsed.lot.toFixed(2)} Lot`);
    }
    if (parsed.entry) {
      document.getElementById('tradeEntry').value = parsed.entry;
      appliedLabels.push(`Entry ${parsed.entry}`);
    }
    if (parsed.sl) {
      document.getElementById('tradeSL').value = parsed.sl;
      appliedLabels.push(`SL ${parsed.sl}`);
    }
    if (parsed.tp) {
      document.getElementById('tradeTP').value = parsed.tp;
      appliedLabels.push(`TP ${parsed.tp}`);
    }
    if (parsed.exitPrice) {
      document.getElementById('tradeExitPrice').value = parsed.exitPrice;
      appliedLabels.push(`Close ${parsed.exitPrice}`);
    }
    if (parsed.date) {
      document.getElementById('tradeDate').value = parsed.date;
    }
    if (parsed.reason) {
      document.getElementById('tradeReason').value = parsed.reason;
    }
    if (parsed.status) {
      document.getElementById('tradeStatus').value = parsed.status;
    }
    if (typeof parsed.pnl === 'number') {
      pnlManuallyEdited = true;
      document.getElementById('tradePnl').value = Math.abs(parsed.pnl).toFixed(2);
      appliedLabels.push(`P/L ${parsed.pnl >= 0 ? '+' : ''}${parsed.pnl.toFixed(2)}`);
    }

    updatePnlHelperText();
    return appliedLabels;
  }

  function renderBulkOcrTable() {
    const tbody = document.getElementById('bulkOcrTableBody');
    const wrap = document.getElementById('bulkOcrTableWrap');
    const countBadge = document.getElementById('bulkOcrCountBadge');
    const importBtn = document.getElementById('btnImportBulkRows');

    countBadge.textContent = `${bulkOcrRows.length} baris terdeteksi`;
    if (bulkOcrRows.length === 0) {
      wrap.hidden = true;
      tbody.innerHTML = '';
      importBtn.disabled = true;
      return;
    }

    wrap.hidden = false;
    tbody.innerHTML = bulkOcrRows
      .map((r, idx) => `
        <tr data-bulk-idx="${idx}">
          <td><input type="checkbox" class="bulk-check" ${r.selected ? 'checked' : ''} /></td>
          <td><input type="text" class="bulk-pair" data-field="pair" value="${escapeHtml(r.pair)}" /></td>
          <td>
            <select data-field="direction">
              <option value="BUY" ${r.direction === 'BUY' ? 'selected' : ''}>BUY</option>
              <option value="SELL" ${r.direction === 'SELL' ? 'selected' : ''}>SELL</option>
            </select>
          </td>
          <td><input type="number" step="0.01" class="bulk-num" data-field="lot" value="${r.lot}" /></td>
          <td><input type="number" step="any" class="bulk-num" data-field="entry" value="${r.entry}" /></td>
          <td><input type="number" step="any" class="bulk-num" data-field="exitPrice" value="${r.exitPrice ?? ''}" /></td>
          <td><input type="number" step="any" class="bulk-num" data-field="sl" value="${r.sl ?? ''}" /></td>
          <td><input type="number" step="any" class="bulk-num" data-field="tp" value="${r.tp ?? ''}" /></td>
          <td>
            <select data-field="status">
              <option value="WIN" ${r.status === 'WIN' ? 'selected' : ''}>WIN</option>
              <option value="LOSS" ${r.status === 'LOSS' ? 'selected' : ''}>LOSS</option>
              <option value="BE" ${r.status === 'BE' ? 'selected' : ''}>BE</option>
            </select>
          </td>
          <td><input type="number" step="0.01" class="bulk-num" data-field="pnl" value="${r.pnl}" /></td>
          <td><input type="text" class="bulk-reason" data-field="reason" value="${escapeHtml(r.reason)}" /></td>
        </tr>
      `)
      .join('');

    const selectedCount = bulkOcrRows.filter((r) => r.selected).length;
    importBtn.disabled = selectedCount === 0;
    importBtn.textContent = `Impor ${selectedCount} Trade Terpilih`;
  }

  function openBulkOcrModalWithRows(rows, hasUscHint) {
    bulkOcrRows = rows;
    document.getElementById('bulkOcrProgressTrack').hidden = true;
    document.getElementById('bulkUscHint').hidden = !(hasUscHint && state.account.currency !== 'USC');
    document.getElementById('bulkOcrStatusText').textContent = rows.length > 0
      ? `Berhasil membaca ${rows.length} baris trade! Silakan periksa/koreksi angka jika ada yang meleset lalu klik Impor.`
      : 'Tidak ada baris tabel trade yang terbaca jelas. Coba crop lebih dekat ke area tabel.';
    renderBulkOcrTable();
    openModal('bulkOcrModal');
  }

  async function runOcrRecognize(ocrImageUrl, onProgress) {
    const Tesseract = await ensureTesseractLoaded();
    const result = await Tesseract.recognize(ocrImageUrl, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress(Math.max(15, Math.round(m.progress * 100)));
        }
      }
    });
    return result?.data?.text || '';
  }

  async function scanScreenshotWithOcr(ocrImageUrl) {
    const progressTrack = document.getElementById('ocrProgressTrack');
    const progressFill = document.getElementById('ocrProgressFill');
    progressTrack.hidden = false;
    progressFill.style.width = '12%';
    setScreenshotPreviewUI(pendingScreenshotData, 'Memuat mesin pemindai OCR...', 'Memindai...', 'badge-gold');

    try {
      const rawText = await runOcrRecognize(ocrImageUrl, (pct) => {
        progressFill.style.width = `${pct}%`;
        document.getElementById('ocrResultText').textContent = `Membaca teks screenshot... ${pct}%`;
      });

      progressTrack.hidden = true;
      const { rows, hasUscHint } = parseTradeRowsFromOcr(rawText);

      // If screenshot is a multi-row table (e.g. Exness history), open Bulk Importer!
      if (rows.length >= 2) {
        closeModal('tradeModal');
        openBulkOcrModalWithRows(rows, hasUscHint);
        return;
      }

      const parsed = rows.length === 1 ? rows[0] : parseTradeTextFromOcr(rawText);
      const labels = applyParsedOcrToForm(parsed);

      if (labels.length > 0) {
        setScreenshotPreviewUI(
          pendingScreenshotData,
          `Terdeteksi: ${labels.join(' • ')}. Mohon cek kembali sebelum simpan.`,
          `${labels.length} Data Terisi`,
          'badge-mint'
        );
        showToast(`Auto-rekap berhasil mengisi ${labels.length} field!`);
      } else {
        setScreenshotPreviewUI(
          pendingScreenshotData,
          'Gambar terlampir, tetapi angka tidak terbaca jelas. Silakan lengkapi form secara manual.',
          'Lampiran Siap',
          'badge-gold'
        );
      }
    } catch {
      progressTrack.hidden = true;
      setScreenshotPreviewUI(
        pendingScreenshotData,
        'Gagal memuat OCR (butuh koneksi internet saat pertama kali memindai). Gambar tetap terlampir.',
        'Lampiran Siap',
        'badge-coral'
      );
    }
  }

  async function handleBulkScreenshotFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('Pilih file gambar (PNG, JPG, WebP).', 'coral');
      return;
    }
    const track = document.getElementById('bulkOcrProgressTrack');
    const fill = document.getElementById('bulkOcrProgressFill');
    const statusText = document.getElementById('bulkOcrStatusText');
    bulkOcrRows = [];
    renderBulkOcrTable();
    track.hidden = false;
    fill.style.width = '12%';
    statusText.textContent = 'Memuat mesin pemindai OCR untuk tabel...';

    try {
      const { ocrDataUrl } = await processImageForStorageAndOcr(file);
      const rawText = await runOcrRecognize(ocrDataUrl, (pct) => {
        fill.style.width = `${pct}%`;
        statusText.textContent = `Memindai baris tabel... ${pct}%`;
      });
      const { rows, hasUscHint } = parseTradeRowsFromOcr(rawText);
      if (rows.length === 0) {
        const single = parseTradeTextFromOcr(rawText);
        if (single.pair && single.entry) {
          rows.push({
            selected: true,
            date: toDatetimeLocalValue(new Date()),
            pair: single.pair,
            direction: single.direction || 'BUY',
            lot: single.lot || 0.10,
            entry: single.entry,
            exitPrice: single.exitPrice ?? null,
            sl: single.sl ?? single.entry,
            tp: single.tp ?? (single.exitPrice || single.entry),
            pnl: single.pnl ?? 0,
            status: single.status || 'WIN',
            reason: 'Impor riwayat trading dari screenshot'
          });
        }
      }
      openBulkOcrModalWithRows(rows, hasUscHint);
    } catch {
      track.hidden = true;
      statusText.textContent = 'Gagal memuat OCR (butuh koneksi internet saat pertama kali memindai).';
      showToast('Gagal memindai screenshot tabel.', 'coral');
    }
  }

  async function handleScreenshotFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('Pilih file gambar (PNG, JPG, WebP).', 'coral');
      return;
    }
    try {
      const { storedDataUrl, ocrDataUrl } = await processImageForStorageAndOcr(file);
      pendingScreenshotData = storedDataUrl;
      await scanScreenshotWithOcr(ocrDataUrl);
    } catch {
      showToast('Gagal memproses file gambar.', 'coral');
    }
  }

  function getFormEstimatedResult() {
    const pair = document.getElementById('tradePair').value;
    const direction = document.querySelector('input[name="direction"]:checked')?.value || 'BUY';
    const lot = document.getElementById('tradeLot').value;
    const entry = document.getElementById('tradeEntry').value;
    const sl = document.getElementById('tradeSL').value;
    const tp = document.getElementById('tradeTP').value;
    const exitPrice = document.getElementById('tradeExitPrice').value;
    const status = document.getElementById('tradeStatus').value;

    const estSlSigned = estimateMoneyPnl({ pair, direction, lot, entry, targetPrice: sl });
    const estTpSigned = estimateMoneyPnl({ pair, direction, lot, entry, targetPrice: tp });
    const estExitSigned = estimateMoneyPnl({ pair, direction, lot, entry, targetPrice: exitPrice });

    let recommendedPnl = null;
    if (status === 'BE') {
      recommendedPnl = 0;
    } else if (estExitSigned !== null) {
      recommendedPnl = status === 'OPEN' ? estExitSigned : Math.abs(estExitSigned);
    } else if (status === 'WIN' && estTpSigned !== null) {
      recommendedPnl = Math.abs(estTpSigned);
    } else if (status === 'LOSS' && estSlSigned !== null) {
      recommendedPnl = Math.abs(estSlSigned);
    }

    return { pair, direction, entry, sl, tp, estSlSigned, estTpSigned, estExitSigned, recommendedPnl };
  }

  function updateCalcPreview() {
    const { pair, direction, entry, sl, tp, estSlSigned, estTpSigned, recommendedPnl } = getFormEstimatedResult();
    const { slPips, tpPips, rr } = calcPipMetrics(pair, entry, sl, tp);

    document.getElementById('previewSlPips').textContent = `${slPips.toFixed(1)} pips`;
    document.getElementById('previewTpPips').textContent = `${tpPips.toFixed(1)} pips`;
    document.getElementById('previewRR').textContent = `1 : ${rr.toFixed(2)}`;

    const estLossEl = document.getElementById('previewEstLoss');
    if (estSlSigned === null) {
      estLossEl.textContent = `Est. Loss: ${formatCurrency(0)}`;
      estLossEl.className = 'calc-sub mono text-coral-dark';
    } else if (estSlSigned > 0) {
      estLossEl.textContent = `SL Profit: ${formatCurrency(estSlSigned, true)}`;
      estLossEl.className = 'calc-sub mono text-mint-dark';
    } else {
      estLossEl.textContent = `Est. Loss: ${formatCurrency(estSlSigned)}`;
      estLossEl.className = 'calc-sub mono text-coral-dark';
    }

    const estProfitEl = document.getElementById('previewEstProfit');
    if (estTpSigned === null) {
      estProfitEl.textContent = `Est. Profit: ${formatCurrency(0)}`;
      estProfitEl.className = 'calc-sub mono text-mint-dark';
    } else {
      estProfitEl.textContent = `Est. Profit: ${formatCurrency(estTpSigned, true)}`;
      estProfitEl.className = `calc-sub mono ${estTpSigned >= 0 ? 'text-mint-dark' : 'text-coral-dark'}`;
    }

    const warnEl = document.getElementById('previewDirectionWarn');
    const e = Number(entry);
    const s = Number(sl);
    const t = Number(tp);
    let warnMsg = '';
    if (Number.isFinite(e) && e > 0) {
      if (direction === 'BUY') {
        if (Number.isFinite(s) && s > 0 && s >= e) warnMsg = 'BUY: SL umumnya < Entry';
        else if (Number.isFinite(t) && t > 0 && t <= e) warnMsg = 'BUY: TP umumnya > Entry';
      } else {
        if (Number.isFinite(s) && s > 0 && s <= e) warnMsg = 'SELL: SL umumnya > Entry';
        else if (Number.isFinite(t) && t > 0 && t >= e) warnMsg = 'SELL: TP umumnya < Entry';
      }
    }
    warnEl.textContent = warnMsg;
    warnEl.hidden = !warnMsg;

    const status = document.getElementById('tradeStatus').value;
    const pnlInput = document.getElementById('tradePnl');
    const syncBtn = document.getElementById('btnApplyEstimatedPnl');

    if (status !== 'BE' && !pnlManuallyEdited && recommendedPnl !== null) {
      const decimals = (CURRENCY_CONFIG[state.account.currency] || CURRENCY_CONFIG.USD).decimals;
      pnlInput.value = recommendedPnl.toFixed(decimals);
    }

    syncBtn.hidden = status === 'BE' || recommendedPnl === null || !pnlManuallyEdited;
  }

  function updatePnlHelperText() {
    const status = document.getElementById('tradeStatus').value;
    const pnlInput = document.getElementById('tradePnl');
    const help = document.getElementById('pnlHelpText');
    const label = document.getElementById('tradePnlLabel');
    const currSym = (CURRENCY_CONFIG[state.account.currency] || CURRENCY_CONFIG.USD).symbol.trim();

    if (status === 'WIN') {
      label.textContent = `Nominal Profit (${currSym})`;
      help.textContent = 'Otomatis diisi dari Entry → TP & Lot (atau Harga Close jika diisi).';
      pnlInput.disabled = false;
    } else if (status === 'LOSS') {
      label.textContent = `Nominal Loss (${currSym})`;
      help.textContent = 'Otomatis diisi dari Entry → SL & Lot (otomatis dihitung minus -).';
      pnlInput.disabled = false;
    } else if (status === 'BE') {
      label.textContent = `Nominal Profit / Loss (${currSym})`;
      help.textContent = 'Breakeven otomatis tercatat 0.';
      pnlInput.value = '0';
      pnlInput.disabled = true;
    } else {
      label.textContent = `Floating Profit / Loss (${currSym})`;
      help.textContent = 'Otomatis jika Harga Close/Running diisi, atau ketik manual (-/+).';
      pnlInput.disabled = false;
    }
    updateCalcPreview();
  }

  function openNewTradeModal() {
    pnlManuallyEdited = false;
    pendingScreenshotData = '';
    document.getElementById('tradeForm').reset();
    document.getElementById('tradeId').value = '';
    document.getElementById('inputScreenshotFile').value = '';
    document.getElementById('ocrProgressTrack').hidden = true;
    setScreenshotPreviewUI('');
    document.getElementById('tradeModalTitle').textContent = 'Catat Trade Baru';
    document.getElementById('btnSaveTrade').textContent = 'Simpan Catatan Trade';
    document.getElementById('tradeDate').value = toDatetimeLocalValue(new Date());
    document.getElementById('dirBuy').checked = true;
    document.getElementById('tradeLot').value = '0.10';
    document.getElementById('tradeStatus').value = 'WIN';
    updatePnlHelperText();
    openModal('tradeModal');
  }

  function openEditTradeModal(tradeId) {
    const tr = state.trades.find((t) => t.id === tradeId);
    if (!tr) return;

    pnlManuallyEdited = true;
    pendingScreenshotData = tr.screenshotData || '';
    document.getElementById('inputScreenshotFile').value = '';
    document.getElementById('ocrProgressTrack').hidden = true;
    setScreenshotPreviewUI(
      pendingScreenshotData,
      pendingScreenshotData ? 'Screenshot tersimpan. Klik "Pindai Ulang" jika ingin ekstrak teks.' : '',
      'Terlampir',
      'badge-mint'
    );
    document.getElementById('tradeId').value = tr.id;
    document.getElementById('tradeModalTitle').textContent = `Edit Trade — ${tr.pair.toUpperCase()}`;
    document.getElementById('btnSaveTrade').textContent = 'Perbarui Catatan';
    document.getElementById('tradeDate').value = tr.date || toDatetimeLocalValue(new Date());
    document.getElementById('tradePair').value = tr.pair;
    document.getElementById(tr.direction === 'SELL' ? 'dirSell' : 'dirBuy').checked = true;
    document.getElementById('tradeLot').value = tr.lot;
    document.getElementById('tradeEntry').value = tr.entry;
    document.getElementById('tradeSL').value = tr.sl;
    document.getElementById('tradeTP').value = tr.tp;
    document.getElementById('tradeEntryDistance').value = tr.entryDistanceManual ?? '';
    document.getElementById('tradeTimeframe').value = tr.timeframe || 'M15';
    document.getElementById('tradeSession').value = tr.session || 'London';
    document.getElementById('tradeStatus').value = tr.status;
    document.getElementById('tradePnl').value = tr.status === 'LOSS' ? Math.abs(tr.pnl) : tr.pnl;
    document.getElementById('tradeExitPrice').value = tr.exitPrice ?? '';
    document.getElementById('tradeSetupTag').value = tr.setupTag || '';
    document.getElementById('tradeReason').value = tr.reason || '';
    document.getElementById('tradeNotes').value = tr.notes || '';
    document.getElementById('tradeChartUrl').value = tr.chartUrl || '';

    updatePnlHelperText();
    openModal('tradeModal');
  }

  function openDetailModal(tradeId) {
    const analytics = computeAnalytics();
    const tr = analytics.enrichedById.get(tradeId);
    if (!tr) return;

    activeDetailTradeId = tradeId;
    document.getElementById('detailModalTitle').textContent = `${tr.pair.toUpperCase()} — ${tr.direction} (${Number(tr.lot).toFixed(2)} Lot)`;
    document.getElementById('detailModalSubtitle').textContent =
      `${formatDateShort(tr.date)} ${formatTimeShort(tr.date)} • ${tr.timeframe || '-'} • Sesi ${tr.session || '-'}`;

    const chartLinkHtml = isSafeHttpUrl(tr.chartUrl)
      ? `<a href="${escapeHtml(tr.chartUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-secondary">Buka Screenshot Chart</a>`
      : '';

    const hasSafeScreenshot = typeof tr.screenshotData === 'string' && tr.screenshotData.startsWith('data:image/');
    const screenshotHtml = hasSafeScreenshot
      ? `<div class="detail-screenshot"><img src="${escapeHtml(tr.screenshotData)}" alt="Screenshot trade ${escapeHtml(tr.pair)}" title="Klik untuk buka gambar" /></div>`
      : '';

    const distManualText =
      tr.entryDistanceManual != null && tr.entryDistanceManual !== ''
        ? `${Number(tr.entryDistanceManual).toFixed(1)} pips (manual)`
        : `SL ${tr.slPips.toFixed(1)}p / TP ${tr.tpPips.toFixed(1)}p`;

    document.getElementById('detailModalBody').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>${statusBadgeHtml(tr.status)} ${tr.setupTag ? `<span class="badge badge-gold" style="margin-left:6px">${escapeHtml(tr.setupTag)}</span>` : ''}</div>
        <div class="mono" style="font-size:1.25rem;font-weight:800;color:${tr.signedPnl >= 0 ? 'var(--ink-mint-dark)' : 'var(--ink-coral-dark)'}">
          ${escapeHtml(formatCurrency(tr.signedPnl, true))}
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-box"><span>Harga Entry</span><strong class="mono">${escapeHtml(formatPrice(tr.entry, tr.pair))}</strong></div>
        <div class="detail-box"><span>Stop Loss (SL)</span><strong class="mono text-coral-dark">${escapeHtml(formatPrice(tr.sl, tr.pair))} (-${tr.slPips.toFixed(1)}p)</strong></div>
        <div class="detail-box"><span>Take Profit (TP)</span><strong class="mono text-mint-dark">${escapeHtml(formatPrice(tr.tp, tr.pair))} (+${tr.tpPips.toFixed(1)}p)</strong></div>
        <div class="detail-box"><span>Jarak Entry</span><strong class="mono">${escapeHtml(distManualText)}</strong></div>
        <div class="detail-box"><span>Risk : Reward</span><strong class="mono">1 : ${tr.rr.toFixed(2)}</strong></div>
        <div class="detail-box"><span>Balance &rarr; Equity</span><strong class="mono">${escapeHtml(formatCurrency(tr.balanceAfter))} / ${escapeHtml(formatCurrency(tr.equityAtPoint))}</strong></div>
      </div>

      <div class="detail-reason-box">
        <h4>Reason Entry</h4>
        <p>${escapeHtml(tr.reason)}</p>
      </div>

      ${screenshotHtml}
      ${tr.notes ? `<div class="detail-box"><span>Evaluasi / Catatan</span><strong style="font-weight:500">${escapeHtml(tr.notes)}</strong></div>` : ''}
      ${chartLinkHtml ? `<div>${chartLinkHtml}</div>` : ''}
    `;

    openModal('detailModal');
  }

  async function deleteTrade(tradeId) {
    const tr = state.trades.find((t) => t.id === tradeId);
    if (!tr) return;
    const confirmed = await showConfirmDialog({
      title: 'Hapus Catatan Trade?',
      message: `Apakah Anda yakin ingin menghapus catatan ${tr.pair.toUpperCase()} (${tr.direction}) tanggal ${formatDateShort(tr.date)}?`,
      note: 'Saldo Balance, Equity, dan statistik Winrate akan dihitung ulang otomatis.',
      confirmText: 'Ya, Hapus Trade',
      variant: 'coral'
    });
    if (!confirmed) return;
    state.trades = state.trades.filter((t) => t.id !== tradeId);
    state.isDemo = false;
    saveState();
    renderAll();
    showToast('Catatan trade dihapus.', 'coral');
  }

  function openAccountModal() {
    document.getElementById('accCurrency').value = state.account.currency;
    document.getElementById('accInitialBalance').value = state.account.initialBalance;
    document.getElementById('accDepositAdjust').value = state.account.depositAdjust;
    document.getElementById('accManualFloating').value = state.account.manualFloating;
    updateAccountPreview();
    openModal('accountModal');
  }

  function updateAccountPreview() {
    const initial = Number(document.getElementById('accInitialBalance').value) || 0;
    const deposit = Number(document.getElementById('accDepositAdjust').value) || 0;
    const manualFloat = Number(document.getElementById('accManualFloating').value) || 0;

    let realized = 0;
    let openFloat = 0;
    state.trades.forEach((tr) => {
      const val = normalizePnlByStatus(tr.status, tr.pnl);
      if (tr.status === 'OPEN') openFloat += val;
      else realized += val;
    });

    const prevCurr = state.account.currency;
    state.account.currency = document.getElementById('accCurrency').value;
    const bal = initial + deposit + realized;
    const eq = bal + openFloat + manualFloat;
    document.getElementById('accPreviewBalance').textContent = formatCurrency(bal);
    document.getElementById('accPreviewEquity').textContent = formatCurrency(eq);
    state.account.currency = prevCurr;
  }

  // ---------- Export & Import ----------
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `pipnote-backup-${new Date().toISOString().slice(0, 10)}.json`);
    showToast('Backup JSON berhasil diunduh.');
  }

  function exportCSV() {
    const analytics = computeAnalytics();
    const headers = [
      'Tanggal', 'Pair', 'Arah', 'Lot', 'Timeframe', 'Sesi',
      'Entry', 'Stop Loss', 'Take Profit', 'Jarak SL (Pips)', 'Jarak TP (Pips)', 'Jarak Entry Manual (Pips)', 'R:R',
      'Status', 'Profit/Loss', 'Balance Setelah Trade', 'Equity Snapshot', 'Setup', 'Reason Entry', 'Catatan'
    ];

    const rows = [...state.trades]
      .map((t) => analytics.enrichedById.get(t.id))
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((t) => [
        t.date,
        t.pair,
        t.direction,
        t.lot,
        t.timeframe || '',
        t.session || '',
        t.entry,
        t.sl,
        t.tp,
        t.slPips.toFixed(1),
        t.tpPips.toFixed(1),
        t.entryDistanceManual ?? '',
        t.rr.toFixed(2),
        t.status,
        t.signedPnl.toFixed(2),
        t.balanceAfter.toFixed(2),
        t.equityAtPoint.toFixed(2),
        t.setupTag || '',
        t.reason || '',
        t.notes || ''
      ]);

    const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csvContent = '\uFEFF' + [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, `pipnote-trades-${new Date().toISOString().slice(0, 10)}.csv`);
    showToast('File CSV berhasil diunduh.');
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function setMobileTab(tabName) {
    const main = document.getElementById('mainContent');
    if (!main) return;
    main.setAttribute('data-mobile-tab', tabName);
    document.querySelectorAll('[data-mobile-nav]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-mobile-nav') === tabName);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleImportJsonEvent(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));
        if (!Array.isArray(imported.trades) || !imported.account) {
          throw new Error('Format JSON tidak valid');
        }
        state = {
          isDemo: false,
          account: {
            currency: imported.account.currency || 'USD',
            initialBalance: Number(imported.account.initialBalance) || 0,
            depositAdjust: Number(imported.account.depositAdjust) || 0,
            manualFloating: Number(imported.account.manualFloating) || 0
          },
          trades: imported.trades
        };
        saveState();
        renderAll();
        showToast(`Berhasil mengimpor ${state.trades.length} catatan trade.`);
      } catch {
        showToast('File JSON tidak valid.', 'coral');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  async function handleResetAll() {
    const confirmed = await showConfirmDialog({
      title: 'Hapus Semua Data Jurnal?',
      message: 'Apakah Anda yakin ingin menghapus seluruh riwayat trading? Tindakan ini tidak bisa dibatalkan.',
      note: 'Disarankan unduh Backup JSON atau CSV terlebih dahulu sebelum mengosongkan data.',
      confirmText: 'Ya, Hapus Semua',
      variant: 'coral'
    });
    if (!confirmed) return;
    state.trades = [];
    state.isDemo = false;
    state.account.depositAdjust = 0;
    state.account.manualFloating = 0;
    saveState();
    renderAll();
    showToast('Semua catatan trading berhasil dikosongkan.', 'coral');
  }

  // ---------- Event Wiring ----------
  function initEvents() {
    document.getElementById('btnConfirmCancel').addEventListener('click', () => {
      closeModal('confirmModal');
    });
    document.getElementById('btnConfirmAccept').addEventListener('click', () => {
      const resolve = confirmResolver;
      confirmResolver = null;
      closeModal('confirmModal');
      if (resolve) resolve(true);
    });

    document.getElementById('btnNewTrade').addEventListener('click', openNewTradeModal);
    document.getElementById('btnMobileNavAdd').addEventListener('click', openNewTradeModal);
    document.getElementById('btnEmptyAddTrade').addEventListener('click', openNewTradeModal);
    document.getElementById('btnAccountSettings').addEventListener('click', openAccountModal);
    document.getElementById('btnMobileAccountSettings').addEventListener('click', openAccountModal);
    document.getElementById('btnQuickEditAccount').addEventListener('click', openAccountModal);

    // Mobile bottom navbar tabs
    document.querySelectorAll('[data-mobile-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setMobileTab(btn.getAttribute('data-mobile-nav'));
      });
    });

    // Clear demo data with custom confirmation popup
    document.getElementById('btnClearDemo').addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        title: 'Mulai Jurnal Kosong?',
        message: 'Apakah Anda yakin ingin menghapus seluruh data contoh dan memulai jurnal trading dari awal?',
        note: 'Modal awal akun Anda tetap tersimpan dan bisa disesuaikan kapan saja di menu Akun.',
        confirmText: 'Ya, Mulai Kosong',
        variant: 'gold'
      });
      if (!confirmed) return;
      state.trades = [];
      state.isDemo = false;
      saveState();
      renderAll();
      showToast('Data contoh dihapus. Siap mencatat trade pertamamu!');
    });

    // Dropdown menu
    const btnData = document.getElementById('btnDataMenu');
    const menu = document.getElementById('dataDropdownMenu');
    btnData.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btnData.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', () => {
      menu.hidden = true;
      btnData.setAttribute('aria-expanded', 'false');
    });

    document.getElementById('btnBulkScreenshotImport').addEventListener('click', () => {
      openBulkOcrModalWithRows([], false);
    });
    document.getElementById('btnMobileBulkScreenshot').addEventListener('click', () => {
      openBulkOcrModalWithRows([], false);
    });

    const bulkFileInput = document.getElementById('inputBulkScreenshotFile');
    document.getElementById('btnPickBulkScreenshot').addEventListener('click', () => bulkFileInput.click());
    bulkFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleBulkScreenshotFile(file);
      e.target.value = '';
    });

    document.getElementById('bulkCheckAll').addEventListener('change', (e) => {
      const checked = e.target.checked;
      bulkOcrRows.forEach((r) => { r.selected = checked; });
      renderBulkOcrTable();
    });

    document.getElementById('bulkOcrTableBody').addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-bulk-idx]');
      if (!tr) return;
      const idx = Number(tr.getAttribute('data-bulk-idx'));
      const row = bulkOcrRows[idx];
      if (!row) return;

      const field = e.target.getAttribute('data-field');
      if (e.target.classList.contains('bulk-check')) {
        row.selected = e.target.checked;
        const selectedCount = bulkOcrRows.filter((r) => r.selected).length;
        const importBtn = document.getElementById('btnImportBulkRows');
        importBtn.disabled = selectedCount === 0;
        importBtn.textContent = `Impor ${selectedCount} Trade Terpilih`;
      } else if (field) {
        if (['lot', 'entry', 'exitPrice', 'sl', 'tp', 'pnl'].includes(field)) {
          row[field] = e.target.value === '' ? null : Number(e.target.value);
        } else {
          row[field] = e.target.value;
        }
      }
    });

    document.getElementById('btnSwitchCurrencyUsc').addEventListener('click', () => {
      state.account.currency = 'USC';
      saveState();
      renderAll();
      document.getElementById('bulkUscHint').hidden = true;
      showToast('Mata uang akun diubah ke USC (Cent).');
    });

    document.getElementById('btnImportBulkRows').addEventListener('click', () => {
      const chosen = bulkOcrRows.filter((r) => r.selected && r.pair && Number.isFinite(Number(r.entry)));
      if (chosen.length === 0) return;

      chosen.forEach((r) => {
        state.trades.push({
          id: uid(),
          date: r.date || toDatetimeLocalValue(new Date()),
          pair: String(r.pair).trim().toUpperCase(),
          direction: r.direction === 'SELL' ? 'SELL' : 'BUY',
          lot: Number(r.lot) || 0.01,
          entry: Number(r.entry),
          sl: Number(r.sl) || Number(r.entry),
          tp: Number(r.tp) || Number(r.exitPrice) || Number(r.entry),
          exitPrice: r.exitPrice != null ? Number(r.exitPrice) : null,
          entryDistanceManual: null,
          timeframe: 'M15',
          session: 'London',
          status: r.status || 'WIN',
          pnl: normalizePnlByStatus(r.status || 'WIN', Number(r.pnl) || 0),
          setupTag: 'Impor Screenshot',
          reason: String(r.reason || 'Impor riwayat trading dari screenshot').trim(),
          notes: '',
          chartUrl: ''
        });
      });

      state.isDemo = false;
      saveState();
      closeModal('bulkOcrModal');
      renderAll();
      showToast(`Berhasil mengimpor ${chosen.length} trade dari screenshot!`);
    });

    document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
    document.getElementById('btnMobileExportCSV').addEventListener('click', exportCSV);
    document.getElementById('btnExportJSON').addEventListener('click', exportJSON);
    document.getElementById('btnMobileExportJSON').addEventListener('click', exportJSON);
    document.getElementById('inputImportJSON').addEventListener('change', handleImportJsonEvent);
    document.getElementById('inputMobileImportJSON').addEventListener('change', handleImportJsonEvent);
    document.getElementById('btnResetAll').addEventListener('click', handleResetAll);
    document.getElementById('btnMobileResetAll').addEventListener('click', handleResetAll);

    // Trade Form live preview & auto P/L estimation
    ['tradePair', 'tradeLot', 'tradeEntry', 'tradeSL', 'tradeTP', 'tradeExitPrice'].forEach((id) => {
      document.getElementById(id).addEventListener('input', updateCalcPreview);
    });
    document.querySelectorAll('input[name="direction"]').forEach((radio) => {
      radio.addEventListener('change', updateCalcPreview);
    });
    document.getElementById('tradeStatus').addEventListener('change', () => {
      updatePnlHelperText();
    });
    document.getElementById('tradePnl').addEventListener('input', () => {
      pnlManuallyEdited = true;
      updateCalcPreview();
    });
    document.getElementById('btnApplyEstimatedPnl').addEventListener('click', () => {
      pnlManuallyEdited = false;
      updateCalcPreview();
    });

    // Screenshot Upload, Drag-Drop, Paste & OCR Auto-Rekap
    const fileInput = document.getElementById('inputScreenshotFile');
    const dropzone = document.getElementById('ocrDropzone');

    document.getElementById('btnPickScreenshot').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleScreenshotFile(file);
      e.target.value = '';
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleScreenshotFile(file);
    });

    document.addEventListener('paste', (e) => {
      const inTradeModal = !document.getElementById('tradeModal').hidden;
      const inBulkModal = !document.getElementById('bulkOcrModal').hidden;
      if (!inTradeModal && !inBulkModal) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            if (inBulkModal) handleBulkScreenshotFile(file);
            else handleScreenshotFile(file);
            break;
          }
        }
      }
    });

    document.getElementById('btnRemoveScreenshot').addEventListener('click', () => {
      pendingScreenshotData = '';
      document.getElementById('inputScreenshotFile').value = '';
      document.getElementById('ocrProgressTrack').hidden = true;
      setScreenshotPreviewUI('');
    });

    document.getElementById('btnRunOcrAgain').addEventListener('click', async () => {
      if (!pendingScreenshotData) return;
      try {
        const { ocrDataUrl } = await prepareOcrCanvasFromSrc(pendingScreenshotData, false);
        await scanScreenshotWithOcr(ocrDataUrl);
      } catch {
        showToast('Gagal memindai ulang gambar.', 'coral');
      }
    });

    document.getElementById('tradeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('tradeId').value;
      const status = document.getElementById('tradeStatus').value;
      const rawPnl = Number(document.getElementById('tradePnl').value) || 0;
      const normalizedPnl = normalizePnlByStatus(status, rawPnl);
      const distManualRaw = document.getElementById('tradeEntryDistance').value.trim();
      const exitRaw = document.getElementById('tradeExitPrice').value.trim();

      const record = {
        id: id || uid(),
        date: document.getElementById('tradeDate').value,
        pair: document.getElementById('tradePair').value.trim().toUpperCase(),
        direction: document.querySelector('input[name="direction"]:checked').value,
        lot: Number(document.getElementById('tradeLot').value) || 0.01,
        entry: Number(document.getElementById('tradeEntry').value),
        sl: Number(document.getElementById('tradeSL').value),
        tp: Number(document.getElementById('tradeTP').value),
        exitPrice: exitRaw !== '' ? Number(exitRaw) : null,
        entryDistanceManual: distManualRaw !== '' ? Number(distManualRaw) : null,
        timeframe: document.getElementById('tradeTimeframe').value,
        session: document.getElementById('tradeSession').value,
        status,
        pnl: normalizedPnl,
        setupTag: document.getElementById('tradeSetupTag').value.trim(),
        reason: document.getElementById('tradeReason').value.trim(),
        notes: document.getElementById('tradeNotes').value.trim(),
        chartUrl: document.getElementById('tradeChartUrl').value.trim(),
        screenshotData: pendingScreenshotData || ''
      };

      const prevTrades = [...state.trades];
      if (id) {
        const idx = state.trades.findIndex((t) => t.id === id);
        if (idx >= 0) state.trades[idx] = record;
      } else {
        state.trades.push(record);
      }

      const prevDemo = state.isDemo;
      state.isDemo = false;
      if (!saveState()) {
        state.trades = prevTrades;
        state.isDemo = prevDemo;
        return;
      }

      showToast(id ? `Trade ${record.pair} diperbarui.` : `Trade ${record.pair} berhasil dicatat.`);
      closeModal('tradeModal');
      renderAll();
    });

    // Account Form
    ['accCurrency', 'accInitialBalance', 'accDepositAdjust', 'accManualFloating'].forEach((id) => {
      document.getElementById(id).addEventListener('input', updateAccountPreview);
      document.getElementById(id).addEventListener('change', updateAccountPreview);
    });

    document.getElementById('accountForm').addEventListener('submit', (e) => {
      e.preventDefault();
      state.account.currency = document.getElementById('accCurrency').value;
      state.account.initialBalance = Number(document.getElementById('accInitialBalance').value) || 0;
      state.account.depositAdjust = Number(document.getElementById('accDepositAdjust').value) || 0;
      state.account.manualFloating = Number(document.getElementById('accManualFloating').value) || 0;
      saveState();
      closeModal('accountModal');
      renderAll();
      showToast('Pengaturan akun diperbarui.');
    });

    // Filters
    ['filterSearch', 'filterPair', 'filterDirection', 'filterStatus'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => renderJournalList(computeAnalytics()));
      el.addEventListener('change', () => renderJournalList(computeAnalytics()));
    });

    // Table & Mobile List click delegation (Detail, Edit, Delete)
    const handleListClick = (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const id = actionBtn.getAttribute('data-id');
        const action = actionBtn.getAttribute('data-action');
        if (action === 'edit') openEditTradeModal(id);
        if (action === 'delete') deleteTrade(id);
        return;
      }
      const row = e.target.closest('[data-trade-id]');
      if (row) {
        openDetailModal(row.getAttribute('data-trade-id'));
      }
    };

    document.getElementById('journalTableBody').addEventListener('click', handleListClick);
    document.getElementById('mobileTradeList').addEventListener('click', handleListClick);

    // Detail modal buttons
    document.getElementById('btnDetailEdit').addEventListener('click', () => {
      const id = activeDetailTradeId;
      closeModal('detailModal');
      if (id) openEditTradeModal(id);
    });
    document.getElementById('btnDetailDelete').addEventListener('click', () => {
      const id = activeDetailTradeId;
      closeModal('detailModal');
      if (id) deleteTrade(id);
    });

    // Close modals via buttons, backdrop click, or Escape
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop').forEach((m) => {
          if (!m.hidden) closeModal(m.id);
        });
      }
    });
  }

  // Boot
  initEvents();
  renderAll();
})();
