// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { EventEmitter } from 'events';
import axios, { AxiosRequestConfig } from 'axios';
import * as fs from 'fs';
import path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedProxy {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export interface CheckerStats {
  hits: number;
  taken: number;
  errors: number;
  deadProxies: number;
  activeProxies: number;
  bannedProxies: number;
  workersRunning: number;
}

export interface CheckerOptions {
  usernameLength?: number;   // 2–20, default 4
  concurrency?: number;      // default auto
  requestDelay?: number;     // ms, default 2000
  proxyRequestLimit?: number;
  proxyFailureThreshold?: number;
  rateLimitCooldown?: number;
}

type CheckerStoreData = {
  generatedUsernames: Record<string, true>;
  bannedProxies: Record<string, number>;
};

const USERNAME_CHECKER_USER_AGENT = 'Auto-Quest-Discord/1.0';
const MIN_REQUEST_DELAY_MS = 1500;
const DEFAULT_REQUEST_DELAY_MS = 2000;
const MAX_CONSECUTIVE_RATE_LIMITS = 3;

class CheckerStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = path.resolve(
      process.cwd(),
      'data',
      'username-checker-store.json',
    ),
  ) {}

  async tryMarkGeneratedUsername(username: string): Promise<boolean> {
    return this.withLock(async () => {
      const store = await this.read();
      if (store.generatedUsernames[username]) return false;

      store.generatedUsernames[username] = true;
      await this.write(store);
      return true;
    });
  }

  async getBannedProxyTimestamp(proxy: string): Promise<number | null> {
    return this.withLock(async () => {
      const store = await this.read();
      return store.bannedProxies[proxy] ?? null;
    });
  }

  async setBannedProxyTimestamp(proxy: string, timestamp: number): Promise<void> {
    await this.withLock(async () => {
      const store = await this.read();
      store.bannedProxies[proxy] = timestamp;
      await this.write(store);
    });
  }

  async deleteBannedProxyTimestamp(proxy: string): Promise<void> {
    await this.withLock(async () => {
      const store = await this.read();
      delete store.bannedProxies[proxy];
      await this.write(store);
    });
  }

  private async read(): Promise<CheckerStoreData> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CheckerStoreData>;
      return {
        generatedUsernames: parsed.generatedUsernames ?? {},
        bannedProxies: parsed.bannedProxies ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return this.emptyStore();
      throw error;
    }
  }

  private async write(store: CheckerStoreData): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
    await fs.promises.rename(tempPath, this.filePath);
  }

  private emptyStore(): CheckerStoreData {
    return {
      generatedUsernames: {},
      bannedProxies: {},
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// ─── Events emitted ───────────────────────────────────────────────────────────
//
//  'hit'          (username: string)
//  'taken'        (username: string)
//  'proxy:banned' (proxy: string)
//  'proxy:dead'   (proxy: string)
//  'proxy:restored' (count: number)
//  'error'        (ctx: { username: string; workerId: number; message: string })
//  'ratelimit'    (ctx: { username: string; workerId: number; proxy: string })
//  'stats'        (stats: CheckerStats)           — emitted every 5 s while running
//  'done'         ()
//  'stopped'      ()

// ─── Checker class ────────────────────────────────────────────────────────────

export class DiscordUsernameChecker extends EventEmitter {
  // config
  private readonly PROXY_REQUEST_LIMIT: number;
  private readonly PROXY_FAILURE_THRESHOLD: number;
  private readonly RATE_LIMIT_COOLDOWN: number;
  private readonly DIRECT_RATE_LIMIT_FALLBACK = 60_000;
  private readonly BATCH_SIZE = 50;

  // state
  private store = new CheckerStore();

  private proxies: string[] = [];
  private blockedUsernames = new Set<string>();

  private hitsBuffer: string[] = [];
  private takenBuffer: string[] = [];

  private proxyFailureCount = new Map<string, number>();
  private deadProxies = new Set<string>();

  private isRunning = false;
  private isShuttingDown = false;
  private consecutiveRateLimits = 0;

  // counters
  private stats: CheckerStats = {
    hits: 0,
    taken: 0,
    errors: 0,
    deadProxies: 0,
    activeProxies: 0,
    bannedProxies: 0,
    workersRunning: 0,
  };

  private statsInterval?: NodeJS.Timeout;

  constructor(opts: CheckerOptions = {}) {
    super();
    this.PROXY_REQUEST_LIMIT     = opts.proxyRequestLimit      ?? 20;
    this.PROXY_FAILURE_THRESHOLD = opts.proxyFailureThreshold  ?? 3;
    this.RATE_LIMIT_COOLDOWN     = opts.rateLimitCooldown       ?? 3_600_000;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Load proxies, blocked usernames and start checking. */
  async start(opts: CheckerOptions = {}): Promise<void> {
    if (this.isRunning) throw new Error('Checker is already running.');
    this.resetRunState();
    this.isRunning = true;
    this.isShuttingDown = false;

    this.ensureFiles();
    this.loadBlockedUsernames();

    const useDirectMode = true;

    const usernameLength = Math.max(2, Math.min(opts.usernameLength ?? 4, 20));
    const defaultConcurrency = 1;
    const maxConcurrency = 1;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? defaultConcurrency, maxConcurrency));
    const requestDelay = Math.max(MIN_REQUEST_DELAY_MS, opts.requestDelay ?? DEFAULT_REQUEST_DELAY_MS);

    this.stats.activeProxies = 0;
    if (useDirectMode) {
      this.emit('stats', { ...this.stats });
    }
    this.statsInterval = setInterval(() => this.emit('stats', { ...this.stats }), 5_000);

    let workerId = 1;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      this.stats.workersRunning++;
      workers.push(this.runWorker(workerId++, usernameLength, requestDelay, useDirectMode));
    }

    try {
      await Promise.all(workers);
      await this.flushBuffers();
      this.emit(this.isShuttingDown ? 'stopped' : 'done');
    } finally {
      if (this.statsInterval) clearInterval(this.statsInterval);
      this.statsInterval = undefined;
      this.stats.workersRunning = 0;
      this.isRunning = false;
    }
  }

  /** Gracefully stop all workers. */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    await this.flushBuffers();
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = undefined;
  }

  /** Current snapshot of counters. */
  getStats(): CheckerStats {
    return { ...this.stats };
  }

  // ─── Worker loop ────────────────────────────────────────────────────────────

  private async runWorker(id: number, usernameLength: number, delay: number, useDirectMode: boolean): Promise<void> {
    while (!this.isShuttingDown) {
      if (!useDirectMode && this.proxies.length === 0) {
        this.isShuttingDown = true;
        break;
      }

      const username = await this.generateUsername(usernameLength);
      if (!username) break;

      const { proxyConfig, proxyString } = this.pickProxy();

      if (!useDirectMode && !proxyConfig && this.proxies.length > 0) {
        this.isShuttingDown = true;
        break;
      }

      await this.checkUsername(username, id, proxyConfig, proxyString);

      if (delay > 0) {
        await this.pause(delay);
      }
    }
    this.stats.workersRunning = Math.max(0, this.stats.workersRunning - 1);
  }

  // ─── Core check ─────────────────────────────────────────────────────────────

  private async checkUsername(
    username: string,
    workerId: number,
    proxy: ParsedProxy | null,
    proxyString: string | null,
    retryCount = 0,
  ): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.blockedUsernames.has(username)) return;

    const proxyKey = proxyString ?? 'direct';

    try {
      const requestConfig: AxiosRequestConfig = {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USERNAME_CHECKER_USER_AGENT,
        },
        timeout: 10_000,
      };

      if (proxy?.host && proxy?.port) {
        requestConfig.proxy = {
          protocol: 'http',
          host: proxy.host,
          port: proxy.port,
          ...(proxy.username && proxy.password
            ? { auth: { username: proxy.username, password: proxy.password } }
            : {}),
        };
      }

      const response = await axios.post(
        'https://discord.com/api/v9/unique-username/username-attempt-unauthed',
        { username },
        requestConfig,
      );

      this.consecutiveRateLimits = 0;
      proxyKey !== 'direct' && this.proxyFailureCount.delete(proxyKey);

      if (response.data.taken) {
        this.stats.taken++;
        await this.addToBuffer(this.takenBuffer, username);
        this.emit('taken', username);
      } else {
        this.stats.hits++;
        await this.addToBuffer(this.hitsBuffer, username);
        this.emit('hit', username);
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        this.emit('ratelimit', { username, workerId, proxy: proxyString ?? 'direct' });
        if (!proxyString) {
          this.consecutiveRateLimits++;
          const delayMs = this.getRateLimitDelayMs(error);
          if (this.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
            this.isShuttingDown = true;
            this.stats.errors++;
            this.emit('error', {
              username,
              workerId,
              message: `Discord rate limited direct requests ${this.consecutiveRateLimits} times in a row. Stopping to avoid hammering the API.`,
            });
            return;
          }
          this.emit('error', {
            username,
            workerId,
            message: `Direct requests were rate limited. Waiting ${Math.ceil(delayMs / 1000)}s before continuing.`,
          });
          await this.pause(delayMs);
          if (!this.isShuttingDown) {
            return this.checkUsername(username, workerId, proxy, proxyString, retryCount);
          }
          return;
        }
        this.stats.bannedProxies++;
        if (proxyString) {
          await this.banProxy(proxyString);
          const idx = this.proxies.indexOf(proxyString);
          if (idx > -1) this.proxies.splice(idx, 1);
          this.stats.activeProxies = this.proxies.length;
        }
        return;
      }

      if (proxy) {
        const failures = (this.proxyFailureCount.get(proxyKey) ?? 0) + 1;
        this.proxyFailureCount.set(proxyKey, failures);
        if (failures >= this.PROXY_FAILURE_THRESHOLD) {
          this.deadProxies.add(proxyKey);
          this.stats.deadProxies++;
          this.emit('proxy:dead', proxyKey);
        }
      }

      const networkError =
        !error.response &&
        ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code);

      if (networkError && retryCount < 3) {
        await this.pause(1_000 * (retryCount + 1));
        return this.checkUsername(username, workerId, proxy, proxyString, retryCount + 1);
      }

      this.stats.errors++;
      this.emit('error', { username, workerId, message: error.message });
    }
  }

  // ─── Proxy helpers ───────────────────────────────────────────────────────────

  private getRateLimitDelayMs(error: any): number {
    const retryAfter = error.response?.data?.retry_after;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      return Math.max(1_000, Math.ceil(retryAfter * 1000) + 500);
    }

    const header = error.response?.headers?.['retry-after'];
    const retryAfterHeader = Array.isArray(header) ? header[0] : header;
    const parsedRetryAfterHeader = Number(retryAfterHeader);
    if (
      Number.isFinite(parsedRetryAfterHeader) &&
      parsedRetryAfterHeader > 0
    ) {
      return Math.ceil(parsedRetryAfterHeader * 1000) + 500;
    }

    return this.DIRECT_RATE_LIMIT_FALLBACK;
  }

  private async pause(ms: number): Promise<void> {
    const endAt = Date.now() + ms;
    while (!this.isShuttingDown && Date.now() < endAt) {
      await new Promise(r => setTimeout(r, Math.min(1000, endAt - Date.now())));
    }
  }

  private resetRunState(): void {
    this.proxies = [];
    this.blockedUsernames.clear();
    this.hitsBuffer.length = 0;
    this.takenBuffer.length = 0;
    this.proxyFailureCount.clear();
    this.deadProxies.clear();
    this.consecutiveRateLimits = 0;
    this.stats = {
      hits: 0,
      taken: 0,
      errors: 0,
      deadProxies: 0,
      activeProxies: 0,
      bannedProxies: 0,
      workersRunning: 0,
    };
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = undefined;
  }

  private pickProxy(): { proxyConfig: ParsedProxy | null; proxyString: string | null } {
    let proxyConfig: ParsedProxy | null = null;
    let proxyString: string | null = null;
    let attempts = 0;

    while (attempts < this.proxies.length && !proxyConfig) {
      const idx = Math.floor(Math.random() * this.proxies.length);
      const candidate = this.proxies[idx];
      if (this.deadProxies.has(candidate)) { attempts++; continue; }
      proxyString = candidate;
      proxyConfig = this.parseProxy(candidate);
      attempts++;
    }
    return { proxyConfig, proxyString };
  }

  private parseProxy(raw: string): ParsedProxy | null {
    const parts = raw.trim().split(':');
    if (parts.length === 2) {
      const port = parseInt(parts[1], 10);
      if (!port || port < 1 || port > 65535 || !parts[0]) return null;
      return { host: parts[0], port, username: null, password: null };
    }
    if (parts.length === 4) {
      const port = parseInt(parts[1], 10);
      if (!port || port < 1 || port > 65535 || !parts[0]) return null;
      return { host: parts[0], port, username: parts[2], password: parts[3] };
    }
    return null;
  }

  private readDataLines(filename: string): string[] {
    const content = fs.readFileSync(filename, 'utf-8').trim();
    if (!content) return [];

    return content
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  }

  private async banProxy(proxyString: string): Promise<void> {
    try {
      const bannedLines = this.readDataLines('banned.txt');

      if (!bannedLines.includes(proxyString)) {
        await fs.promises.appendFile('banned.txt', proxyString + '\n');
      }
      await this.store.setBannedProxyTimestamp(proxyString, Date.now());

      // Remove from proxies.txt
      const proxyLines = this.readDataLines('proxies.txt');
      if (proxyLines.length > 0) {
        const updated = proxyLines.filter(p => p !== proxyString);
        fs.writeFileSync('proxies.txt', updated.join('\n') + '\n');
      }

      const idx = this.proxies.indexOf(proxyString);
      if (idx > -1) this.proxies.splice(idx, 1);

      this.emit('proxy:banned', proxyString);
    } catch (err: any) {
      this.emit('error', { username: '', workerId: 0, message: `banProxy: ${err.message}` });
    }
  }

  private async restoreBannedProxies(): Promise<void> {
    try {
      const banned = this.readDataLines('banned.txt');
      if (banned.length === 0) return;

      const now = Date.now();
      const toRestore: string[] = [];
      const stillBanned: string[] = [];

      for (const proxy of banned) {
        const ts = await this.store.getBannedProxyTimestamp(proxy);
        if (ts && now - ts >= this.RATE_LIMIT_COOLDOWN) {
          toRestore.push(proxy);
          await this.store.deleteBannedProxyTimestamp(proxy);
        } else {
          stillBanned.push(proxy);
        }
      }

      if (toRestore.length > 0) {
        await fs.promises.appendFile('proxies.txt', toRestore.join('\n') + '\n');
        this.proxies.push(...toRestore);
        this.emit('proxy:restored', toRestore.length);
      }

      fs.writeFileSync('banned.txt', stillBanned.length ? stillBanned.join('\n') + '\n' : '');
    } catch (err: any) {
      this.emit('error', { username: '', workerId: 0, message: `restoreBannedProxies: ${err.message}` });
    }
  }

  // ─── Username generation ─────────────────────────────────────────────────────

  private async generateUsername(length: number): Promise<string | null> {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789._';
    let username = '';
    let attempts = 0;

    do {
      username = Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      if (++attempts >= 1000) return null;
      if (this.blockedUsernames.has(username)) continue;
      if (await this.store.tryMarkGeneratedUsername(username)) return username;
    } while (attempts < 1000);

    return null;
  }

  // ─── Buffer / file helpers ───────────────────────────────────────────────────

  private async addToBuffer(buffer: string[], data: string): Promise<void> {
    buffer.push(data);
    if (buffer.length >= this.BATCH_SIZE) await this.flushBuffers();
  }

  private async flushBuffers(): Promise<void> {
    if (this.hitsBuffer.length > 0) {
      await fs.promises.appendFile('hits.txt', this.hitsBuffer.join('\n') + '\n');
      this.hitsBuffer.length = 0;
    }
    if (this.takenBuffer.length > 0) {
      await fs.promises.appendFile('taken.txt', this.takenBuffer.join('\n') + '\n');
      this.takenBuffer.length = 0;
    }
  }

  private loadProxies(): void {
    try {
      const all = this.readDataLines('proxies.txt');
      if (all.length === 0) return;

      let banned: string[] = [];

      if (this.fileExists('banned.txt')) {
        banned = this.readDataLines('banned.txt');
      }

      const valid = all.filter(p => !banned.includes(p));
      const removed = all.filter(p => banned.includes(p));

      this.proxies = valid;

      if (removed.length > 0) {
        fs.writeFileSync('proxies.txt', valid.join('\n') + '\n');
      }

      this.stats.activeProxies = this.proxies.length;
    } catch {
      // proxies.txt unreadable — proxies stays empty
    }
  }

  private loadBlockedUsernames(): void {
    if (!this.fileExists('taken.txt')) return;
    const lines = this.readDataLines('taken.txt');
    lines.forEach(u => this.blockedUsernames.add(u));
  }

  private ensureFiles(): void {
    for (const file of ['proxies.txt', 'hits.txt', 'taken.txt', 'banned.txt']) {
      if (!this.fileExists(file)) {
        try { fs.writeFileSync(file, ''); } catch { /* ignore */ }
      }
    }
  }

  private fileExists(filename: string): boolean {
    try { fs.accessSync(filename, fs.constants.F_OK); return true; }
    catch { return false; }
  }
}
