export const languageStorageKey = 'noknok.website.language';

export function resolveLanguage({ storedLanguage, languages, language } = {}) {
  if (storedLanguage === 'zh' || storedLanguage === 'en') return storedLanguage;
  const preferred = Array.isArray(languages) && languages[0]
    ? languages[0]
    : language;
  return typeof preferred === 'string' && /^zh(?:-|$)/i.test(preferred) ? 'zh' : 'en';
}

export function readLanguage(storage, navigatorLike = {}) {
  let storedLanguage;
  try {
    storedLanguage = storage?.getItem(languageStorageKey);
  } catch {
    // Browser privacy settings can deny access to storage.
  }
  return resolveLanguage({
    storedLanguage,
    languages: navigatorLike?.languages,
    language: navigatorLike?.language,
  });
}

export function saveLanguage(storage, language) {
  if (language !== 'zh' && language !== 'en') return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(languageStorageKey, language);
    return true;
  } catch {
    return false;
  }
}
