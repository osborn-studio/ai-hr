const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const freeze = value => JSON.stringify(canonical(value));

// A failed or unknown command is retained with its original ID and frozen body.
// Retry sends precisely that command; it never silently generates a second ID.
export function createCommandJournal({ api, userId, storage, uuid = () => crypto.randomUUID() }) {
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const storageKey = `tyhr.pending.commands.${userId}`;
  let memory = [];
  try { const value = JSON.parse(storage?.getItem(storageKey) || '[]'); if (Array.isArray(value)) memory = value; } catch { /* Memory remains usable. */ }
  const save = () => { try { if (!storage) return false; storage.setItem(storageKey, JSON.stringify(memory)); return true; } catch { return false; } };
  const send = async record => {
    try {
      const result = await api.request(`/api/v2/command/${encodeURIComponent(record.operation)}`, { method: 'POST', body: record.input, headers: { 'Idempotency-Key': record.id } });
      memory = memory.filter(r => r.id !== record.id); save(); return { result, operationId: record.id };
    } catch (error) { record.error = error.message; record.outcome = error.status && error.status < 500 ? 'rejected' : 'unknown'; save(); error.operationId = record.id; throw error; }
  };
  return {
    pending: () => memory.map(r => ({ ...r })),
    async execute(operation, input) {
      const base = freeze(input);
      const existing = memory.find(r => r.operation === operation && r.fingerprint === base);
      if (existing) return send(existing);
      const unresolved = memory.find(r => r.operation === operation);
      if (unresolved) { const error = new Error('此类操作尚有未处理的原操作号，请先按原内容重试或核对已拒绝的结果'); error.operationId = unresolved.id; throw error; }
      const id = uuid(); const frozen = JSON.parse(base);
      if (operation === 'leave.request.submit') frozen.request_key ||= id;
      if (operation === 'leave.entitlement.grant') frozen.event_key ||= id;
      const record = { id, operation, input: frozen, fingerprint: base, createdAt: new Date().toISOString(), outcome: 'pending' };
      memory.push(record);
      if (!save()) { memory = memory.filter(r => r.id !== id); throw new Error('无法保存原操作号，请允许本页会话存储后再办理；本次未发送业务请求'); }
      return send(record);
    },
    async retry(id) { const record = memory.find(r => r.id === id); if (!record) throw new Error('原操作记录不存在，请先查询实际业务状态'); return send(record); },
    discardRejected(id) { const record = memory.find(r => r.id === id); if (record?.outcome !== 'rejected') throw new Error('结果未知的操作不能丢弃原操作号'); memory = memory.filter(r => r.id !== id); save(); },
  };
}
