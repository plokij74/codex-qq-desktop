'use strict';
const { PrAuditRepairStore } = require('./pr-audit-repair-store');
const schema = require('./pr-audit-recheck-repair-state');
class PrAuditRecheckRepairStore extends PrAuditRepairStore {
  constructor(options = {}) {
    super({ ...options, schema, refField: 'recheckRepairRef', storeName: 'engineering-pr-audit-recheck-repairs.json' });
  }
}
module.exports = { PrAuditRecheckRepairStore };
