export function createSupabaseClient(config = window.AMAZOMBIE_SUPABASE) {
  const url = String(config?.url ?? '').replace(/\/+$/, '');
  const key = String(config?.publishableKey ?? '').trim();
  if (!url || !key) return null;
  if (!/^https?:\/\//.test(url)) throw new Error('SUPABASE_URL must be an HTTP(S) URL');

  async function request(path, options = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      headers: { apikey: key, ...options.headers }
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.message || `Supabase request failed (${response.status})`);
    }
    return response.json();
  }

  return {
    async catalog() {
      const rows = await request('rpc/amazombie_catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!Array.isArray(rows)) throw new Error('Supabase returned an invalid catalog');
      return rows;
    },
    async placeOrder(items) {
      const order = await request('rpc/amazombie_place_demo_order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_items: items })
      });
      if (!order || typeof order.id !== 'string' || !Number.isInteger(order.totalCents)) {
        throw new Error('Supabase returned an invalid order confirmation');
      }
      return order;
    }
  };
}
