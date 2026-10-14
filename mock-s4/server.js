'use strict';

const express    = require('express');
const path       = require('path');
const seedData   = require('./seed-data');
const systemDump = require('./load-system-dump');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory storage ─────────────────────────────────────────────────────
// Key: `${salesOrder}:${billingPlan}` → array of billing plan item objects
const billingPlanItems = new Map();

// Seed 100 synthetic sales orders into the in-memory store on startup
seedData.seedIntoMap(billingPlanItems);
console.log(`[Mock S4] Loaded ${seedData.SALES_ORDERS.length} synthetic seed sales orders`);

// Load real production data (async-safe: synchronous XLSX parse, cached after first call)
const dump = systemDump.load();

// Every sales order gets this hardcoded billing plan ID (matches reference data)
const MOCK_BILLING_PLAN_ID = seedData.MOCK_BILLING_PLAN_ID;
const MOCK_CSRF_TOKEN = 'mock-csrf-token-s4hana';
const BASE_PATH = '/sap/opu/odata/sap/API_SALES_ORDER_SRV';

// ── CSRF Helper ───────────────────────────────────────────────────────────
function handleCsrfFetch(req, res, next) {
  if (req.headers['x-csrf-token'] === 'Fetch') {
    res.setHeader('x-csrf-token', MOCK_CSRF_TOKEN);
    res.setHeader('Set-Cookie', 'SAP_SESSIONID_MOCK=mock-session-abc123; Path=/; HttpOnly');
  }
  next();
}

function validateCsrf(req, res, next) {
  if (req.headers['x-csrf-token'] !== MOCK_CSRF_TOKEN) {
    return res.status(403).json({
      error: {
        code: '403',
        message: { lang: 'en', value: 'CSRF token validation failed. Fetch a new token first.' }
      }
    });
  }
  next();
}

// ── OData URL parsing helpers ─────────────────────────────────────────────
// OData V2 uses URLs like: /Entity(Key='value') or /Entity(Key1='v1',Key2='v2')
// Express cannot directly match parentheses in route patterns, so we use
// a router with regex and extract keys manually.

function extractODataKey(segment) {
  // Matches: EntityName('value') → 'value'
  const m = segment.match(/^[^(]+\('([^']+)'\)$/);
  return m ? m[1] : null;
}

function extractODataKeys(segment) {
  // Matches: EntityName(Key1='v1',Key2='v2') → { Key1: 'v1', Key2: 'v2' }
  const inner = segment.replace(/^[^(]+\(/, '').replace(/\)$/, '');
  const result = {};
  const parts = inner.split(',');
  for (const part of parts) {
    const kv = part.match(/^(\w+)='([^']*)'$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

// ── Sales Order catalog endpoint (for SO suggestion feature) ─────────────
app.get('/api/salesOrders', (req, res) => {
  res.json(seedData.SALES_ORDERS.map(so => ({
    SalesOrderID:  so.SalesOrderID,
    CustomerName:  so.CustomerName,
    ProjectName:   so.ProjectName,
    ContractValue: so.ContractValue,
    Currency:      so.Currency,
    ContractDate:  so.ContractDate,
  })));
});

// ── GET routes ───────────────────────────────────────────────────────────
// NOTE: Express interprets '$' in route strings as end-of-string anchor in
// path-to-regexp, so routes like `${BASE_PATH}/$metadata` never match.
// All GET routing is therefore handled in a single wildcard handler that
// reads req.path directly.
app.get(`${BASE_PATH}/*`, (req, res, next) => {
  // Emit CSRF token for any GET with x-csrf-token: Fetch header
  handleCsrfFetch(req, res, () => {});

  // Decode the path so both literal and percent-encoded single quotes match
  const urlPath = decodeURIComponent(req.path).slice(BASE_PATH.length);

  // $metadata — used by s4-client for CSRF token fetch
  if (urlPath === '/$metadata' || urlPath === '/' || urlPath === '') {
    return res.json({ d: { EntitySets: ['A_SalesOrder', 'A_SalesOrderBillingPlan', 'A_SalesOrderBillingPlanItem'] } });
  }

  // ── Real production data endpoints ────────────────────────────────────────

  // GET /A_SalesOrderBillingPlan — all real billing plan headers (with enrichment)
  // Supports optional $filter on NetAmount: ?minValue=50000&maxValue=200000
  if (urlPath === '/A_SalesOrderBillingPlan') {
    let plans = dump.allPlans.map(p => ({
      SalesOrder:           p.SalesOrder,
      BillingPlan:          p.BillingPlan,
      BillingPlanType:      p.BillingPlanType,
      BillingPlanCategory:  p.BillingPlanCategory,
      BillingPlanStartDate: p.BillingPlanStartDate,
      BillingPlanEndDate:   p.BillingPlanEndDate,
      NetAmount:            p.NetAmount,
      TransactionCurrency:  p.TransactionCurrency,
      CustomerName:         p.CustomerName,
      CustomerCountry:      p.CustomerCountry,
      Incoterms:            p.Incoterms,
      CustomerPaymentTerms: p.CustomerPaymentTerms,
      ItemCount:            p.items.length,
    }));
    const minVal = parseFloat(req.query.minValue);
    const maxVal = parseFloat(req.query.maxValue);
    if (isFinite(minVal)) plans = plans.filter(p => p.NetAmount >= minVal);
    if (isFinite(maxVal)) plans = plans.filter(p => p.NetAmount <= maxVal);
    return res.json({ d: { results: plans, __count: String(plans.length) } });
  }

  // GET /A_SalesOrderBillingPlan('<fplnr>')/to_BillingPlanItem — items for a real plan
  const getRealItems = urlPath.match(/^\/A_SalesOrderBillingPlan\('([^']+)'\)\/to_BillingPlanItem$/);
  if (getRealItems) {
    const fplnr = getRealItems[1];
    const items = dump.planItems.get(fplnr) || [];
    return res.json({ d: { results: items } });
  }

  // Match: /A_SalesOrder('<salesOrder>')/to_BillingPlan
  const getBillingPlan = urlPath.match(/^\/A_SalesOrder\('([^']+)'\)\/to_BillingPlan$/);
  if (getBillingPlan) {
    const salesOrder = getBillingPlan[1];
    return res.json({
      d: {
        SalesOrder:   salesOrder,
        BillingPlan:  MOCK_BILLING_PLAN_ID,
        BillingPlanType: 'Z1',
        BillingPlanCategory: '02'
      }
    });
  }

  // Match: /A_SalesOrderBillingPlan(SalesOrder='<so>',BillingPlan='<bp>')/to_BillingPlanItem
  const getItems = urlPath.match(/^\/A_SalesOrderBillingPlan\(SalesOrder='([^']+)',BillingPlan='([^']+)'\)\/to_BillingPlanItem$/);
  if (getItems) {
    const salesOrder  = getItems[1];
    const billingPlan = getItems[2];
    const key = `${salesOrder}:${billingPlan}`;
    const items = billingPlanItems.get(key) || [];
    return res.json({ d: { results: items } });
  }

  // Match: /A_SalesOrderBillingPlanItem — list all items (synthetic + real)
  if (urlPath === '/A_SalesOrderBillingPlanItem') {
    const syntheticItems = [];
    billingPlanItems.forEach(items => syntheticItems.push(...items));
    const allItems = [...syntheticItems, ...dump.allItems];
    return res.json({ d: { results: allItems, __count: String(allItems.length) } });
  }

  next();
});

// ── POST BillingPlanItem ──────────────────────────────────────────────────
// URL: POST /A_SalesOrderBillingPlan(SalesOrder='<so>',BillingPlan='<bp>')/to_BillingPlanItem
app.post(`${BASE_PATH}/*`, validateCsrf, (req, res, next) => {
  const urlPath = decodeURIComponent(req.path).slice(BASE_PATH.length);

  const postItems = urlPath.match(/^\/A_SalesOrderBillingPlan\(SalesOrder='([^']+)',BillingPlan='([^']+)'\)\/to_BillingPlanItem$/);
  if (!postItems) return next();

  const salesOrder  = postItems[1];
  const billingPlan = postItems[2];
  const key = `${salesOrder}:${billingPlan}`;

  const existing = billingPlanItems.get(key) || [];
  const newItem = {
    ...req.body,
    SalesOrder:      salesOrder,
    BillingPlan:     billingPlan,
    BillingPlanItem: String(existing.length + 1).padStart(4, '0'),
    __metadata: {
      type: 'API_SALES_ORDER_SRV.A_SalesOrderBillingPlanItemType',
      uri: `${BASE_PATH}/A_SalesOrderBillingPlanItem(SalesOrder='${salesOrder}',BillingPlan='${billingPlan}',BillingPlanItem='${existing.length + 1}')`
    }
  };

  existing.push(newItem);
  billingPlanItems.set(key, existing);

  console.log(`[Mock S/4] Created BillingPlanItem ${newItem.BillingPlanItem} for ${key} — Type: ${newItem.ProposedBillingDocumentType}`);

  return res.status(201).json({ d: newItem });
});

// ── DELETE all items for a SalesOrder (utility for testing) ──────────────
app.delete(`${BASE_PATH}/reset/:salesOrder`, (req, res) => {
  const key = `${req.params.salesOrder}:${MOCK_BILLING_PLAN_ID}`;
  billingPlanItems.delete(key);
  res.json({ message: `Items for ${req.params.salesOrder} cleared.` });
});

// ── Viewer UI ─────────────────────────────────────────────────────────────
// Returns an HTML page showing all created items for a given SalesOrder.
app.get('/view/:salesOrder', (req, res) => {
  const salesOrder = req.params.salesOrder;
  const key  = `${salesOrder}:${MOCK_BILLING_PLAN_ID}`;
  const items = billingPlanItems.get(key) || [];

  function odataDateToDisplay(raw) {
    if (!raw) return '—';
    const m = String(raw).match(/\/Date\((\d+)\)\//);
    if (!m) return raw;
    return new Date(parseInt(m[1])).toISOString().split('T')[0];
  }

  function fmtAmount(val) {
    if (!val) return '—';
    return Number(val).toLocaleString('de-DE', { minimumFractionDigits: 2 });
  }

  const rows = items.map(item => {
    const isFinal = item.ProposedBillingDocumentType === 'F2';
    return `
      <tr class="${isFinal ? 'final-row' : ''}">
        <td>${item.BillingPlanItem}</td>
        <td>${odataDateToDisplay(item.BillingPlanBillingDate)}</td>
        <td class="amount">${fmtAmount(item.BillingPlanAmount)}</td>
        <td class="amount">${isFinal ? '—' : (item.BillingPlanAmountPercent || '0.00') + '%'}</td>
        <td>${item.TransactionCurrency || '—'}</td>
        <td><span class="badge badge-${isFinal ? 'f2' : 'faz'}">${item.ProposedBillingDocumentType || '—'}</span></td>
        <td>${item.BillingPlanDateCategory || '—'}</td>
        <td>${item.BillingPlanMilestoneUsage || '—'}</td>
        <td>${item.BillingPlanBillingRule || '—'}</td>
        <td>${item.BillingBlockReason || '—'}</td>
      </tr>`;
  }).join('');

  const totalItems = items.length;
  const totalAmount = items.reduce((sum, i) => sum + Number(i.BillingPlanAmount || 0), 0);
  const currency = items[0]?.TransactionCurrency || 'EUR';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock S/4HANA — Billing Plan Items</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: '72', Arial, sans-serif; background: #f5f6f7; color: #32363a; padding: 0; }

    .header {
      background: #354a5e;
      color: white;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .header h1 { font-size: 16px; font-weight: 700; }
    .header .mock-badge {
      background: #e9730c;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
    }

    .content { padding: 24px; }

    .info-bar {
      background: white;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 20px;
      display: flex;
      gap: 32px;
      flex-wrap: wrap;
    }
    .info-item { display: flex; flex-direction: column; gap: 4px; }
    .info-label { font-size: 11px; color: #6a6d70; font-weight: 600; text-transform: uppercase; }
    .info-value { font-size: 16px; font-weight: 700; color: #32363a; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
      overflow: hidden;
      font-size: 13px;
    }
    th {
      background: #354a5e;
      color: white;
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
    }
    td {
      padding: 9px 14px;
      border-bottom: 1px solid #e5e5e5;
      white-space: nowrap;
    }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #f7f9fc; }
    tr.final-row td { background: #fef7e0 !important; font-weight: 700; border-top: 2px solid #e9730c; }
    .amount { text-align: right; font-variant-numeric: tabular-nums; }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge-faz { background: #e8f1fc; color: #0a6ed1; }
    .badge-f2  { background: #fef7e0; color: #e9730c; }

    .empty {
      text-align: center;
      padding: 48px;
      color: #89919a;
      background: white;
      border: 1px solid #d9d9d9;
      border-radius: 6px;
    }

    .actions { margin-top: 16px; display: flex; gap: 12px; }
    .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-primary { background: #0a6ed1; color: white; }
    .btn-primary:hover { background: #085caf; }
    .btn-danger { background: #bb0000; color: white; }
    .btn-danger:hover { background: #990000; }

    .api-info {
      margin-top: 20px;
      background: #354a5e;
      color: #d1e8f5;
      padding: 16px 20px;
      border-radius: 6px;
      font-size: 12px;
      font-family: monospace;
    }
    .api-info h3 { color: white; margin-bottom: 8px; font-size: 13px; }
    .api-info p { margin: 4px 0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SAP S/4HANA — Billing Plan Viewer</h1>
    <span class="mock-badge">MOCK</span>
  </div>

  <div class="content">
    <div class="info-bar">
      <div class="info-item">
        <span class="info-label">Sales Order</span>
        <span class="info-value">${salesOrder}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Billing Plan</span>
        <span class="info-value">${MOCK_BILLING_PLAN_ID}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Items</span>
        <span class="info-value">${totalItems}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Total Amount</span>
        <span class="info-value">${currency} ${totalAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })}</span>
      </div>
    </div>

    ${items.length === 0
      ? '<div class="empty"><h3>No billing plan items found for this Sales Order.</h3><p>Create items via the Billing Milestone Agent first.</p></div>'
      : `<table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Billing Date</th>
              <th style="text-align:right">Amount</th>
              <th style="text-align:right">%</th>
              <th>Currency</th>
              <th>Doc Type</th>
              <th>Date Cat.</th>
              <th>Milestone</th>
              <th>Rule</th>
              <th>Block</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`
    }

    <div class="actions">
      <button class="btn btn-primary" onclick="location.reload()">Refresh</button>
      ${items.length > 0
        ? `<button class="btn btn-danger" onclick="clearItems()">Clear All Items</button>`
        : ''}
    </div>

    <div class="api-info">
      <h3>Mock OData API Endpoints</h3>
      <p>GET  /sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder('${salesOrder}')/to_BillingPlan</p>
      <p>GET  /sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderBillingPlan(SalesOrder='${salesOrder}',BillingPlan='${MOCK_BILLING_PLAN_ID}')/to_BillingPlanItem</p>
      <p>POST /sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderBillingPlan(SalesOrder='${salesOrder}',BillingPlan='${MOCK_BILLING_PLAN_ID}')/to_BillingPlanItem</p>
    </div>
  </div>

  <script>
    async function clearItems() {
      if (!confirm('Delete all billing plan items for this Sales Order?')) return;
      await fetch('/sap/opu/odata/sap/API_SALES_ORDER_SRV/reset/${salesOrder}', { method: 'DELETE' });
      location.reload();
    }
  </script>
</body>
</html>`);
});

// ── Default 404 for unmatched OData routes ───────────────────────────────
app.use(`${BASE_PATH}/*`, (req, res) => {
  res.status(404).json({
    error: {
      code: '404',
      message: { lang: 'en', value: `Resource not found: ${req.path}` }
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.MOCK_S4_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n Mock SAP S/4HANA server running at http://localhost:${PORT}`);
  console.log(`   OData base: http://localhost:${PORT}${BASE_PATH}`);
  console.log(`   Viewer:     http://localhost:${PORT}/view/<SalesOrderId>`);
  console.log(`   CSRF token: ${MOCK_CSRF_TOKEN}\n`);
});
