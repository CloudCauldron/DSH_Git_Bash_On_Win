import { readFileSync, readdirSync } from 'node:fs';
import { LocalizedError } from './localized-error.js';
function readMessages(file) {
    const { messages } = JSON.parse(readFileSync(file, 'utf8'));
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)
        || !Object.values(messages).every(message => typeof message === 'string')) {
        throw new LocalizedError('error.invalidLocaleDictionary', undefined, { fallback: 'Invalid Git Bash locale dictionary.' });
    }
    return messages;
}
export function readDictionaries(directory = new URL('../locale/', import.meta.url)) {
    const dictionaries = { en: readMessages(new URL('en.json', directory)) };
    let files;
    try {
        files = readdirSync(directory);
    }
    catch {
        return dictionaries;
    } // A known en.json may be readable without directory-list permission.
    for (const file of files) {
        if (file.toLowerCase() === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file))
            continue;
        try {
            dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(new URL(file, directory));
        }
        catch { /* DSH uses English when an optional translation is unavailable. */ }
    }
    return dictionaries;
}
