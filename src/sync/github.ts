// A tiny client for one private GitHub repository, used as the place books sync through.
// It talks to GitHub's REST API straight from the browser (GitHub allows that), with a
// fine-grained access token limited to that one repository's contents.

export interface SyncConfig { owner: string; repo: string; token: string }

export class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (text: string) => {
  const bytes = enc.encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64: string) => dec.decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export class GitHubStore {
  private cfg: SyncConfig;
  constructor(cfg: SyncConfig) { this.cfg = cfg; }

  private async req(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await fetch(`https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}${path}`, {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) {
      const msg = res.status === 401 ? 'GitHub did not accept the access token (it may have expired)'
        : res.status === 403 ? 'the access token is not allowed to write this repository’s contents'
        : `GitHub answered ${res.status}`;
      throw new SyncHttpError(res.status, msg);
    }
    return res;
  }

  /** Null when the repository is usable for syncing; otherwise why not. */
  async check(): Promise<string | null> {
    const res = await this.req('GET', '');
    if (res.status === 404) return `No repository “${this.cfg.owner}/${this.cfg.repo}” is visible to this token.`;
    const info = await res.json();
    if (!info.private) return 'That repository is public: anyone could read your books. Use a private one.';
    if (info.permissions && info.permissions.push === false) return 'The token can read but not write that repository. Give it “Contents: Read and write”.';
    return null;
  }

  async get(path: string): Promise<{ sha: string; text: string } | null> {
    const res = await this.req('GET', `/contents/${path}`);
    if (res.status === 404) return null;
    const j = await res.json();
    if (j.encoding === 'base64' && j.content) return { sha: j.sha, text: fromB64(j.content) };
    // Over 1 MB the contents API leaves the text out: fetch it raw.
    const raw = await this.req('GET', `/contents/${path}`, undefined, 'application/vnd.github.raw+json');
    return { sha: j.sha, text: await raw.text() };
  }

  async list(dir: string): Promise<string[]> {
    const res = await this.req('GET', `/contents/${dir}`);
    if (res.status === 404) return [];
    const j = await res.json();
    return Array.isArray(j) ? j.filter((e) => e.type === 'file').map((e) => e.name as string) : [];
  }

  /** Writes a file; `sha` is the version being replaced (none for a new file). Returns the new version. */
  async put(path: string, text: string, sha: string | undefined, message: string): Promise<string> {
    const res = await this.req('PUT', `/contents/${path}`, { message, content: toB64(text), ...(sha ? { sha } : {}) });
    if (res.status === 404) throw new SyncHttpError(404, `No repository “${this.cfg.owner}/${this.cfg.repo}”.`);
    return (await res.json()).content.sha;
  }

  async del(path: string, sha: string, message: string): Promise<void> {
    await this.req('DELETE', `/contents/${path}`, { message, sha });
  }
}

/** 409/422 on a write: someone else wrote the file first. */
export const isConflict = (e: unknown) => e instanceof SyncHttpError && (e.status === 409 || e.status === 422);
