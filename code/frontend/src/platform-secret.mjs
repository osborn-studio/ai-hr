// Credential material is never placed in the general command journal.
// Only an operation key and salted fingerprint survive this tab's reload.
export function createSecretCommand({ api, actorId, connectionId, storage, uuid = () => crypto.randomUUID(), cryptoImpl = crypto }) {
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  const key = 'tyhr.pending.secret.' + actorId + '.' + connectionId; let pending = null;
  try { const parsed = JSON.parse(storage?.getItem(key) || 'null'); if (parsed?.operationId && String(parsed.connectionId) === String(connectionId)) pending = parsed; } catch { /* No secret is reconstructed. */ }
  const clear = () => { pending = null; try { storage.removeItem(key); } catch { /* A stale marker can be status-checked again. */ } };
  return {
    hasPending: () => !!pending,
    metadata: () => pending ? { ...pending } : null,
    async execute(credentials) {
      if (pending) throw new Error('此连接已有待核凭据操作，请查询原状态，不能另建或重放秘密。');
      if (!credentials || !Object.values(credentials).some(value => typeof value === 'string' && value.length)) throw new Error('请输入新的凭据。');
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(credentials).sort(([a], [b]) => a.localeCompare(b))));
      const operationId = uuid(); const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(operationId + ':' + connectionId + ':' + canonical));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      pending = { operationId, connectionId: String(connectionId), fingerprint, createdAt: new Date().toISOString() };
      try { if (!storage) throw new Error('unavailable'); storage.setItem(key, JSON.stringify(pending)); } catch { pending = null; throw new Error('无法保存原操作号，本次未发送凭据。'); }
      try { const result = await api.request('/api/v2/command/system.integration.secret', { method: 'POST', body: { connection_id: connectionId, credentials }, headers: { 'Idempotency-Key': operationId } }); clear(); return { status: 'completed', operationId, configured: result.secret_configured }; }
      catch (error) { error.operationId = operationId; throw error; }
    },
    async status() {
      if (!pending) throw new Error('没有待核的原操作号。');
      const operationId = pending.operationId;
      const result = await api.request('/api/v2/query/system.operation.status', { method: 'POST', body: { operationId, operation: 'system.integration.secret' } });
      if (result.state === 'completed' && result.completed === true) clear();
      return { status: result.state === 'completed' && result.completed === true ? 'completed' : 'unknown', operationId, credential_available: false };
    },
  };
}
