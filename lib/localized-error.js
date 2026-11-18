export class LocalizedError extends Error {
    localized;
    constructor(message, localized) {
        super(message);
        this.localized = localized;
    }
}
