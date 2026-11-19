import { readFileSync, readdirSync } from 'node:fs';
import { LocalizedError } from './localized-error.ts';

type Messages = Record<string, string>;

function readMessages(file: URL): Messages {
  const { messages } = JSON.parse(readFileSync(file, 'utf8')) as { messages: Messages };
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)
    || !Object.values(messages).every(message => typeof message === 'string')) {
    throw new LocalizedError('error.invalidLocaleDictionary', undefined, { fallback: 'Invalid Git Bash locale dictionary.' });
  }
  return messages;
}

export function readDictionaries(directory = new URL('../locale/', import.meta.url)): Record<string, Messages> {
  const dictionaries: Record<string, Messages> = { en: readMessages(new URL('en.json', directory)) };
  for (const file of readdirSync(directory)) {
    if (file === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file)) continue;
    try { dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(new URL(file, directory)); }
    catch { /* DSH uses English when an optional translation is unavailable. */ }
  }
  return dictionaries;
}
