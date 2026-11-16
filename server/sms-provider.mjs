const apiOrigin = 'https://api.telnyx.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  // Spaces, brackets, dashes and dots are formatting. A US number may be written with or without its leading 1.
  const compact = value.replace(/[ ().-]/g, '');
  const phone = /^[0-9]{10}$/.test(compact) ? `+1${compact}` : /^1[0-9]{10}$/.test(compact) ? `+${compact}` : compact;
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : null;
}

export function smsProvider({ apiKey, profileId, fetchImpl = fetch }) {
  if (!apiKey || !uuid.test(profileId || '')) throw new Error('SMS service is not configured.');
  const request = async (path, body) => {
    const response = await fetchImpl(`${apiOrigin}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'manual',
    });
    if (!response.ok || response.status >= 300) throw new Error('SMS service is temporarily unavailable.');
    const text = await response.text();
    if (text.length > 16000) throw new Error('SMS service returned an invalid response.');
    try { return JSON.parse(text).data; } catch { throw new Error('SMS service returned an invalid response.'); }
  };
  return {
    async send(phone) {
      const data = await request('/v2/verifications/sms', { phone_number: phone, verify_profile_id: profileId, timeout_secs: 300 });
      if (!uuid.test(data?.id || '') || data?.phone_number !== phone || data?.verify_profile_id !== profileId || data?.type !== 'sms') {
        throw new Error('SMS service returned an invalid response.');
      }
      return data.id;
    },
    async verify(id, phone, code) {
      if (!uuid.test(id || '') || !/^[0-9]{6}$/.test(code || '')) return false;
      // Never send `status: accepted` or a custom code: Telnyx must check the OTP.
      const data = await request(`/v2/verifications/${id}/actions/verify`, { code });
      return data?.response_code === 'accepted' && data?.phone_number === phone;
    },
  };
}
