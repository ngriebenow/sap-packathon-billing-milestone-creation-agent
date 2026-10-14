'use strict';

// In-memory session store. Shape of each entry:
// {
//   salesOrderId: string,
//   documentTexts: string[],
//   conversationHistory: { role: string, content: string|array }[],
//   milestones: object[]|null,
//   status: 'new'|'chatting'|'milestones_proposed'|'created'
// }

const sessions = new Map();

module.exports = {
  get(id) {
    return sessions.get(id);
  },
  set(id, data) {
    sessions.set(id, data);
  },
  update(id, patch) {
    sessions.set(id, { ...sessions.get(id), ...patch });
  },
  delete(id) {
    sessions.delete(id);
  },
  getOrCreate(id) {
    if (!sessions.has(id)) {
      sessions.set(id, {
        salesOrderId: null,
        documentTexts: [],
        conversationHistory: [],
        milestones: null,
        status: 'new'
      });
    }
    return sessions.get(id);
  }
};
