'use strict';

const fetch = require('node-fetch');

const S4_BASE = () => process.env.S4_BASE_URL;
const S4_USER = () => process.env.S4_USERNAME;
const S4_PASS = () => process.env.S4_PASSWORD;

let cachedCsrfToken = null;
let cachedCookies   = null;

function getAuthHeaders() {
  const user = S4_USER();
  const pass = S4_PASS();
  if (user && pass) {
    return {
      Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    };
  }
  return {};
}

/**
 * Fetches (and caches) a CSRF token from the S/4HANA system.
 * SAP OData V2: GET $metadata with x-csrf-token: Fetch.
 * The response contains the real token + session cookie.
 */
async function fetchCsrfToken() {
  const res = await fetch(`${S4_BASE()}/$metadata`, {
    method: 'GET',
    headers: {
      ...getAuthHeaders(),
      'x-csrf-token': 'Fetch',
      Accept: 'application/json'
    }
  });
  cachedCsrfToken = res.headers.get('x-csrf-token');
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    // Extract the first cookie value only (name=value part)
    cachedCookies = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
  }
  return { token: cachedCsrfToken, cookies: cachedCookies };
}

/**
 * GET /A_SalesOrder('{SalesOrder}')/to_BillingPlan
 * Returns the BillingPlan number string.
 */
async function getBillingPlanId(salesOrder) {
  const url = `${S4_BASE()}/A_SalesOrder('${salesOrder}')/to_BillingPlan?$select=BillingPlan`;
  const res = await fetch(url, {
    headers: {
      ...getAuthHeaders(),
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET BillingPlan failed for SalesOrder ${salesOrder}: ${res.status} ${body}`);
  }
  const json = await res.json();
  return json.d.BillingPlan;
}

/**
 * POSTs a single billing plan item. Auto-retries once on 403 (expired CSRF token).
 */
async function createBillingPlanItem(salesOrder, billingPlan, payload, isRetry = false) {
  if (!cachedCsrfToken) {
    await fetchCsrfToken();
  }

  const soEncoded = salesOrder;
  const bpEncoded = billingPlan;
  const url = `${S4_BASE()}/A_SalesOrderBillingPlan(SalesOrder='${soEncoded}',BillingPlan='${bpEncoded}')/to_BillingPlanItem`;

  const headers = {
    ...getAuthHeaders(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-csrf-token': cachedCsrfToken
  };
  if (cachedCookies) headers['Cookie'] = cachedCookies;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (res.status === 403 && !isRetry) {
    cachedCsrfToken = null;
    cachedCookies   = null;
    await fetchCsrfToken();
    return createBillingPlanItem(salesOrder, billingPlan, payload, true);
  }

  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`POST BillingPlanItem failed: ${res.status} ${body}`);
  }

  return res.json();
}

/**
 * Fetches the billing plan ID for the sales order, then creates all milestone items sequentially.
 * Returns { billingPlanId, count }.
 */
async function createAllMilestones(salesOrder, sapPayloads) {
  const billingPlanId = await getBillingPlanId(salesOrder);

  let count = 0;
  for (const payload of sapPayloads) {
    // Inject the resolved billingPlan into each payload
    const enrichedPayload = { ...payload, BillingPlan: billingPlanId };
    await createBillingPlanItem(salesOrder, billingPlanId, enrichedPayload);
    count++;
  }

  return { billingPlanId, count };
}

module.exports = { getBillingPlanId, createBillingPlanItem, createAllMilestones, fetchCsrfToken };
