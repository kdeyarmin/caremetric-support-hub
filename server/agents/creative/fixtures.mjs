/** Fixtures the Creative Director's tests share: a complete brand kit, copy for every layout and a synthetic screenshot (no real data). */
import { deflateSync } from 'node:zlib';

export const kit = { primaryColor: '#0B5394', backgroundColor: '#FFFFFF', textColor: '#111827', accentColor: '#C2410C', secondaryColor: '#1F2937', headingFont: 'Inter', bodyFont: 'Inter' };
export const content = {
  headline: 'See which counties send your organization the most referrals', primaryText: 'CareMetric Intel turns public data into a territory plan.', description: 'Targeted marketing.',
  cta: 'Start free trial', altText: 'A headline',
  overlay: { kicker: 'For healthcare marketing teams', stat: '14 days', statLabel: 'free trial', statSource: 'CareMetric fact sheet', quote: 'Spend the week with referral sources.', quoteSource: 'CareMetric',
    offerLine: '50% off your first 12 months', checklist: ['Territory analysis', 'A marketing CRM', 'Referrals in one place'], screenshotId: 's1', beats: ['Public healthcare data', 'One plan your team can work'] },
};

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };

/** An RGBA PNG drawn by `pixel(x, y)`, which returns [r, g, b, a]. */
export function pngOf(width, height, pixel) {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * row + 1 + x * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A small synthetic PNG (no real data), standing in for a screenshot the owner attested. */
export const syntheticPng = (width = 160, height = 100) => pngOf(width, height, () => [200, 200, 200, 255]);

// Synthetic logos (shapes, no real mark): a dark mark cut out on transparency, the same mark saved on white, and one on a gradient.
const inMark = (x, y, width, height) => x > width * 0.2 && x < width * 0.8 && y > height * 0.25 && y < height * 0.75;
export const cutOutLogo = (ink = [15, 23, 42]) => pngOf(64, 32, (x, y) => (inMark(x, y, 64, 32) ? [...ink, 255] : [0, 0, 0, 0]));
export const whiteBoxLogo = () => pngOf(64, 32, (x, y) => (inMark(x, y, 64, 32) ? [15, 23, 42, 255] : [255, 255, 255, 255]));
export const pictureLogo = () => pngOf(64, 32, (x, y) => (inMark(x, y, 64, 32) ? [15, 23, 42, 255] : [x * 4, 255 - y * 6, 128, 255]));
/** A 64x32 JPEG of a dark mark on white, as most uploaded logos are. */
export const whiteBoxJpeg = () => Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7Loor5G/4KMf8yJ/3EP8A22qoR5nYUnZXPrmivyMorf6v5mftPI/XOivyMoo+r+Ye08j9c6K+F/8Agn5/yWXV/wDsXpv/AEotq+6KxnHldi4u6uFfI3/BRj/mRP8AuIf+21fXNZHiPwv4Z8SeR/wkXh3SNZ+zbvI+32Udx5W7G7bvB252rnHXA9KUJcsrjkrqx+UdFfqL/wAKv+Gf/RO/CP8A4Jbf/wCIo/4Vf8M/+id+Ef8AwS2//wARXR9YXYz9mz8uqK/UX/hV/wAM/wDonfhH/wAEtv8A/EUf8Kv+Gf8A0Tvwj/4Jbf8A+Io+sLsHs2fIv/BPz/ksur/9i9N/6UW1fdFYXh/wb4Q8O3r3vh/wpoWkXTxmJ5rHT4oHZCQSpZFBIyoOOmQPSt2sKkuZ3LirKx//2Q==', 'base64');
