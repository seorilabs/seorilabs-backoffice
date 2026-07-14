export const RELEASE_NOTE_LOCALES = [
  {
    field: "koKR",
    promptKey: "ko_KR",
    storeLocale: "ko-KR",
    label: "한국어",
    heading: "🇰🇷 이번 업데이트",
    fallback: "- 버그 수정 및 안정성 개선",
  },
  {
    field: "enUS",
    promptKey: "en_US",
    storeLocale: "en-US",
    label: "English",
    heading: "🇺🇸 What's New",
    fallback: "- Bug fixes and stability improvements",
  },
  {
    field: "jaJP",
    promptKey: "ja_JP",
    storeLocale: "ja-JP",
    label: "日本語",
    heading: "🇯🇵 最新情報",
    fallback: "- 不具合の修正と安定性の向上",
  },
  {
    field: "zhCN",
    promptKey: "zh_CN",
    storeLocale: "zh-CN",
    label: "简体中文",
    heading: "🇨🇳 更新内容",
    fallback: "- 修复了问题并提升了稳定性",
  },
  {
    field: "zhTW",
    promptKey: "zh_TW",
    storeLocale: "zh-TW",
    label: "繁體中文",
    heading: "🇹🇼 更新內容",
    fallback: "- 修正問題並提升穩定性",
  },
  {
    field: "deDE",
    promptKey: "de_DE",
    storeLocale: "de-DE",
    label: "Deutsch",
    heading: "🇩🇪 Neuigkeiten",
    fallback: "- Fehlerbehebungen und Stabilitätsverbesserungen",
  },
  {
    field: "frFR",
    promptKey: "fr_FR",
    storeLocale: "fr-FR",
    label: "Français",
    heading: "🇫🇷 Nouveautés",
    fallback: "- Corrections de bugs et améliorations de la stabilité",
  },
  {
    field: "esES",
    promptKey: "es_ES",
    storeLocale: "es-ES",
    label: "Español",
    heading: "🇪🇸 Novedades",
    fallback: "- Corrección de errores y mejoras de estabilidad",
  },
] as const;

export type ReleaseNoteField = (typeof RELEASE_NOTE_LOCALES)[number]["field"];
export type ReleaseNotePromptKey = (typeof RELEASE_NOTE_LOCALES)[number]["promptKey"];
export type ReleaseNoteTranslations = Record<ReleaseNoteField, string>;
export type ReleaseNoteTranslationsInput = Partial<
  Record<ReleaseNoteField, string | null | undefined>
>;

export function releaseNoteTranslations(
  input: ReleaseNoteTranslationsInput = {},
): ReleaseNoteTranslations {
  return Object.fromEntries(
    RELEASE_NOTE_LOCALES.map(({ field }) => [field, input[field]?.trim() ?? ""]),
  ) as ReleaseNoteTranslations;
}
