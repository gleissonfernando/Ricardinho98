// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
	scryptSync,
} from 'node:crypto';

type StoredTokenRecord = {
	iv: string;
	tag: string;
	value: string;
	updatedAt: string;
};

type StoredTokenFile = {
	version: 1;
	users: Record<string, StoredTokenRecord>;
};

const DEFAULT_STORE_PATH = path.join('data', 'mission-tokens.json');
const STORE_VERSION = 1;

export class TokenStore {
	private readonly filePath: string;
	private readonly key: Buffer;
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(options?: { filePath?: string; secret?: string }) {
		this.filePath = path.resolve(
			process.cwd(),
			options?.filePath ?? process.env.TOKEN_STORE_PATH ?? DEFAULT_STORE_PATH,
		);
		const secret =
			options?.secret ??
			process.env.TOKEN_STORE_SECRET ??
			process.env.BOT_TOKEN ??
			'local-development-token-store-secret';
		this.key = scryptSync(secret, 'mission-token-store', 32);
	}

	async has(userId: string): Promise<boolean> {
		return this.withLock(async () => {
			const store = await this.read();
			const record = store.users[userId];
			return Boolean(record && this.tryDecrypt(record));
		});
	}

	async get(userId: string): Promise<string | null> {
		return this.withLock(async () => {
			const store = await this.read();
			const record = store.users[userId];
			if (!record) return null;

			return this.tryDecrypt(record);
		});
	}

	async set(userId: string, token: string): Promise<void> {
		await this.withLock(async () => {
			const store = await this.read();
			store.users[userId] = {
				...this.encrypt(token),
				updatedAt: new Date().toISOString(),
			};
			await this.write(store);
		});
	}

	async delete(userId: string): Promise<void> {
		await this.withLock(async () => {
			const store = await this.read();
			delete store.users[userId];
			await this.write(store);
		});
	}

	private async read(): Promise<StoredTokenFile> {
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as StoredTokenFile;
			if (parsed.version !== STORE_VERSION || !parsed.users) {
				return this.emptyStore();
			}
			return parsed;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return this.emptyStore();
			if (error instanceof SyntaxError) {
				await this.backupCorruptFile();
				return this.emptyStore();
			}
			throw error;
		}
	}

	private async write(store: StoredTokenFile): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		await fs.writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
		await fs.rename(tempPath, this.filePath);
	}

	private emptyStore(): StoredTokenFile {
		return {
			version: STORE_VERSION,
			users: {},
		};
	}

	private async backupCorruptFile(): Promise<void> {
		const backupPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
		try {
			await fs.rename(this.filePath, backupPath);
			console.error(
				`Token store JSON was invalid. Backed it up to ${backupPath}.`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT') throw error;
		}
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

	private encrypt(value: string): Pick<StoredTokenRecord, 'iv' | 'tag' | 'value'> {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const encrypted = Buffer.concat([
			cipher.update(value, 'utf8'),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();

		return {
			iv: iv.toString('base64'),
			tag: tag.toString('base64'),
			value: encrypted.toString('base64'),
		};
	}

	private decrypt(record: StoredTokenRecord): string {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			this.key,
			Buffer.from(record.iv, 'base64'),
		);
		decipher.setAuthTag(Buffer.from(record.tag, 'base64'));

		return Buffer.concat([
			decipher.update(Buffer.from(record.value, 'base64')),
			decipher.final(),
		]).toString('utf8');
	}

	private tryDecrypt(record: StoredTokenRecord): string | null {
		try {
			return this.decrypt(record);
		} catch (error) {
			console.error(
				'Stored token could not be decrypted. Configure the token again.',
				error instanceof Error ? error.message : error,
			);
			return null;
		}
	}
}
