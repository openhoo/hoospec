/** Private, per-tab working copy. OAuth and agent credentials never enter this store. */
export interface RepositoryDraftStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
export class MemoryDraftStore implements RepositoryDraftStore {
  private value: unknown;
  async read() { return structuredClone(this.value); }
  async write(value: unknown) { this.value = structuredClone(value); }
}
export class BrowserDraftStore implements RepositoryDraftStore {
  constructor(private readonly scope: string) {}
  private async transaction(mode: IDBTransactionMode, value?: unknown): Promise<unknown> {
    let key: string;
    try {
      const sessionKey = 'hoospec-draft-session:' + this.scope;
      let id = sessionStorage.getItem(sessionKey);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(sessionKey, id); }
      key = this.scope + ':' + id;
    } catch { throw new Error('Der Browser erlaubt keine lokale Entwurfssicherung. Bitte Browser-Speicher für dieses Studio freigeben.'); }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hoospec-drafts', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('drafts'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Die lokale Entwurfssicherung ist nicht verfügbar.'));
      request.onblocked = () => reject(new Error('Die lokale Entwurfssicherung wird von einem anderen Studio blockiert. Bitte dieses Studio neu laden.'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('drafts', mode);
        const request = mode === 'readonly' ? transaction.objectStore('drafts').get(key) : transaction.objectStore('drafts').put(value, key);
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(new Error('Der lokale Entwurf konnte nicht gesichert werden. Bitte verfügbaren Browser-Speicher prüfen. Deine Eingabe bleibt im Editor.'));
        transaction.onerror = () => { /* onabort reports the failed transaction. */ };
      });
    } finally { database.close(); }
  }
  read() { return this.transaction('readonly'); }
  async write(value: unknown) { await this.transaction('readwrite', value); }
}
