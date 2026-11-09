/**
 * What the owner does on the Creative screen (/admin/creative): read the gallery, the briefs, the brand kits and the learnings; edit a
 * brand kit; add or remove the logo and product screenshots; start a brief; and preview or download a file. Every call runs inside the
 * owner's SMS session and the hub.* operations authorize it themselves (administrator for reads, command assurance for changes), so this
 * module adds no authority, only input checks and reviewed error messages. Approving, rejecting and asking for changes go through the AI
 * team's own decide route (/api/admin/team/decide), the same reviewed path every other proposal uses.
 */
import { HttpError, withSession } from '../../sms-auth.mjs';
import { reviewed } from '../admin.mjs';
import { availableFonts } from './brand.mjs';
import { offerCodes } from './offers.mjs';
import { platforms } from './specs.mjs';
import { themeSummaries } from './themes.mjs';

export const creativeAdminActions = new Set(['studio', 'brandKit', 'brandFile', 'removeBrandFile', 'brief']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const products = ['carebase', 'caremetric-intel'];
const statuses = ['draft', 'rendering', 'ready', 'proposed', 'approved', 'rejected', 'expired', 'live', 'retired', 'failed'];
const hex = /^#[0-9A-Fa-f]{6}$/;
const healthWords = /\b(diagnos[ei]s|conditions?|diseases?|medications?|patients?|symptoms?|disabilit(y|ies)|pregnanc(y|ies)|cancers?|diabetes|depression|hiv)\b/i;
const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function exactly(input, required, optional = []) {
  const keys = Object.keys(input ?? {});
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !keys.includes(key))) throw new HttpError(400, 'Invalid request.');
  return input;
}
const line = (value, max, label, { min = 1 } = {}) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || control.test(value)) throw new HttpError(400, `Enter ${label} of at most ${max} characters.`);
  return value.trim();
};
const list = (value, allowed, label, { min = 0, max = allowed.length } = {}) => {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => !allowed.includes(item)) || new Set(value).size !== value.length) throw new HttpError(400, `Choose ${label}.`);
  return value;
};

/** Which kind of image the bytes are, by their signature; null for anything else. */
export function imageKind(bytes) {
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export function creativeAdmin({ pool, kick = null, session = (token, work) => withSession(pool, token, work) }) {
  const query = (token, operation, args = []) => session(token, async db =>
    (await db.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result).catch(error => { throw reviewed(error); });
  const soon = () => { if (kick) setImmediate(() => { Promise.resolve(kick()).catch(() => {}); }); };

  return {
    /** The gallery, filtered by product, platform and status, with the briefs, the brand kits and the learnings. */
    async studio(token, input = {}) {
      exactly(input, [], ['product', 'platform', 'status', 'offset', 'limit']);
      const filter = {};
      if (input.product !== undefined && input.product !== null) filter.product = list([input.product], products, 'a product')[0];
      if (input.platform !== undefined && input.platform !== null) filter.platform = list([input.platform], platforms, 'a platform')[0];
      if (input.status !== undefined && input.status !== null) filter.status = list([input.status], statuses, 'a status')[0];
      for (const key of ['offset', 'limit']) {
        if (input[key] === undefined) continue;
        if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > (key === 'limit' ? 60 : 10000)) throw new HttpError(400, 'Invalid page.');
        filter[key] = input[key];
      }
      // Each product's brand theme comes with the gallery, so the brand kit editor shows what a blank field uses.
      return { ...(await query(token, 'hub.get_creative_studio', [JSON.stringify(filter)])), themes: themeSummaries() };
    },

    /** Edit one brand kit. Only the fields given change; a stale screen is refused. */
    async brandKit(token, input) {
      exactly(input, ['product', 'kit', 'expectedVersion']);
      const product = list([input.product], products, 'a product')[0];
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new HttpError(400, 'Invalid version.');
      const kit = input.kit;
      if (!kit || typeof kit !== 'object' || Array.isArray(kit)) throw new HttpError(400, 'Invalid brand kit.');
      const clean = {};
      for (const [key, value] of Object.entries(kit)) {
        if (['primaryColor', 'secondaryColor', 'accentColor', 'textColor', 'backgroundColor'].includes(key)) {
          if (value !== '' && !(typeof value === 'string' && hex.test(value))) throw new HttpError(400, 'Colors are written #RRGGBB.');
          clean[key] = value;
        } else if (['headingFont', 'bodyFont'].includes(key)) {
          if (value !== '' && !availableFonts.includes(value)) throw new HttpError(400, `Choose a font the Hub has: ${availableFonts.join(', ')}.`);
          clean[key] = value;
        } else if (key === 'voiceNotes') clean[key] = typeof value === 'string' && value.length <= 2000 && !control.test(value) ? value : (() => { throw new HttpError(400, 'Voice notes are at most 2,000 characters.'); })();
        else if (key === 'requiredDisclaimers' || key === 'bannedPhrases') {
          if (!Array.isArray(value) || value.length > (key === 'bannedPhrases' ? 100 : 10) || value.some(item => typeof item !== 'string' || item.length > 200 || /[\r\n]/.test(item) || control.test(item))) {
            throw new HttpError(400, 'Each phrase or disclaimer is one line of at most 200 characters.');
          }
          clean[key] = value.map(item => item.trim()).filter(Boolean);
        } else if (key === 'videoAvatarId' || key === 'videoVoiceId') {
          if (value !== '' && !(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value))) throw new HttpError(400, 'A HeyGen id is letters, digits, - and _.');
          clean[key] = value;
        } else if (key === 'captionsDefault') {
          if (typeof value !== 'boolean') throw new HttpError(400, 'Invalid captions setting.');
          clean[key] = value;
        } else throw new HttpError(400, 'Invalid brand kit field.');
      }
      return query(token, 'hub.set_brand_kit', [product, JSON.stringify(clean), input.expectedVersion]);
    },

    /** Add the logo (replacing the last one) or a screenshot, sent as base64. A screenshot needs the owner's attestation. */
    async brandFile(token, input) {
      exactly(input, ['product', 'kind', 'data', 'attested'], ['label']);
      const product = list([input.product], products, 'a product')[0];
      if (!['logo', 'screenshot'].includes(input.kind) || typeof input.data !== 'string' || typeof input.attested !== 'boolean') throw new HttpError(400, 'Invalid file.');
      if (input.kind === 'screenshot' && input.attested !== true) throw new HttpError(400, 'Confirm that the screenshot shows no patient, resident or personal information.');
      const bytes = Buffer.from(input.data, 'base64');
      const contentType = imageKind(bytes);
      if (!contentType || bytes.length > (input.kind === 'logo' ? 1048576 : 5242880)) throw new HttpError(400, 'A logo must be a PNG or JPEG of at most 1 MB, and a screenshot at most 5 MB.');
      const label = input.label === undefined ? '' : line(input.label, 120, 'a label', { min: 0 });
      return query(token, 'hub.add_brand_file', [product, input.kind, contentType, bytes, label, input.attested]);
    },

    async removeBrandFile(token, input) {
      exactly(input, ['id']);
      if (typeof input.id !== 'string' || !uuid.test(input.id)) throw new HttpError(400, 'Invalid file.');
      return query(token, 'hub.remove_brand_file', [input.id]);
    },

    /** The owner's own brief. The drafting task starts straight away; the same request key never makes a second brief. */
    async brief(token, input) {
      exactly(input, ['product', 'goal', 'audience', 'platforms', 'formats', 'requestKey'], ['offerCode', 'videoLengths', 'angle']);
      const brief = {
        product: list([input.product], products, 'a product')[0],
        goal: line(input.goal, 500, 'a goal'),
        audience: line(input.audience, 500, 'an audience'),
        platforms: list(input.platforms, platforms, 'at least one platform', { min: 1 }),
        formats: list(input.formats, ['static', 'video'], 'images, videos or both', { min: 1 }),
        videoLengths: input.videoLengths === undefined ? [] : list(input.videoLengths, ['6s', '15s', '30s', '45-60s'], 'video lengths'),
        angle: input.angle === undefined ? '' : line(input.angle, 500, 'an angle', { min: 0 }),
        offerCode: input.offerCode === undefined || input.offerCode === null || input.offerCode === '' ? null : list([input.offerCode], offerCodes, 'a live offer')[0],
      };
      if (healthWords.test(brief.audience)) throw new HttpError(400, 'Describe the audience as organizations and roles, never by a health condition.');
      if (brief.formats.includes('video') && !brief.videoLengths.length) brief.videoLengths = ['15s'];
      if (!brief.formats.includes('video')) brief.videoLengths = [];
      if (typeof input.requestKey !== 'string' || !uuid.test(input.requestKey)) throw new HttpError(400, 'Invalid request key.');
      const created = await query(token, 'hub.create_creative_brief', [JSON.stringify(brief), input.requestKey]);
      soon();
      return created;
    },

    /** One file to preview or download: `{ contentType, bytes, fileName }`. */
    async file(token, id) {
      if (typeof id !== 'string' || !uuid.test(id)) throw new HttpError(400, 'Invalid file.');
      const row = await session(token, async db => (await db.query('select content_type, bytes, file_name from hub.get_creative_file($1)', [id])).rows[0]).catch(error => { throw reviewed(error); });
      if (!row) throw new HttpError(404, 'File unavailable.');
      return { contentType: row.content_type, bytes: row.bytes, fileName: row.file_name };
    },
  };
}
