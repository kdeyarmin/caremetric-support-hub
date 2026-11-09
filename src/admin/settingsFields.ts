import type { HubSetting, SettingValue } from "./settingsClient";

/** The text a field shows for a value. Amounts in cents are shown in dollars, lists one per line. */
export function fieldText(setting: HubSetting, value: SettingValue): string {
  if (value === null) return "";
  if (setting.input === "cents" && typeof value === "number") return (value / 100).toFixed(2).replace(/\.00$/, "");
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}

/** The value a field's text stands for: null when empty (the default applies), undefined when it cannot be one. */
export function fieldValue(setting: HubSetting, text: string): SettingValue | undefined {
  if (setting.input === "lines") {
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    return lines.length ? lines : null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (setting.input === "number") {
    const number = Number(trimmed);
    return Number.isInteger(number) && (setting.min === undefined || number >= setting.min) && (setting.max === undefined || number <= setting.max) ? number : undefined;
  }
  if (setting.input === "cents") {
    const dollars = Number(trimmed.replace(/^\$/, "").replaceAll(",", ""));
    return Number.isFinite(dollars) && dollars > 0 && dollars <= 100_000 ? Math.round(dollars * 100) : undefined;
  }
  return trimmed;
}
