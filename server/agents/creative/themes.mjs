/**
 * Each product's brand theme, the ground every piece of creative is drawn on. The colors are the ones the product's own app uses, read from
 * the same constants the Hub's emails are themed with (server/email-layout.mjs, which mirrors each app's code), so an ad, a video and an
 * email from one product look like one brand:
 *
 * - CareMetric Intel: **Emberline** (kdeyarmin/intel src/lib/branding.ts): a near-black canvas, dark cards, the ember accent, Geist type,
 *   white pill buttons, the reverse CareMetric logo, the fire band and the tagline "Set your marketing on FIRE!".
 * - CareMetric CareBase (kdeyarmin/PennTrain): white, the CareBase logo lockup over a brand-blue rule, the app's blue (#2563EB) for buttons
 *   and accents, and the shared CareMetric neutrals.
 *
 * The owner's brand kit (Creative screen) overrides a theme field by field: a blank field uses the theme. Every color an asset may use is the
 * theme's or the kit's (`effectiveKit(...).allowed`), and compliance.mjs blocks any other. Where a color would fail WCAG AA contrast, the
 * replacement is the theme's own darkest or lightest color, never an outside one. The logos and the fire band are bundled in brand-assets/.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CAREBASE_SITE, emailThemes, INTEL_SITE, INTEL_TAGLINE } from '../../email-layout.mjs';
import { contrastRatio, isColor, luminance } from './brand.mjs';

const assetPath = name => fileURLToPath(new URL(`./brand-assets/${name}`, import.meta.url));
const deepFreeze = value => { if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); };
// Colors are kept uppercase (#RRGGBB) so a color compares equal wherever it is used.
const upper = colors => Object.fromEntries(Object.entries(colors).map(([role, color]) => [role, color.toUpperCase()]));
const intel = { palette: upper(emailThemes.intel.palette), callouts: { info: upper(emailThemes.intel.callouts.info) } };
const carebase = { palette: upper(emailThemes.carebase.palette), callouts: { info: upper(emailThemes.carebase.callouts.info) } };

export const brandThemes = deepFreeze({
  'caremetric-intel': {
    product: 'caremetric-intel', key: 'emberline', name: 'Emberline', mode: 'dark', site: 'caremetricintel.com',
    source: 'kdeyarmin/intel src/lib/branding.ts (CAREMETRIC_COLORS), as server/email-layout.mjs carries it',
    colors: { primary: intel.palette.brand, primaryDark: intel.palette.brandDark, onPrimary: intel.palette.onBrand, text: intel.palette.heading, body: intel.palette.body,
      muted: intel.palette.muted, background: intel.palette.canvas, surface: intel.palette.card, panel: intel.palette.panel, hairline: intel.palette.hairline },
    // The offer card is Emberline's own callout; the button is the app's white pill.
    callout: { fill: intel.callouts.info.fill, border: intel.callouts.info.border, accent: intel.callouts.info.accent, text: intel.callouts.info.text },
    button: { fill: 'text', text: 'background', pill: true },
    font: 'Geist', tagline: INTEL_TAGLINE, cardRadius: 22 / 600,
    // The reverse lockup (the mark over "CareMetric Intel"), white on transparent: for a dark canvas only.
    logo: { file: assetPath('caremetric-intel-logo-reverse.png'), width: 228, height: 190, needs: 'dark', source: `${INTEL_SITE}/brand/caremetric-logo-reverse.png` },
    band: { file: assetPath('emberline-fire.png'), width: 1200, height: 200, source: `${INTEL_SITE}/brand/emberline-fire.png` },
    rule: null,
  },
  carebase: {
    product: 'carebase', key: 'carebase', name: 'CareBase', mode: 'light', site: 'cmcarebase.com',
    source: 'kdeyarmin/PennTrain supabase/functions/_shared/emailLayout.ts (EMAIL_COLORS), as server/email-layout.mjs carries it',
    colors: { primary: carebase.palette.brand, primaryDark: carebase.palette.brandDark, onPrimary: carebase.palette.onBrand, text: carebase.palette.heading, body: carebase.palette.body,
      muted: carebase.palette.muted, background: carebase.palette.card, surface: carebase.palette.panel, panel: carebase.palette.canvas, hairline: carebase.palette.hairline },
    callout: { fill: carebase.callouts.info.fill, border: carebase.callouts.info.border, accent: carebase.callouts.info.accent, text: carebase.callouts.info.text },
    button: { fill: 'primary', text: 'onPrimary', pill: false },
    font: 'Inter', tagline: null, cardRadius: 12 / 600,
    // The full-color lockup on an opaque white ground: for a white canvas only.
    logo: { file: assetPath('carebase-lockup.png'), width: 480, height: 121, needs: 'white', source: `${CAREBASE_SITE}/brand/email-lockup-carebase.png` },
    band: null,
    // The app's header: the logo lockup over a 3px brand-blue rule (at the email's 600px width).
    rule: { role: 'primary', share: 3 / 600 },
  },
});

export const themeFor = product => brandThemes[product] ?? null;

/** Every color a theme defines, uppercase. */
export function themeColors(theme) {
  return [...new Set([...Object.values(theme.colors), ...Object.values(theme.callout)].map(color => color.toUpperCase()))];
}

const kitFields = { primaryColor: 'primary', backgroundColor: 'background', textColor: 'text', accentColor: 'accent', secondaryColor: 'surface' };

/**
 * The brand a product's creative is drawn in: its theme with the owner's kit on top. Returns the theme, the colors by role, the fonts, which
 * logo to use, the neutrals a contrast fix may use (`ink`, the theme's darkest color, and `paper`, its lightest) and every color an asset
 * may use (`allowed`).
 */
export function effectiveKit(product, kit = {}) {
  const theme = themeFor(product);
  if (!theme) throw Object.assign(new Error('There is no brand theme for this product.'), { code: 'theme_missing' });
  const own = Object.fromEntries(Object.entries(kitFields).filter(([field]) => isColor(kit?.[field])).map(([field, role]) => [role, kit[field].toUpperCase()]));
  const all = themeColors(theme);
  const ink = [...all].sort((a, b) => luminance(a) - luminance(b))[0];
  const paper = [...all].sort((a, b) => luminance(b) - luminance(a))[0];
  const colors = { ...theme.colors, accent: theme.colors.primary, ...own };
  // A kit that changes the brand color keeps a readable color on it, from the theme's own neutrals.
  if (own.primary) colors.onPrimary = contrastRatio(ink, own.primary) >= contrastRatio(paper, own.primary) ? ink : paper;
  const button = { fill: colors[theme.button.fill], text: colors[theme.button.text], pill: theme.button.pill };
  const allowed = new Set([...all, ...Object.values(own).map(color => color.toUpperCase()), ink, paper]);
  return { theme, colors, button, callout: theme.callout, ink, paper, allowed, headingFont: kit?.headingFont || theme.font, bodyFont: kit?.bodyFont || theme.font, overrides: Object.keys(own) };
}

const cache = new Map();
/** A bundled brand file's bytes, read once. */
export async function themeAsset(file) {
  if (!cache.has(file)) cache.set(file, readFile(file).catch(error => { cache.delete(file); throw error; }));
  return cache.get(file);
}

/**
 * The theme's own files for a render: its logo (unless the owner uploaded one, which the caller passes as `files.logo`) and its band, as
 * `{ themeLogo, band }` beside the files given. A file that cannot be read is left out (the product name is drawn instead of the logo).
 */
export async function withThemeFiles(product, files = {}) {
  const theme = themeFor(product);
  if (!theme) return files;
  const out = { ...files };
  try { if (!files.themeLogo) out.themeLogo = { bytes: await themeAsset(theme.logo.file), type: 'image/png', needs: theme.logo.needs }; } catch { /* the wordmark is drawn */ }
  try { if (theme.band && !files.band) out.band = { bytes: await themeAsset(theme.band.file), type: 'image/png' }; } catch { /* no band */ }
  return out;
}

/** What the Creative screen shows about each theme: its name, mode, tagline, colors by role and where it comes from. */
export function themeSummaries() {
  return Object.values(brandThemes).map(theme => ({ product: theme.product, name: theme.name, mode: theme.mode, tagline: theme.tagline, font: theme.font, source: theme.source,
    colors: { primaryColor: theme.colors.primary, secondaryColor: theme.colors.surface, accentColor: theme.colors.primary, textColor: theme.colors.text, backgroundColor: theme.colors.background } }));
}
