/** Fixtures the Creative Director's tests share: a complete brand kit, copy for every layout and a synthetic screenshot (no real data). */
import { deflateSync } from 'node:zlib';

export const kit = { primaryColor: '#0B5394', backgroundColor: '#FFFFFF', textColor: '#111827', accentColor: '#C2410C', secondaryColor: '#1F2937', headingFont: 'Inter', bodyFont: 'Inter' };
export const content = {
  headline: 'See which counties send your agency the most referrals', primaryText: 'CareMetric Intel turns public data into a territory plan.', description: 'Targeted marketing.',
  cta: 'Start free trial', altText: 'A headline',
  overlay: { kicker: 'For home health and hospice', stat: '14 days', statLabel: 'free trial', statSource: 'CareMetric fact sheet', quote: 'Spend the week with referral sources.', quoteSource: 'CareMetric',
    offerLine: '50% off your first 12 months', checklist: ['Territory analysis', 'A marketing CRM', 'Referrals in one place'], screenshotId: 's1', beats: ['Public healthcare data', 'One plan your team can work'] },
};

/** A small synthetic PNG (no real data), standing in for a screenshot the owner attested. */
export function syntheticPng(width = 160, height = 100) {
  const raw = Buffer.alloc((width * 3 + 1) * height, 200);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
