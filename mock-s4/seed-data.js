'use strict';

// ── Static lookup tables ──────────────────────────────────────────────────────

const CUSTOMERS = [
  'Müller Metallbau GmbH',        'Braun Maschinenbau AG',
  'Schmidt Fertigungstechnik KG', 'Weber Automatisierung GmbH',
  'Meyer Industrial Solutions',   'Hoffmann Presswerke GmbH',
  'Fischer Robotics GmbH',        'Schneider CNC-Systeme AG',
  'Koch Sondermaschinen GmbH',    'Becker Hydraulik GmbH',
  'Richter Antriebstechnik AG',   'Klein Schweißtechnik GmbH',
  'Wolf Automation GmbH',         'Schäfer Fräszentren AG',
  'Zimmermann Hydraulics GmbH',   'Krause Präzisionstechnik',
  'Lehmann Anlagenbau GmbH',      'Walter CNC Engineering AG',
  'Mayer Montageanlagen GmbH',    'Herrmann Industrieautomation',
];

const PROJECT_TEMPLATES = [
  { name: '5axis-CNC-Retrofit',           contractValue: 87500,   description: 'Retrofit of 5-axis CNC machining center, Fanuc control upgrade' },
  { name: 'RobotArm-Assembly-Line-V2',    contractValue: 450000,  description: 'Dual-robot assembly line for precision gear production, vision system included' },
  { name: 'Hydraulic-Press-800T',         contractValue: 320000,  description: '800-ton hydraulic press for sheet metal forming, PLC upgrade' },
  { name: 'CNC-Lathe-Multi-Spindle',      contractValue: 195000,  description: '6-spindle CNC turning center with bar feeder and chip conveyor' },
  { name: 'Plasma-Cutting-XL',            contractValue: 125000,  description: 'Large-format plasma cutting table 8x4m, CNC controller, fume extraction' },
  { name: 'Robot-Welding-Cell-MIG',       contractValue: 380000,  description: 'ABB IRB6700 welding robot cell, positioner, offline programming license' },
  { name: 'Conveyor-System-Modular',      contractValue: 215000,  description: 'Modular belt conveyor system for engine block assembly, 120m total length' },
  { name: 'Grinding-Machine-Surface',     contractValue: 148000,  description: 'CNC surface grinding machine, automatic dressing, 1500x500mm table' },
  { name: 'Laser-Cutter-Fiber-6kW',       contractValue: 275000,  description: '6kW fiber laser cutting machine, automatic nozzle changer, 3x1.5m bed' },
  { name: 'Injection-Mold-Machine',       contractValue: 510000,  description: '1200-ton injection molding machine for automotive structural parts' },
  { name: 'EDM-Wire-Cut-Precision',       contractValue: 98000,   description: 'Wire EDM machine for precision die and mold production' },
  { name: 'Robotic-Deburring-Station',    contractValue: 165000,  description: 'KUKA robot deburring and polishing station, force-torque sensor' },
  { name: 'Press-Brake-CNC-Tandem',       contractValue: 290000,  description: 'Tandem CNC press brake 600T, automatic tool changer, offline programming' },
  { name: 'CMM-Inline-Measuring',         contractValue: 175000,  description: 'Inline coordinate measuring machine, real-time SPC integration' },
  { name: 'Pallet-Changer-FMS',           contractValue: 620000,  description: 'Flexible manufacturing system, 24-pallet pool, robot loading, MES interface' },
  { name: 'Milling-Center-HSC',           contractValue: 340000,  description: 'High-speed 5-axis milling center, 42000 rpm spindle, thermal compensation' },
  { name: 'Cobot-Assembly-Workspace',     contractValue: 88000,   description: 'Universal Robots UR10e cobot assembly workspace, force-guided insertion' },
  { name: 'Deep-Hole-Drilling-BTA',       contractValue: 240000,  description: 'BTA deep hole drilling machine, 4m depth, coolant-through spindle' },
  { name: 'Rotary-Transfer-Machine',      contractValue: 780000,  description: '16-station rotary transfer machine for high-volume shaft production' },
  { name: 'Gear-Hobbing-CNC',             contractValue: 430000,  description: 'CNC gear hobbing machine, module 8, shaft diameter up to 500mm' },
  { name: 'Ultrasonic-Cleaning-System',   contractValue: 55000,   description: 'Multi-stage ultrasonic cleaning system for precision components' },
  { name: 'Laser-Hardening-Station',      contractValue: 192000,  description: 'Diode laser hardening station for tool steels, 12kW, pyrometer feedback' },
  { name: 'Vision-Inspection-AI',         contractValue: 142000,  description: 'AI-powered vision inspection system, 100% inline quality control' },
  { name: 'AGV-Warehouse-System',         contractValue: 560000,  description: 'Autonomous guided vehicle system, 8 units, WMS integration' },
  { name: 'Friction-Stir-Welding',        contractValue: 890000,  description: 'Friction stir welding machine for aluminium aircraft structural panels' },
];

const MILESTONE_DESCRIPTIONS = [
  'Down payment',
  'Design approval & engineering freeze',
  'Manufacturing start & raw material procurement',
  'Factory acceptance test (FAT)',
  'Delivery & installation on-site',
  'Final commissioning & handover',
];

// ── Deterministic SO generator ────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function buildSO(i) {
  const customer = CUSTOMERS[i % CUSTOMERS.length];
  const tmpl     = PROJECT_TEMPLATES[i % PROJECT_TEMPLATES.length];

  // Vary contract value: base ± (i * 0.15 * base) clamped to 50k–2M
  const variation    = 1 + ((i * 7) % 31 - 15) / 100;  // ±15%
  const contractValue = Math.round(clamp(tmpl.contractValue * variation, 50000, 2000000) / 500) * 500;

  // Milestone count: 2–6 based on contract value
  const milestoneCount = clamp(Math.floor(contractValue / 250000) + 2, 2, 6);

  // Contract date: spread across 2022–2025
  const year  = 2022 + ((i * 3) % 4);
  const month = (1 + (i * 7) % 12).toString().padStart(2, '0');
  const day   = (1 + (i * 13) % 28).toString().padStart(2, '0');
  const contractDate = `${year}-${month}-${day}`;

  // Billing plan milestones
  const percentages = buildPercentages(milestoneCount);
  const billingPlan = [];

  for (let m = 0; m < milestoneCount; m++) {
    const isLast   = m === milestoneCount - 1;
    const daysAdd  = m * Math.floor(90 + (i * 11 + m * 37) % 90);  // 90–180 days apart
    const bDate    = addDays(contractDate, daysAdd);

    // Status distribution: ~30% paid, ~10% late, rest open
    const seed = (i * milestoneCount + m) * 7;
    const status = (seed % 10) < 3 ? 'paid' : (seed % 10) === 9 ? 'late' : 'open';

    const pct    = isLast ? 100 : percentages[m];
    const amount = isLast
      ? contractValue
      : Math.round(contractValue * (percentages[m] / 100) * 100) / 100;

    billingPlan.push({
      milestoneNumber: m + 1,
      billingDate:     bDate,
      amount,
      percentage:      pct,
      currency:        'EUR',
      description:     MILESTONE_DESCRIPTIONS[clamp(m, 0, MILESTONE_DESCRIPTIONS.length - 1)],
      status,
    });
  }

  return {
    SalesOrderID:  (40000001 + i).toString(),
    CustomerName:  customer,
    ProjectName:   tmpl.name,
    Description:   tmpl.description,
    ContractValue: contractValue,
    Currency:      'EUR',
    ContractDate:  contractDate,
    billingPlan,
  };
}

// Spread percentages over ALL milestones including the final one (total = 100)
function buildPercentages(count) {
  if (count <= 1) return [100];
  const perSlot = Math.floor(100 / count);
  const result  = [];
  let used = 0;
  for (let i = 0; i < count; i++) {
    const pct = (i === count - 1) ? 100 - used : perSlot;
    result.push(pct);
    used += pct;
  }
  return result;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ── Exports ───────────────────────────────────────────────────────────────────

const SALES_ORDERS = Array.from({ length: 100 }, (_, i) => buildSO(i));

const MOCK_BILLING_PLAN_ID = '748165';

function seedIntoMap(billingPlanItems) {
  for (const so of SALES_ORDERS) {
    const items = so.billingPlan.map((m, idx) => {
      const dateMs = new Date(m.billingDate).getTime();
      const isLast = idx === so.billingPlan.length - 1;
      return {
        SalesOrder:                  so.SalesOrderID,
        BillingPlan:                 MOCK_BILLING_PLAN_ID,
        BillingPlanItem:             String(idx + 1).padStart(4, '0'),
        BillingPlanBillingDate:      `/Date(${dateMs})/`,
        BillingDocumentType:         isLast ? 'F2' : 'FAZ',
        ProposedBillingDocumentType: isLast ? 'F2' : 'FAZ',
        BillingPlanBillingBlockRsn:  '',
        BillingPlanMilestoneUsage:   idx === 0 ? 'Z001' : isLast ? 'Z003' : 'Z002',
        NetAmount:                   String(m.amount),
        TransactionCurrency:         m.currency,
        BillingPlanBilledAmount:     m.status === 'paid' ? String(m.amount) : '0.00',
        BillingPlanItemDescription:  m.description,
        BillingPlanItemPercentage:   String(m.percentage),        PaymentStatus:               m.status,
      };
    });
    billingPlanItems.set(`${so.SalesOrderID}:${MOCK_BILLING_PLAN_ID}`, items);
  }
}

function getHistoricalPlans(targetValue) {
  const lo = targetValue * 0.5;
  const hi = targetValue * 1.5;
  return SALES_ORDERS
    .filter(so => so.ContractValue >= lo && so.ContractValue <= hi)
    .slice(0, 10)
    .map(so => ({
      ProjectName:   so.ProjectName,
      CustomerName:  so.CustomerName,
      ContractValue: so.ContractValue,
      milestones:    so.billingPlan.map(m => ({
        milestoneNumber: m.milestoneNumber,
        billingDate:     m.billingDate,
        amount:          m.amount,
        percentage:      m.percentage,
        description:     m.description,
        status:          m.status,
      })),
    }));
}

module.exports = { SALES_ORDERS, MOCK_BILLING_PLAN_ID, seedIntoMap, getHistoricalPlans };
