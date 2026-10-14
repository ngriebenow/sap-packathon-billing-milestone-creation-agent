'use strict';

/**
 * Converts an ISO date string (YYYY-MM-DD) to SAP OData /Date(ms)/ format.
 */
function toODataDate(isoDate) {
  const ms = new Date(isoDate).getTime();
  return `/Date(${ms})/`;
}

/**
 * Determines BillingPlanMilestoneUsage code:
 *   Z001 = first milestone
 *   Z002 = intermediate milestones
 *   Z003 = final milestone
 */
function getMilestoneUsage(index, total) {
  if (index === 0) return 'Z001';
  if (index === total - 1) return 'Z003';
  return 'Z002';
}

/**
 * Maps LLM-extracted milestones to SAP POST payload objects.
 * Applies all hardcoded business rules from the reference data.
 *
 * @param {object[]} milestones - Raw milestone objects from LLM tool output
 * @param {string} salesOrder   - SAP Sales Order ID
 * @param {string} billingPlan  - SAP Billing Plan number (fetched from S/4)
 * @returns {object[]} Array of SAP OData POST payload objects
 */
function mapToSAPPayload(milestones, salesOrder, billingPlan) {
  const total = milestones.length;

  return milestones.map((m, i) => {
    const isFinal = i === total - 1;
    const odataDate = toODataDate(m.billingDate);

    return {
      SalesOrder:  salesOrder,
      BillingPlan: billingPlan,

      // Dates
      BillingPlanBillingDate:    odataDate,
      BillingPlanServiceEndDate: odataDate,

      // Amounts
      BillingPlanAmount:        String(Number(m.amount).toFixed(2)),
      BillingPlanAmountPercent: isFinal ? '0.00' : String(Number(m.percentage).toFixed(2)),
      TransactionCurrency:      m.currency,

      // Business-rule-driven fields
      BillingPlanDateCategory:     isFinal ? '05' : '03',
      ProposedBillingDocumentType: isFinal ? 'F2' : 'FAZ',
      BillingPlanBillingRule:      isFinal ? '3'  : '4',
      BillingPlanMilestoneUsage:   getMilestoneUsage(i, total),

      // Hardcoded constants matching the reference data
      BillingBlockReason:          '02',
      BillingPlanType:             'Z1',
      AdoptingBillingDateID:       '1',
      CustomerPaymentTerms:        '',
      BillingPlanDateDescriptionCode: ''
    };
  });
}

module.exports = { mapToSAPPayload, toODataDate, getMilestoneUsage };
