'use strict';

/**
 * Loads real SAP production data from Excel dumps into in-memory Maps.
 *
 * Source tables (SAP internal names → OData entity):
 *   FPLA  → A_SalesOrderBillingPlan   (billing plan headers)
 *   FPLT  → A_SalesOrderBillingPlanItem (billing plan line items)
 *   VBAK  → A_SalesOrder header data
 *   VBKD  → SO financial / payment data
 *   KNA1  → Customer master (name, country)
 *
 * All field names in output objects follow API_SALES_ORDER_SRV_0001 spec.
 */

const path = require('path');
const XLSX = require('xlsx');

const DUMP_DIR = path.resolve(__dirname, '../../system-dump');

// ── SAP format helpers ────────────────────────────────────────────────────────

// European decimal string "9.090,00" → 9090.00  (also handles "100,00", "0,00")
function parseEurNum(val) {
  if (val == null || val === '' || val === '0,00' || val === '0') return 0;
  const s = String(val).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// SAP date string "14.01.2026" or "00.00.0000" → "2026-01-14" or null
function parseSapDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s || s === '00.00.0000' || s === '0000-00-00') return null;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ISO date string → SAP OData /Date(ms)/ format
function toODataDate(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : `/Date(${ms})/`;
}

// Strip SAP leading zeros from numeric IDs ("0000747392" → "747392")
// But keep alpha-numeric IDs intact ("M80499" → "M80499")
function stripLeadZeros(val) {
  if (!val) return '';
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

// ── Generic Excel reader ──────────────────────────────────────────────────────
// SAP exports have a 4-row preamble; row 5 (index 4) is the header, row 6 is blank, data from row 7.

function readSheet(filename) {
  const fullPath = path.join(DUMP_DIR, filename);
  const wb = XLSX.readFile(fullPath, { dense: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });

  // Row index 4 = header row (0-based)
  const headerRow = raw[4] || [];
  const headers = headerRow.map(h => (h != null ? String(h).trim() : null));

  const records = [];
  // Data starts at row index 6 (row 7 in sheet); skip blank rows
  for (let i = 6; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(v => v == null || v === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = row[idx] != null ? String(row[idx]).trim() : '';
    });
    records.push(obj);
  }
  return records;
}

// ── Load and normalize each table ─────────────────────────────────────────────

function loadCustomers() {
  const rows = readSheet('SoldToParty_Customer_Link.xlsx');
  const map = new Map(); // KUNNR → { Name, Country, City }
  for (const r of rows) {
    const kunnr = stripLeadZeros(r.KUNNR);
    if (!kunnr) continue;
    map.set(kunnr, {
      CustomerName:    r.NAME1 || '',
      CustomerCountry: r.LAND1 || '',
      CustomerCity:    r.ORT01 || '',
      Industry:        r.BRSCH || '',
    });
  }
  return map;
}

function loadSOHeaders(customers) {
  const rows = readSheet('Sales Order Header Level.xlsx');
  const map = new Map(); // VBELN (stripped) → enriched SO header
  for (const r of rows) {
    const vbeln = stripLeadZeros(r.VBELN);
    if (!vbeln) continue;
    const kunnr = stripLeadZeros(r.KUNNR);
    const cust  = customers.get(kunnr) || {};
    map.set(vbeln, {
      SalesOrder:      vbeln,
      SalesOrderType:  r.AUART || '',
      NetAmount:       parseEurNum(r.NETWR),
      TransactionCurrency: r.WAERK || 'EUR',
      SalesOrganization:   r.VKORG || '',
      CustomerNumber:  kunnr,
      CreationDate:    parseSapDate(r.ERDAT),
      CustomerPONumber: r.BSTNK || '',
      WBSElement:      r.PS_PSP_PNR || '',
      ...cust,
    });
  }
  return map;
}

function loadSOFinancials() {
  const rows = readSheet('Sales Orders Financial Data.xlsx');
  // Keep only header-level rows (POSNR = '0' or '000000')
  const map = new Map(); // VBELN → financial data
  for (const r of rows) {
    const posnr = String(r.POSNR || '').replace(/^0+/, '') || '0';
    if (posnr !== '0') continue;
    const vbeln = stripLeadZeros(r.VBELN);
    if (!vbeln) continue;
    map.set(vbeln, {
      Incoterms:           r.INCO1 || '',
      IncotermsLocation:   r.INCO2 || '',
      CustomerPaymentTerms: r.ZTERM || '',
      BillingPlanFKVBKD:   stripLeadZeros(r.FPLNR),
    });
  }
  return map;
}

function loadBillingPlanHeaders(soHeaders, soFinancials) {
  const rows = readSheet('Billing Plan Header per Sales Order.xlsx');
  const map = new Map(); // BillingPlan (stripped FPLNR) → header object
  for (const r of rows) {
    const fplnr = stripLeadZeros(r.FPLNR);
    const vbeln = stripLeadZeros(r.VBELN);
    if (!fplnr || !vbeln) continue;

    const so  = soHeaders.get(vbeln) || {};
    const fin = soFinancials.get(vbeln) || {};

    map.set(fplnr, {
      // A_SalesOrderBillingPlan fields
      SalesOrder:           vbeln,
      BillingPlan:          fplnr,
      BillingPlanType:      r.FPART || '',
      BillingPlanCategory:  r.BPCAT || '',
      BillingPlanStartDate: toODataDate(parseSapDate(r.BEDAT)),
      BillingPlanEndDate:   toODataDate(parseSapDate(r.ENDAT)),
      // Enrichment from VBAK + VBKD + KNA1
      NetAmount:            so.NetAmount || 0,
      TransactionCurrency:  so.TransactionCurrency || 'EUR',
      CustomerName:         so.CustomerName || '',
      CustomerCountry:      so.CustomerCountry || '',
      CustomerCity:         so.CustomerCity || '',
      Industry:             so.Industry || '',
      Incoterms:            fin.Incoterms || '',
      IncotermsLocation:    fin.IncotermsLocation || '',
      CustomerPaymentTerms: fin.CustomerPaymentTerms || '',
      SalesOrderType:       so.SalesOrderType || '',
      CustomerPONumber:     so.CustomerPONumber || '',
    });
  }
  return map;
}

function loadBillingPlanItems(planHeaders) {
  const rows = readSheet('BillingPlanItems.xlsx');
  // Map: BillingPlan → array of A_SalesOrderBillingPlanItem objects
  const map = new Map();

  for (const r of rows) {
    const fplnr = stripLeadZeros(r.FPLNR);
    if (!fplnr) continue;

    const header = planHeaders.get(fplnr);
    const salesOrder = header?.SalesOrder || '';

    const isoDate = parseSapDate(r.FKDAT);
    const amount  = parseEurNum(r.FAKWR);
    const pct     = parseEurNum(r.FPROZ);

    // Map FPTTP date category: '03' = milestone, '05' = final/partial
    const dateCat = (r.FPTTP || '').padStart(2, '0');

    const item = {
      // API_SALES_ORDER_SRV A_SalesOrderBillingPlanItem fields
      SalesOrder:                    salesOrder,
      BillingPlan:                   fplnr,
      BillingPlanItem:               stripLeadZeros(r.FPLTR).padStart(4, '0'),
      BillingPlanDateCategory:       dateCat,
      BillingPlanBillingDate:        toODataDate(isoDate),
      BillingPlanAmount:             String(amount.toFixed(2)),
      TransactionCurrency:           r.WAERS || 'EUR',
      BillingPlanAmountPercent:      String(pct.toFixed(2)),
      CustomerPaymentTerms:          r.ZTERM || header?.CustomerPaymentTerms || '',
      ProposedBillingDocumentType:   r.FKARV || '',
      BillingPlanDateDescriptionCode: r.TETXT || '',
      BillingBlockReason:            r.FAKSP || '',
      BillingPlanMilestoneUsage:     r.MLBEZ || '',
      BillingPlanBillingRule:        r.FAREG || '',
      // Denormalised enrichment for analytics queries
      _billingDateISO:   isoDate,
      _amountNum:        amount,
      _percentNum:       pct,
      _customerName:     header?.CustomerName || '',
      _customerCountry:  header?.CustomerCountry || '',
      _netAmount:        header?.NetAmount || 0,
      _currency:         header?.TransactionCurrency || 'EUR',
      _incoterms:        header?.Incoterms || '',
      _paymentTerms:     r.ZTERM || header?.CustomerPaymentTerms || '',
    };

    if (!map.has(fplnr)) map.set(fplnr, []);
    map.get(fplnr).push(item);
  }
  return map;
}

// ── Main export ───────────────────────────────────────────────────────────────

let _cache = null;

function load() {
  if (_cache) return _cache;

  console.log('[SystemDump] Loading production data from system-dump/...');
  const t0 = Date.now();

  const customers    = loadCustomers();
  const soHeaders    = loadSOHeaders(customers);
  const soFinancials = loadSOFinancials();
  const planHeaders  = loadBillingPlanHeaders(soHeaders, soFinancials);
  const planItems    = loadBillingPlanItems(planHeaders);

  // Flatten items for full-list queries
  const allItems = [];
  planItems.forEach(items => allItems.push(...items));

  // Build a plans array enriched with their items for analytics lookups
  const allPlans = [];
  planHeaders.forEach((header, fplnr) => {
    const items = planItems.get(fplnr) || [];
    if (items.length === 0) return;
    allPlans.push({ ...header, items });
  });

  console.log(`[SystemDump] Loaded ${customers.size} customers, ${soHeaders.size} SOs, ` +
              `${planHeaders.size} billing plans, ${allItems.length} items in ${Date.now() - t0}ms`);

  _cache = { customers, soHeaders, soFinancials, planHeaders, planItems, allItems, allPlans };
  return _cache;
}

/**
 * Returns up to 10 historical billing plans whose net contract value is within
 * ±50% of targetValue. Each plan includes its items and key enrichment fields
 * useful for AI analytics prompts.
 */
function getHistoricalPlans(targetValue) {
  const { allPlans } = load();
  const lo = targetValue * 0.5;
  const hi = targetValue * 1.5;

  return allPlans
    .filter(p => p.NetAmount >= lo && p.NetAmount <= hi)
    .slice(0, 10)
    .map(p => ({
      salesOrder:      p.SalesOrder,
      billingPlan:     p.BillingPlan,
      contractValue:   p.NetAmount,
      currency:        p.TransactionCurrency,
      customerCountry: p.CustomerCountry,
      industry:        p.Industry,
      incoterms:       p.Incoterms,
      paymentTerms:    p.CustomerPaymentTerms,
      milestones: p.items.map(it => ({
        item:         it.BillingPlanItem,
        billingDate:  it._billingDateISO,
        amount:       it._amountNum,
        percentage:   it._percentNum,
        currency:     it.TransactionCurrency,
        docType:      it.ProposedBillingDocumentType,
        dateCategory: it.BillingPlanDateCategory,
        paymentTerms: it._paymentTerms,
        milestoneCode: it.BillingPlanMilestoneUsage,
      })),
    }));
}

module.exports = { load, getHistoricalPlans };
