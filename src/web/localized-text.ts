/** Text authored either as a literal or as locale-keyed translations. */
export type LocalizedText = string | Readonly<Record<string, string>>;

function available(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function exact(
  entries: ReadonlyArray<readonly [string, string]>,
  locale: string | undefined,
): string | undefined {
  if (locale === undefined || locale === "") return undefined;
  const normalized = locale.toLowerCase();
  return entries.find(([key, text]) =>
    key.toLowerCase() === normalized && available(text)
  )?.[1];
}

/**
 * Resolves authored text without modifying the selected translation.
 *
 * Selection prefers an exact locale (case-insensitively), then another entry
 * with the same primary language, then the exact fallback locale, and finally
 * the first non-blank translation.
 */
export function resolveLocalizedText(
  value: LocalizedText | null | undefined,
  locale?: string,
  fallbackLocale = "en-US",
): string {
  if (typeof value === "string") return available(value) ? value : "";
  if (value === null || value === undefined) return "";

  const entries = Object.entries(value);
  const exactLocale = exact(entries, locale);
  if (exactLocale !== undefined) return exactLocale;

  const primaryLanguage = locale?.split("-")[0]?.toLowerCase();
  if (primaryLanguage !== undefined && primaryLanguage !== "") {
    const sameLanguage = entries.find(([key, text]) =>
      key.split("-")[0]?.toLowerCase() === primaryLanguage && available(text)
    )?.[1];
    if (sameLanguage !== undefined) return sameLanguage;
  }

  return exact(entries, fallbackLocale)
    ?? entries.find(([, text]) => available(text))?.[1]
    ?? "";
}
