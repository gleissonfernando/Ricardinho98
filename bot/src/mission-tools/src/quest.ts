// Credito: Perfil Discord https://discord.com/users/1411202571804348507
import type {
	Quest as QuestShape,
	QuestUserStatus,
} from './interface';

type QuestStatusUpdate =
	| QuestShape['user_status']
	| QuestShape
	| { user_status?: QuestShape['user_status']; quest?: QuestShape }
	| null
	| undefined;

export class Quest {
	private readonly data: QuestShape;

	private constructor(data: QuestShape) {
		this.data = data;
	}

	static create(data: QuestShape): Quest {
		return new Quest(data);
	}

	get id() {
		return this.data.id;
	}

	get config() {
		return this.data.config;
	}

	get userStatus(){
		return this.data.user_status;
	}

	get targetedContent() {
		return this.data.targeted_content;
	}

	get preview(): boolean {
		return this.data.preview;
	}

	isExpired(reference: Date = new Date()): boolean {
		return reference.getTime() > new Date(this.data.config.expires_at).getTime();
	}

	isCompleted(): boolean {
		return Boolean(this.userStatus?.completed_at);
	}

    isEnrolledQuest(): boolean {
        return Boolean(this.userStatus?.enrolled_at);
    }

	hasClaimedRewards(): boolean {
		return Boolean(this.userStatus?.claimed_at);
	}

	updateUserStatus(response: QuestStatusUpdate) {
		if (response == null) {
			this.data.user_status = null;
			return;
		}

		if ('quest' in response && response.quest?.user_status !== undefined) {
			this.data.user_status = response.quest.user_status;
			return;
		}

		if ('user_status' in response) {
			this.data.user_status = response.user_status ?? null;
			return;
		}

		if (
			'enrolled_at' in response ||
			'completed_at' in response ||
			'claimed_at' in response ||
			'progress' in response
		) {
			this.data.user_status = response as QuestUserStatus;
		}
	}
}
