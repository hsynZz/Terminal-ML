export const refreshCooldownMs = 15 * 60 * 1000;

export function canReuseRefresh(asOf: string, nowMs = Date.now()) {
  const age = nowMs - Date.parse(asOf);
  return Number.isFinite(age) && age >= 0 && age < refreshCooldownMs;
}

export function berlinRefreshParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(value);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "0";
  return { day: `${part("year")}-${part("month")}-${part("day")}`,
    afterCutoff: Number(part("hour")) * 60 + Number(part("minute")) >= 17 * 60 + 15 };
}
