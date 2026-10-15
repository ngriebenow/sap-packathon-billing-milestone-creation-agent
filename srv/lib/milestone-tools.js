'use strict';

const TOOLS = [
  {
    name: 'propose_milestones',
    description: `Call this tool ONLY when you have enough information to propose a complete and accurate billing milestone table.

IMPORTANT: If you are uncertain about ANY date, amount, percentage, or other value — even slightly — do NOT call this tool. Instead, ask the user a specific clarifying question in plain text.

When called, this tool will display the milestone table to the user for review.`,
    input_schema: {
      type: 'object',
      required: ['milestones', 'totalAmount', 'currency', 'confidence'],
      properties: {
        milestones: {
          type: 'array',
          description: 'Ordered list of ALL payment milestones from the contract, including the final one. All are advance payments (FAZ). Percentages must sum to 100%.',
          items: {
            type: 'object',
            required: ['milestoneNumber', 'billingDate', 'amount', 'percentage', 'currency'],
            properties: {
              milestoneNumber: {
                type: 'integer',
                description: 'Sequential number starting at 1'
              },
              billingDate: {
                type: 'string',
                description: 'ISO 8601 date in YYYY-MM-DD format'
              },
              amount: {
                type: 'number',
                description: 'Absolute amount to be billed at this advance payment milestone'
              },
              percentage: {
                type: 'number',
                description: 'Percentage of total contract value for this payment (all percentages must sum to 100)'
              },
              currency: {
                type: 'string',
                description: 'ISO 4217 currency code, e.g. EUR'
              },
              description: {
                type: 'string',
                description: 'Optional: brief description of this milestone from the contract'
              }
            }
          }
        },
        totalAmount: {
          type: 'number',
          description: 'Total contract value (used as the Target reference in the UI)'
        },
        currency: {
          type: 'string',
          description: 'Contract currency (ISO 4217)'
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Your confidence in the extracted data. Use low/medium only if you still have minor uncertainties.'
        }
      }
    }
  }
];

module.exports = { TOOLS };
