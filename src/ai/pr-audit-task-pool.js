'use strict';
const S = require('./pr-audit-state');
class AuditTaskPool {
  constructor() { this.tasks = new Map(); }
  acquire(ref, key) {
    if (this.tasks.size >= 2 || [...this.tasks.values()].includes(key)) throw S.fail('BUSY');
    this.tasks.set(ref, key);
  }
  release(ref) { this.tasks.delete(ref); }
}
module.exports = { AuditTaskPool };
