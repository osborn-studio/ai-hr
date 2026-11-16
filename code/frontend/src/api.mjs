export class ApiError extends Error {
  constructor(message, { code = 'E_REQUEST', status = 0, ref } = {}) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.ref = ref;
  }
}

export function createApi({ token = '', fetchImpl = globalThis.fetch, onUnauthorized = () => {} } = {}) {
  async function request(path, { method = 'GET', body, signal, responseType = 'json', headers: extraHeaders = {} } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new ApiError('仅可访问本站业务接口');
    let response;
    try {
      response = await fetchImpl(path, {
        method, signal, credentials: 'same-origin', cache: 'no-store',
        headers: { accept: responseType === 'json' ? 'application/json' : '*/*',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError('无法连接服务，请检查网络或稍后重试', { code: 'E_NETWORK' });
    }
    if (!response.ok) {
      let detail = {}; try { detail = await response.json(); } catch { /* Never expose raw HTML. */ }
      const error = new ApiError(detail.message || ({ 401: '登录已失效，请重新登录', 403: '当前账号无此范围的访问权限', 404: '记录不存在或不在授权范围内', 409: '数据状态已改变，请刷新后核对', 428: '当前账号需要先修改口令', 429: '操作频繁，请稍后重试' })[response.status] || `服务暂时无法处理（${response.status}）`, {
        code: detail.error || `HTTP_${response.status}`, status: response.status, ref: detail.ref,
      });
      if (response.status === 401 && path !== '/login' && !(path === '/api/me/password' && error.code === 'E_AUTH_BAD_CREDENTIAL')) onUnauthorized(error);
      throw error;
    }
    if (responseType === 'blob') return response.blob();
    if (responseType === 'text') return response.text();
    try { return await response.json(); }
    catch { throw new ApiError('接口返回格式异常，请确认连接的是业务服务', { code: 'E_RESPONSE_FORMAT', status: response.status }); }
  }
  return { request,
    login: (login, password) => request('/login', { method: 'POST', body: { login, password } }),
    me: signal => request('/api/me', { signal }),
    capabilities: signal => request('/api/me/capabilities', { signal }),
    bootstrap: (scope = {}, signal) => request(withScope('/api/foundation/bootstrap', scope), { signal }),
  };
}

export function withScope(path, scope = {}) {
  const query = new URLSearchParams();
  for (const key of ['group_id', 'ledger_id', 'company_id']) if (scope[key] !== '' && scope[key] != null) query.set(key, String(scope[key]));
  const suffix = query.toString(); return path + (suffix ? `${path.includes('?') ? '&' : '?'}${suffix}` : '');
}

export async function downloadFile(api, path, filename) {
  const blob = await api.request(path, { responseType: 'blob' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
