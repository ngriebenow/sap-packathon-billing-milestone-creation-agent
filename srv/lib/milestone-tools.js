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
          description: 'Ordered list of billing milestones starting from #1. The last entry is always the final billing milestone (full invoice).',
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
                description: 'Absolute amount to be billed at this milestone'
              },
              percentage: {
                type: 'number',
                description: 'Percentage of total contract value. For milestones 1…(N-1) this is their partial share. For the final milestone (F2) this is always 100.'
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
          description: 'Total contract value — this becomes the amount of the final billing milestone'
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
